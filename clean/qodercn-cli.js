const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { AppError } = require('./errors');
const profiles = require('./profiles');
const { redactString } = require('./redact');
const { resolveModelRoute } = require('./models');
const { buildToolSystemPrompt, formatToolResultForPrompt } = require('./tool-parser');

const DEFAULT_TIMEOUT_MS = 300000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_INSTRUCTION =
  'Answer the attached OpenAI-compatible chat completion request. Return only the final assistant message content.';

/**
 * Resolve the CLI backend configuration.
 *
 * Supports two backends:
 *   - "cn"     → qoderclicn  (Qoder CN, auth in .qoderworkcn)
 *   - "global" → qodercli    (Qoder international, auth in .qoder)
 *
 * The backend is selected via CLI_BACKEND env var (default: "cn").
 * Individual fields can be overridden with CLI_COMMAND and CLI_TOKEN.
 */
function homeRoot(profile) {
  if (profile && profile.home) return profile.home;
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function getCliBackend(profile) {
  const backend = (process.env.CLI_BACKEND || 'cn').toLowerCase();
  const base = homeRoot(profile);

  if (backend === 'global') {
    return {
      name: 'global',
      command: process.env.CLI_COMMAND || 'qodercli',
      bundlePackage: '@qoder-ai/qodercli',
      bundlePath: path.join('bundle', 'qodercli.js'),
      homeDir: path.join(base, '.qoder'),
      tokenEnvVar: 'QODER_PAT',
    };
  }

  // Default: cn
  return {
    name: 'cn',
    command: process.env.CLI_COMMAND || 'qoderclicn',
    bundlePackage: '@qodercn-ai/qoderclicn',
    bundlePath: path.join('bundle', 'qoderclicn.js'),
    homeDir: path.join(base, '.qoderworkcn'),
    tokenEnvVar: 'QODERCN_PERSONAL_ACCESS_TOKEN',
  };
}

/**
 * Global (OAuth) backend keeps its login state in `<homeDir>/.auth`. The CLI
 * reads that state itself; the proxy only needs to know whether it exists so
 * it can fail with a clear 401 instead of requiring a dummy token env var.
 */
function hasCliAuth(backend) {
  return profiles.hasAuthDir(path.join(backend.homeDir, '.auth'));
}

function resolveCliToken(backend) {
  const token = process.env[backend.tokenEnvVar];
  if (token) return token;

  // Global backend: OAuth login state is authoritative, no env token needed.
  if (backend.name === 'global' && hasCliAuth(backend)) return '';

  const message =
    backend.name === 'global'
      ? `${backend.command} is not logged in. Run \`${backend.command} login\` first; ` +
        `no OAuth state was found in ${path.join(backend.homeDir, '.auth')}.`
      : `${backend.tokenEnvVar} is not configured. Set it in .env or run \`${backend.command} login\` first.`;
  throw new AppError(401, 'cli_token_missing', message, 'authentication_error');
}

// OpenAI's `developer` role is the successor of `system` — treat both as
// system-level instructions routed through --append-system-prompt.
function isSystemRole(role) {
  return role === 'system' || role === 'developer';
}

function normalizeContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') return part.text || part.content || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

function normalizeMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      // Format tool results with their call ID for context continuity
      const id = message.tool_call_id || 'unknown';
      const content = normalizeContent(message.content);
      return {
        role: 'tool',
        content: `<tool_result id="${id}">\n${content}\n</tool_result>`,
      };
    }
    if (message.role === 'assistant' && message.tool_calls) {
      // Format previous assistant tool_calls for context continuity
      const parts = [];
      if (message.content) {
        parts.push(normalizeContent(message.content));
      }
      for (const call of message.tool_calls) {
        const name = call.function?.name || call.name || 'unknown';
        const args = call.function?.arguments || JSON.stringify(call.arguments || {});
        parts.push(`[assistant called tool: ${name} with arguments: ${args}]`);
      }
      return { role: 'assistant', content: parts.join('\n') };
    }
    return {
      role: message.role,
      content: normalizeContent(message.content),
    };
  });
}

function buildPrompt(messages, tools, hasSystemToolPrompt = false) {
  const normalized = normalizeMessages(messages);
  const parts = [];

  const hasSystemPrompt = normalized.some((m) => m.role === 'system');
  const hasTools = tools && tools.length > 0 && !hasSystemToolPrompt;

  if (hasTools) {
    parts.push(buildToolSystemPrompt(tools));
  } else if (hasSystemPrompt) {
    // Client already told the model who to be — don't add anything.
    // The JSON conversation blob below is enough context.
  } else {
    // No system prompt, no tools — bare request. Add minimal guidance.
    parts.push('Answer the latest user message in the conversation context below.');
  }

  parts.push('');
  parts.push(JSON.stringify({ messages: normalized }, null, 2));
  return parts.join('\n');
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function parseMaybeJsonLines(text) {
  const trimmed = stripAnsi(text).trim();
  if (!trimmed) return [];

  try {
    return [JSON.parse(trimmed)];
  } catch (_) {
    const parsed = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate || (!candidate.startsWith('{') && !candidate.startsWith('['))) continue;
      try {
        parsed.push(JSON.parse(candidate));
      } catch (_) {
        // Ignore non-JSON status lines; unstructured-only output is rejected.
      }
    }
    return parsed;
  }
}

function textFromContentParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') return part.text || part.content || '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractText(record) {
  if (record == null) return '';
  if (typeof record === 'string') return record;
  if (Array.isArray(record)) {
    for (let i = record.length - 1; i >= 0; i -= 1) {
      const text = extractText(record[i]);
      if (text) return text;
    }
    return '';
  }
  if (typeof record !== 'object') return '';

  if (record.type === 'result' && typeof record.result === 'string') return record.result;
  if (typeof record.content === 'string') return record.content;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.result === 'string') return record.result;
  if (typeof record.response === 'string') return record.response;
  if (typeof record.output === 'string') return record.output;

  const message = record.message;
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    const fromContent = textFromContentParts(message.content);
    if (fromContent) return fromContent;
    if (typeof message.text === 'string') return message.text;
  }

  return '';
}

function extractAssistantContent(stdout) {
  const records = parseMaybeJsonLines(stdout);
  if (!records.length) {
    throw new AppError(
      502,
      'invalid_upstream_output',
      'Qoder CN CLI did not return structured JSON output.'
    );
  }

  for (let i = records.length - 1; i >= 0; i -= 1) {
    const text = extractText(records[i]).trim();
    if (text) return text;
  }

  throw new AppError(502, 'empty_upstream_output', 'Qoder CN CLI returned no assistant content.');
}

function ensureRuntimeHome(rootDir) {
  const runtimeHome = path.join(rootDir, '.runtime', 'qodercn-home');
  fs.mkdirSync(path.join(runtimeHome, 'AppData', 'Roaming'), { recursive: true });
  fs.mkdirSync(path.join(runtimeHome, 'AppData', 'Local'), { recursive: true });
  return runtimeHome;
}

function buildChildEnv(rootDir, token, backend, profile) {
  ensureRuntimeHome(rootDir);
  const cfg = backend || getCliBackend(profile);
  const env = { ...process.env, ...profiles.profileEnv(profile) };
  // Only inject a real token. The global backend authenticates through its
  // OAuth files, so setting the variable to "" or "undefined" is wrong.
  if (token) env[cfg.tokenEnvVar] = token;
  return env;
}

function appendChunk(chunks, chunk, currentBytes) {
  const nextBytes = currentBytes + chunk.length;
  if (nextBytes > MAX_OUTPUT_BYTES) {
    throw new AppError(502, 'upstream_output_too_large', 'Qoder CN CLI output exceeded the limit.');
  }
  chunks.push(chunk);
  return nextBytes;
}

function buildCliArgs({
  prompt,
  model,
  reasoningEffort,
  contextWindow,
  maxOutputTokens,
  attachmentPath,
  appendSystemPrompt,
  stream,
}) {
  const args = [
    '--print',
    '--output-format',
    stream ? 'stream-json' : 'json',
    '--model',
    model,
    '--dangerously-skip-permissions',
  ];

  // The CLI is a full agent: with its built-in tools enabled it can turn a
  // plain chat request into minutes of multi-turn file/shell loops inside the
  // proxy's own working directory. The proxy's tool calling is simulated at
  // the prompt level and never needs them, so disable them by default.
  // Set QODERCN_CLI_TOOLS=1 to keep the CLI's built-in tools.
  if (!process.env.QODERCN_CLI_TOOLS) {
    args.push('--tools=');
  }

  if (attachmentPath) {
    args.push('--attachment', attachmentPath);
  }

  if (appendSystemPrompt) {
    args.push('--append-system-prompt', appendSystemPrompt);
  }

  if (reasoningEffort) {
    args.push('--reasoning-effort', reasoningEffort);
  }

  if (contextWindow) {
    args.push('--context-window', String(contextWindow));
  }

  if (maxOutputTokens) {
    args.push('--max-output-tokens', String(maxOutputTokens));
  }

  args.push('--', attachmentPath ? ATTACHMENT_INSTRUCTION : prompt);
  return args;
}

function buildSpawnCommand(command, args, backend) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const cfg = backend || getCliBackend();
    const bundle = path.join(
      path.dirname(command),
      'node_modules',
      cfg.bundlePackage,
      cfg.bundlePath
    );
    if (fs.existsSync(bundle)) {
      return {
        command: process.execPath,
        args: [bundle, ...args],
      };
    }
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args],
    };
  }
  return { command, args };
}

function hasPathSeparator(command) {
  return /[\\/]/.test(command);
}

function pathEnv(env = process.env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path');
  return key ? env[key] || '' : '';
}

function executableExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function resolveCliCommand(command, env = process.env) {
  if (process.platform !== 'win32' || hasPathSeparator(command)) return command;

  const commandExt = path.extname(command);
  const defaultExts = ['.cmd', '.exe', '.bat', '.com'];
  const envExts = (env.PATHEXT || '')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const candidateExts = commandExt
    ? ['']
    : [...defaultExts, ...envExts.filter((ext) => !defaultExts.includes(ext))];

  for (const dir of pathEnv(env).split(';').filter(Boolean)) {
    for (const ext of candidateExts) {
      const candidate = path.join(dir, command + ext);
      if (executableExists(candidate)) return candidate;
    }
  }

  return command;
}

/**
 * Windows command line has a ~32,767 character limit (CreateProcessW),
 * and the cmd.exe fallback path is far tighter: cmd.exe truncates a single
 * command line at 8,191 characters. Agent clients routinely send system
 * prompts of 5-20k characters, which lands exactly in that gap.
 * When --append-system-prompt is too long for the spawn target, prepend it
 * to the attachment file and remove it from CLI args instead.
 */
function fixLongAppendSystemPrompt(args, attachmentPath, command) {
  if (process.platform !== 'win32' || !attachmentPath) return args;

  const idx = args.indexOf('--append-system-prompt');
  if (idx === -1) return args;

  const systemPrompt = args[idx + 1];
  if (!systemPrompt) return args;

  // Rough estimate: include command name and a safety margin
  const totalLength = (command?.length || 10) + args.reduce((acc, s) => acc + s.length + 1, 0);
  const isCmdShell = /cmd(\.exe)?$/i.test(command || '');
  const limit = isCmdShell ? 7500 : 30000;
  if (totalLength < limit) return args;

  try {
    const original = fs.readFileSync(attachmentPath, 'utf8');
    fs.writeFileSync(attachmentPath, systemPrompt + '\n\n' + original, 'utf8');
  } catch (e) {
    // If we can't modify the file, keep original args and hope for the best
    return args;
  }

  const newArgs = [...args];
  newArgs.splice(idx, 2);
  return newArgs;
}

function createPromptAttachment(rootDir, prompt) {
  const promptDir = path.join(rootDir, '.runtime', 'prompts');
  fs.mkdirSync(promptDir, { recursive: true });
  const filePath = path.join(
    promptDir,
    `prompt-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );
  fs.writeFileSync(filePath, prompt, 'utf8');
  return filePath;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Normalize the usage block the CLI prints in its final `result` record.
 *
 * Verified against qodercli 1.1.41: `total_credits` is the per-invocation
 * credit charge, `total_cost_usd` its USD equivalent, and `modelUsage` breaks
 * both down per CLI model. Token counters are present but always 0 under the
 * current plan metering, so `tokensAvailable` reports whether they can be
 * trusted instead of pretending estimates are real.
 */
function extractCliUsage(records) {
  const usage = {
    credits: 0,
    costUsd: 0,
    models: {},
    inputTokens: 0,
    outputTokens: 0,
    tokensAvailable: false,
  };
  if (!Array.isArray(records)) return usage;

  let source = null;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (!record || typeof record !== 'object') continue;
    if (typeof record.total_credits === 'number' || (record.modelUsage && typeof record.modelUsage === 'object')) {
      source = record;
      break;
    }
  }
  if (!source) return usage;

  usage.credits = numberOrZero(source.total_credits);
  usage.costUsd = numberOrZero(source.total_cost_usd);

  if (source.modelUsage && typeof source.modelUsage === 'object') {
    for (const [name, entry] of Object.entries(source.modelUsage)) {
      if (!entry || typeof entry !== 'object') continue;
      usage.models[name] = {
        credits: numberOrZero(entry.credits),
        costUsd: numberOrZero(entry.costUSD),
        inputTokens: numberOrZero(entry.inputTokens),
        outputTokens: numberOrZero(entry.outputTokens),
      };
    }
  }

  const reported = source.usage && typeof source.usage === 'object' ? source.usage : {};
  usage.inputTokens = numberOrZero(reported.input_tokens);
  usage.outputTokens = numberOrZero(reported.output_tokens);
  if (!usage.inputTokens && !usage.outputTokens) {
    for (const entry of Object.values(usage.models)) {
      usage.inputTokens += entry.inputTokens;
      usage.outputTokens += entry.outputTokens;
    }
  }
  usage.tokensAvailable = usage.inputTokens > 0 || usage.outputTokens > 0;

  if (!usage.credits && Object.keys(usage.models).length) {
    usage.credits = Object.values(usage.models).reduce((sum, entry) => sum + entry.credits, 0);
  }
  return usage;
}

function mergeCliUsage(total, next) {
  if (!next) return total;
  if (!total) return { ...next, models: { ...next.models } };

  total.credits += next.credits || 0;
  total.costUsd += next.costUsd || 0;
  total.inputTokens += next.inputTokens || 0;
  total.outputTokens += next.outputTokens || 0;
  total.tokensAvailable = total.tokensAvailable || Boolean(next.tokensAvailable);

  for (const [name, entry] of Object.entries(next.models || {})) {
    const current = total.models[name] || { credits: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    total.models[name] = {
      credits: current.credits + (entry.credits || 0),
      costUsd: current.costUsd + (entry.costUsd || 0),
      inputTokens: current.inputTokens + (entry.inputTokens || 0),
      outputTokens: current.outputTokens + (entry.outputTokens || 0),
    };
  }
  return total;
}

const AUTH_ERROR_RE =
  /(not logged in|please run \/login|unauthori[sz]ed|authentication (failed|required)|invalid (token|api key)|session (expired|invalid)|\b401\b)/i;
const QUOTA_ERROR_RE =
  /(quota|rate[ _-]?limit|too many requests|insufficient (credit|credits|balance|funds)|credits? (exhausted|exceeded|depleted)|usage limit|billing|limit reached|\b402\b|\b429\b)/i;

function cliFailureText(record) {
  if (!record || typeof record !== 'object') return '';
  const parts = [record.result, record.message, record.detail];
  if (typeof record.error === 'string') parts.push(record.error);
  else if (record.error && typeof record.error === 'object') {
    parts.push(record.error.message, record.error.type, record.error.code);
  }
  return parts.filter((part) => typeof part === 'string' && part.trim()).join(' ').trim();
}

/**
 * The CLI can exit 0 while its final `result` record says `is_error: true`
 * (for example "Not logged in"), and quota/billing failures arrive as plain
 * stderr text. Classify both so the proxy can rotate accounts or answer 401
 * instead of returning an empty assistant message.
 */
function classifyCliFailure(records, stderr) {
  const list = Array.isArray(records) ? records : [];
  let errorRecord = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const record = list[i];
    if (record && typeof record === 'object' && (record.is_error === true || record.type === 'error')) {
      errorRecord = record;
      break;
    }
  }

  const haystack = `${cliFailureText(errorRecord)} ${stderr || ''}`.trim();
  if (!haystack) return null;

  if (AUTH_ERROR_RE.test(haystack)) {
    return new AppError(
      401,
      'cli_not_authenticated',
      `Qoder CLI is not authenticated: ${haystack.slice(0, 240)}`,
      'authentication_error'
    );
  }
  if (QUOTA_ERROR_RE.test(haystack)) {
    return new AppError(
      429,
      'profile_quota_exhausted',
      `Qoder account hit a quota/rate/billing limit: ${haystack.slice(0, 240)}`,
      'rate_limit_error'
    );
  }
  if (errorRecord) {
    return new AppError(502, 'upstream_error', `Qoder CLI returned an error: ${haystack.slice(0, 240)}`);
  }
  return null;
}

function isSwitchableError(error) {
  return Boolean(
    error &&
      (error.code === 'profile_quota_exhausted' ||
        error.code === 'cli_not_authenticated' ||
        error.code === 'cli_token_missing')
  );
}

function profileCanRun(profile) {
  const backend = getCliBackend(profile);
  if (process.env[backend.tokenEnvVar]) return true;
  return backend.name === 'global' && hasCliAuth(backend);
}

function profileCandidates(profileName) {
  try {
    const backend = getCliBackend(profileName ? profiles.getProfile(profileName) : undefined);
    if (backend.name !== 'global') {
      const profile = profileName ? profiles.getProfile(profileName) : profiles.getActiveProfile();
      return profile ? [profile] : [];
    }

    const ordered = profiles.rotationOrder(profileName);
    const runnable = ordered.filter(profileCanRun);
    return runnable.length ? runnable : ordered;
  } catch (error) {
    if (error instanceof RangeError) {
      throw new AppError(400, 'unknown_profile', error.message, 'invalid_request_error');
    }
    throw error;
  }
}

async function runQoderCnCli(options) {
  const candidates = profileCandidates(options.profileName);
  let lastError = null;

  for (const profile of candidates) {
    try {
      const text = await runQoderCnCliAttempt({ ...options, profile });
      profiles.clearCooldown(profile.name);
      return text;
    } catch (error) {
      if (!isSwitchableError(error)) throw error;
      error.profileName = error.profileName || profile.name;
      profiles.markCooldown(profile.name);
      lastError = error;
    }
  }

  throw lastError || new AppError(503, 'no_profile_available', 'No Qoder profile is available.');
}

function runQoderCnCliAttempt({
  messages,
  model,
  tools,
  reasoningEffort,
  contextWindow,
  maxOutputTokens,
  signal,
  rootDir = process.cwd(),
  onUsage,
  profile,
}) {
  const backend = getCliBackend(profile);
  const token = resolveCliToken(backend);

  // Extract system messages for --append-system-prompt
  const systemMessages = messages.filter((m) => isSystemRole(m.role));
  const nonSystemMessages = messages.filter((m) => !isSystemRole(m.role));
  const appendSystemPrompt = systemMessages
    .map((m) => normalizeContent(m.content))
    .filter(Boolean)
    .join('\n\n');

  const hasSystemToolPrompt = systemMessages.some((m) => /\[Tool Protocol\]/.test(normalizeContent(m.content)));
  const command = resolveCliCommand(process.env.CLI_COMMAND || process.env.QODERCN_CLI_PATH || backend.command);
  const modelRoute = resolveModelRoute(model);
  const cliModel = modelRoute.cliModel;
  // Build prompt with non-system messages only (system prompt goes via CLI flag)
  const prompt = buildPrompt(nonSystemMessages, tools, hasSystemToolPrompt);
  const timeoutMs = Number(process.env.QODERCN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const effort = reasoningEffort || modelRoute.reasoningEffort || process.env.QODERCN_REASONING_EFFORT;
  const windowSize = contextWindow || process.env.QODERCN_CONTEXT_WINDOW;
  const outputTokens = maxOutputTokens || process.env.QODERCN_MAX_OUTPUT_TOKENS;
  const attachmentPath = createPromptAttachment(rootDir, prompt);
  const args = buildCliArgs({
    prompt,
    model: cliModel,
    reasoningEffort: effort,
    contextWindow: windowSize,
    maxOutputTokens: outputTokens,
    attachmentPath,
    appendSystemPrompt: appendSystemPrompt || undefined,
  });
  const spawnSpec = buildSpawnCommand(command, args, backend);
  const finalArgs = fixLongAppendSystemPrompt(spawnSpec.args, attachmentPath, spawnSpec.command);

  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    let forceSettleTimer = null;
    let exitFallbackTimer = null;

    const child = spawn(spawnSpec.command, finalArgs, {
      cwd: rootDir,
      env: buildChildEnv(rootDir, token, backend, profile),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceSettleTimer);
      clearTimeout(exitFallbackTimer);
      signal?.removeEventListener?.('abort', onAbort);
      fs.rmSync(attachmentPath, { force: true });
      fn(value);
    };

    const timeoutError = () =>
      new AppError(504, 'upstream_timeout', `${backend.command} request timed out.`);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // kill() does not guarantee 'close': if a descendant process keeps the
      // stdio pipes open, 'close' never fires and the request would hang
      // forever. Settle shortly after the kill deadline regardless.
      forceSettleTimer = setTimeout(() => {
        finish(reject, timeoutError());
      }, 5000);
    }, timeoutMs);

    const onAbort = () => {
      child.kill();
      finish(
        reject,
        new AppError(499, 'request_cancelled', 'Request was cancelled by the client.')
      );
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.on('error', (error) => {
      const code = error.code === 'ENOENT' ? 'cli_not_found' : 'cli_error';
      const message =
        error.code === 'ENOENT'
          ? `${backend.command} is not installed or not on PATH.`
          : `Failed to start ${backend.command}.`;
      finish(reject, new AppError(502, code, message));
    });

    child.stdout.on('data', (chunk) => {
      try {
        stdoutBytes = appendChunk(stdoutChunks, chunk, stdoutBytes);
      } catch (error) {
        child.kill();
        finish(reject, error);
      }
    });

    child.stderr.on('data', (chunk) => {
      try {
        stderrBytes = appendChunk(stderrChunks, chunk, stderrBytes);
      } catch (error) {
        child.kill();
        finish(reject, error);
      }
    });

    const handleClose = (code) => {
      if (settled) return;
      if (timedOut) {
        finish(reject, timeoutError());
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      let records = [];
      try {
        records = parseMaybeJsonLines(stdout);
      } catch (_) {
        // Classification falls back to stderr.
      }

      const failure = classifyCliFailure(records, stderr);
      if (failure) {
        finish(reject, failure);
        return;
      }

      if (code !== 0) {
        const detail = redactString(stderr).trim();
        const suffix = detail ? ` ${detail.slice(0, 240)}` : '';
        finish(reject, new AppError(502, 'upstream_error', `${backend.command} failed.${suffix}`));
        return;
      }

      try {
        if (typeof onUsage === 'function') {
          try {
            const usage = extractCliUsage(records);
            usage.profile = profile ? profile.name : profiles.getConfig().active;
            onUsage(usage);
          } catch (_) {
            // Metering must never break the chat response.
          }
        }
        finish(resolve, extractAssistantContent(stdout));
      } catch (error) {
        finish(reject, error);
      }
    };

    // 'exit' fires when the process exits; 'close' additionally waits for the
    // stdio streams. If a descendant inherits the pipes, 'close' can lag
    // forever — settle from 'exit' after a short grace period for output to
    // flush.
    child.on('exit', (code) => {
      exitFallbackTimer = setTimeout(() => handleClose(code), 2000);
    });

    child.on('close', (code) => {
      clearTimeout(exitFallbackTimer);
      handleClose(code);
    });
  });
}

/**
 * Extract a text delta from a single stream-json line.
 *
 * The CLI's `--output-format stream-json` emits one JSON object per line with
 * various `type` values.  Only `assistant`-type messages carry incremental
 * text that should be forwarded to the client.
 *
 * Returns a non-empty string when text is available, or `null` to skip.
 */
function extractStreamDelta(record) {
  if (!record || typeof record !== 'object') return null;

  if (record.type === 'assistant') {
    if (record.message && Array.isArray(record.message.content)) {
      const texts = record.message.content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text);
      if (texts.length) return texts.join('');
    }
    if (typeof record.delta === 'string') return record.delta;
    if (typeof record.text === 'string') return record.text;
  }

  return null;
}

/**
 * Convert the CLI's stream-json assistant events into real text deltas.
 *
 * Verified against qodercli 1.1.41: each `assistant` event carries the
 * cumulative snapshot of its message (same message.id, text blocks growing
 * from the start — e.g. 38 chars, then 3176 chars), NOT an incremental
 * delta. Forwarding extractStreamDelta() output directly would repeat text
 * on every snapshot. This tracker aligns text blocks by index within a
 * message and returns only the newly grown suffix of each block.
 *
 * Usage: call push(record) for every parsed stream-json line; it returns an
 * array of non-empty delta strings (usually 0 or 1) to forward in order.
 */
function createStreamSnapshotTracker() {
  let lastMessageId = null;
  let blockLengths = [];

  return {
    push(record) {
      if (!record || typeof record !== 'object' || record.type !== 'assistant') {
        return [];
      }

      const messageId = record.message && record.message.id ? record.message.id : null;
      if (messageId !== lastMessageId) {
        lastMessageId = messageId;
        blockLengths = [];
      }

      if (record.message && Array.isArray(record.message.content)) {
        const texts = record.message.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text);
        if (texts.length) {
          // Defensive: fewer text blocks than tracked means the message shape
          // changed unexpectedly — restart alignment rather than skip text.
          if (texts.length < blockLengths.length) blockLengths = [];
          const deltas = [];
          texts.forEach((text, index) => {
            const previous = blockLengths[index] || 0;
            blockLengths[index] = text.length;
            if (text.length > previous) deltas.push(text.slice(previous));
          });
          return deltas;
        }
      }

      // Fallback fields (not observed in practice, kept for resilience):
      // their semantics are unknown, so forward them as-is per event.
      if (typeof record.delta === 'string' && record.delta) return [record.delta];
      if (typeof record.text === 'string' && record.text) return [record.text];
      return [];
    },
  };
}

function runQoderCnCliStreamAttempt({
  messages,
  model,
  tools,
  reasoningEffort,
  contextWindow,
  maxOutputTokens,
  signal,
  rootDir = process.cwd(),
  onDelta,
  onUsage,
  profile,
}) {
  const backend = getCliBackend(profile);
  const token = resolveCliToken(backend);

  const systemMessages = messages.filter((m) => isSystemRole(m.role));
  const nonSystemMessages = messages.filter((m) => !isSystemRole(m.role));
  const appendSystemPrompt = systemMessages
    .map((m) => normalizeContent(m.content))
    .filter(Boolean)
    .join('\n\n');

  const hasSystemToolPrompt = systemMessages.some((m) => /\[Tool Protocol\]/.test(normalizeContent(m.content)));
  const command = resolveCliCommand(process.env.CLI_COMMAND || process.env.QODERCN_CLI_PATH || backend.command);
  const modelRoute = resolveModelRoute(model);
  const cliModel = modelRoute.cliModel;
  const prompt = buildPrompt(nonSystemMessages, tools, hasSystemToolPrompt);
  const timeoutMs = Number(process.env.QODERCN_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const effort = reasoningEffort || modelRoute.reasoningEffort || process.env.QODERCN_REASONING_EFFORT;
  const windowSize = contextWindow || process.env.QODERCN_CONTEXT_WINDOW;
  const outputTokens = maxOutputTokens || process.env.QODERCN_MAX_OUTPUT_TOKENS;
  const attachmentPath = createPromptAttachment(rootDir, prompt);
  const args = buildCliArgs({
    prompt,
    model: cliModel,
    reasoningEffort: effort,
    contextWindow: windowSize,
    maxOutputTokens: outputTokens,
    attachmentPath,
    appendSystemPrompt: appendSystemPrompt || undefined,
    stream: true,
  });
  const spawnSpec = buildSpawnCommand(command, args, backend);
  const finalArgs = fixLongAppendSystemPrompt(spawnSpec.args, attachmentPath, spawnSpec.command);

  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stderrChunks = [];
    let settled = false;
    let timedOut = false;
    let forceSettleTimer = null;
    let exitFallbackTimer = null;
    let lineBuffer = '';
    const fullTextParts = [];
    // Keep parsed records so we can fall back to a final `result`-style
    // record when no assistant deltas were recognized during streaming.
    const parsedRecords = [];
    // stream-json assistant events are cumulative snapshots — convert them
    // to real deltas so clients (and fullTextParts) never see repeated text.
    const snapshotTracker = createStreamSnapshotTracker();

    const child = spawn(spawnSpec.command, finalArgs, {
      cwd: rootDir,
      env: buildChildEnv(rootDir, token, backend, profile),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceSettleTimer);
      clearTimeout(exitFallbackTimer);
      signal?.removeEventListener?.('abort', onAbort);
      fs.rmSync(attachmentPath, { force: true });
      fn(value);
    };

    const timeoutError = () =>
      new AppError(504, 'upstream_timeout', `${backend.command} request timed out.`);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // kill() does not guarantee 'close': if a descendant process keeps the
      // stdio pipes open, 'close' never fires and the request would hang
      // forever. Settle shortly after the kill deadline regardless.
      forceSettleTimer = setTimeout(() => {
        finish(reject, timeoutError());
      }, 5000);
    }, timeoutMs);

    const onAbort = () => {
      child.kill();
      finish(
        reject,
        new AppError(499, 'request_cancelled', 'Request was cancelled by the client.')
      );
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });

    child.on('error', (error) => {
      const code = error.code === 'ENOENT' ? 'cli_not_found' : 'cli_error';
      const message =
        error.code === 'ENOENT'
          ? `${backend.command} is not installed or not on PATH.`
          : `Failed to start ${backend.command}.`;
      finish(reject, new AppError(502, code, message));
    });

    child.stdout.on('data', (chunk) => {
      try {
        const nextBytes = stdoutBytes + chunk.length;
        if (nextBytes > MAX_OUTPUT_BYTES) {
          throw new AppError(502, 'upstream_output_too_large', `${backend.command} output exceeded the limit.`);
        }
        stdoutBytes = nextBytes;
      } catch (error) {
        child.kill();
        finish(reject, error);
        return;
      }

      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const record = JSON.parse(trimmed);
          parsedRecords.push(record);
          for (const delta of snapshotTracker.push(record)) {
            fullTextParts.push(delta);
            onDelta(delta);
          }
        } catch (_) {
          // Non-JSON line — skip silently (status messages, ANSI, etc.)
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      try {
        stderrBytes = appendChunk(stderrChunks, chunk, stderrBytes);
      } catch (error) {
        child.kill();
        finish(reject, error);
      }
    });

    const handleClose = (code) => {
      // Flush remaining buffer
      if (lineBuffer.trim()) {
        try {
          const record = JSON.parse(lineBuffer.trim());
          parsedRecords.push(record);
          for (const delta of snapshotTracker.push(record)) {
            fullTextParts.push(delta);
            onDelta(delta);
          }
        } catch (_) {
          // Ignore
        }
      }

      if (settled) return;
      if (timedOut) {
        finish(reject, timeoutError());
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const failure = classifyCliFailure(parsedRecords, stderr);
      if (failure) {
        finish(reject, failure);
        return;
      }

      if (code !== 0) {
        const detail = redactString(stderr).trim();
        const suffix = detail ? ` ${detail.slice(0, 240)}` : '';
        finish(reject, new AppError(502, 'upstream_error', `${backend.command} failed.${suffix}`));
        return;
      }

      if (typeof onUsage === 'function') {
        try {
          const usage = extractCliUsage(parsedRecords);
          usage.profile = profile ? profile.name : profiles.getConfig().active;
          onUsage(usage);
        } catch (_) {
          // Metering must never break the chat response.
        }
      }

      // Fallback: no assistant deltas recognized, but the CLI exited cleanly.
      // Pull the final text out of the last meaningful record (e.g. a
      // `type: "result"` summary) so streaming clients don't get an empty
      // message while non-streaming requests would have succeeded.
      if (!fullTextParts.length && parsedRecords.length) {
        for (let i = parsedRecords.length - 1; i >= 0; i -= 1) {
          const text = extractText(parsedRecords[i]).trim();
          if (text) {
            fullTextParts.push(text);
            try {
              onDelta(text);
            } catch (_) {
              // Client connection may already be gone — still resolve.
            }
            break;
          }
        }
      }

      finish(resolve, fullTextParts.join(''));
    };

    // 'exit' fires when the process exits; 'close' additionally waits for the
    // stdio streams. If a descendant inherits the pipes, 'close' can lag
    // forever — settle from 'exit' after a short grace period for output to
    // flush.
    child.on('exit', (code) => {
      exitFallbackTimer = setTimeout(() => handleClose(code), 2000);
    });

    child.on('close', (code) => {
      clearTimeout(exitFallbackTimer);
      handleClose(code);
    });
  });
}

async function runQoderCnCliStream(options) {
  const candidates = profileCandidates(options.profileName);
  let lastError = null;

  for (const profile of candidates) {
    let emitted = false;
    try {
      const text = await runQoderCnCliStreamAttempt({
        ...options,
        profile,
        onDelta: (delta) => {
          emitted = true;
          if (typeof options.onDelta === 'function') options.onDelta(delta);
        },
      });
      profiles.clearCooldown(profile.name);
      return text;
    } catch (error) {
      // Never replay a stream that already delivered text: the client would
      // see duplicate output. Rotation only happens before the first delta.
      if (!isSwitchableError(error) || emitted) throw error;
      error.profileName = error.profileName || profile.name;
      profiles.markCooldown(profile.name);
      lastError = error;
    }
  }

  throw lastError || new AppError(503, 'no_profile_available', 'No Qoder profile is available.');
}

const LOGIN_URL_RE = /https:\/\/qoder\.com\/[^\s"'<>]+/i;
const LOGIN_URL_TIMEOUT_MS = 15000;
const LOGIN_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const loginSessions = new Map();

/**
 * Start `qodercli login` for one profile and resolve as soon as the device
 * authorization URL is printed. The child stays alive so the CLI can receive
 * the browser callback; the dashboard shows the link and polls `/accounts`.
 */
function startCliLogin(profileName) {
  const profile = profileName ? profiles.getProfile(profileName) : profiles.getActiveProfile();
  if (!profile) {
    throw new AppError(400, 'unknown_profile', `Unknown profile: ${profileName}`, 'invalid_request_error');
  }

  const backend = getCliBackend(profile);
  if (backend.name !== 'global') {
    throw new AppError(
      400,
      'login_unsupported',
      `The login link is only for the global OAuth backend. ${backend.command} uses ${backend.tokenEnvVar}.`,
      'invalid_request_error'
    );
  }

  const previous = loginSessions.get(profile.name);
  if (previous && !previous.done) {
    try {
      previous.child.kill();
    } catch (_) {
      // Best effort: a dead child must not block a fresh login.
    }
  }

  if (profile.home) {
    try {
      fs.mkdirSync(profile.home, { recursive: true });
    } catch (error) {
      throw new AppError(400, 'invalid_profile_home', error.message, 'invalid_request_error');
    }
  }

  const rootDir = process.cwd();
  const spawnSpec = buildSpawnCommand(backend.command, ['login'], backend);
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: rootDir,
    env: buildChildEnv(rootDir, null, backend, profile),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const session = {
    profile: profile.name,
    url: null,
    done: false,
    error: null,
    exitCode: null,
    startedAt: Date.now(),
    child,
  };
  loginSessions.set(profile.name, session);

  const authTimer = setTimeout(() => {
    if (session.done) return;
    session.error = session.error || 'Login was not completed within 5 minutes.';
    try {
      child.kill();
    } catch (_) {
      // Already gone.
    }
  }, LOGIN_AUTH_TIMEOUT_MS);
  authTimer.unref?.();

  child.on('error', (error) => {
    session.error = error.message;
    session.done = true;
    clearTimeout(authTimer);
  });
  child.on('exit', (code) => {
    session.done = true;
    session.exitCode = code;
    clearTimeout(authTimer);
    if (code !== 0 && !session.error) session.error = `Login exited with code ${code}.`;
  });

  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(urlTimer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      // Keep the pipes flowing so the waiting CLI never blocks on backpressure.
      child.stdout.resume();
      child.stderr.resume();
      resolve({
        profile: profile.name,
        url: session.url,
        ready: Boolean(session.url),
        running: !session.done,
        error: session.error,
      });
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (!session.url) {
        const match = buffer.match(LOGIN_URL_RE);
        if (match) session.url = match[0];
      }
      if (session.url) finish();
    };

    const urlTimer = setTimeout(finish, LOGIN_URL_TIMEOUT_MS);
    urlTimer.unref?.();

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    if (session.done) finish();
  });
}

function getCliLoginStatus(profileName) {
  const session = loginSessions.get(profileName);
  if (!session) {
    return { profile: profileName, running: false, done: false, url: null, error: null };
  }
  return {
    profile: session.profile,
    running: !session.done,
    done: session.done,
    url: session.url,
    error: session.error,
    exitCode: session.exitCode,
  };
}

function cancelCliLogin(profileName) {
  const session = loginSessions.get(profileName);
  if (!session) return false;
  if (!session.done) {
    session.error = 'Login cancelled.';
    try {
      session.child.kill();
    } catch (_) {
      // Already gone.
    }
  }
  loginSessions.delete(profileName);
  return true;
}

module.exports = {
  ATTACHMENT_INSTRUCTION,
  cancelCliLogin,
  getCliLoginStatus,
  startCliLogin,
  classifyCliFailure,
  buildCliArgs,
  buildPrompt,
  buildSpawnCommand,
  createPromptAttachment,
  createStreamSnapshotTracker,
  extractAssistantContent,
  extractCliUsage,
  extractStreamDelta,
  hasCliAuth,
  isSwitchableError,
  mergeCliUsage,
  profileCandidates,
  resolveCliToken,
  fixLongAppendSystemPrompt,
  getCliBackend,
  normalizeMessages,
  resolveCliCommand,
  runQoderCnCli,
  runQoderCnCliStream,
};
