# Qoder Local Gateway

## Disclaimer

This project is only for personal-account local compatibility experiments and protocol adapter research.
Users must hold their own lawful Qoder account and Personal Access Token.
This project does not provide, share, resell, rent, or transfer any Qoder account, Token, or quota.
Do not deploy this project as a public service, community endpoint, commercial API, relay service, or multi-user shared service.
Do not use this project to bypass Qoder's official billing, risk controls, rate limits, regional restrictions, or usage restrictions.
Please comply with Qoder's official terms of service. If official rules do not allow your use case, stop using this project immediately.
This project is not affiliated with Qoder.

## This Fork

Maintained and modified by [ShinRyu04](https://github.com/ShinRyu04).

Changes over the upstream `qoder-proxy` project:

- Multi-account profiles with isolated `HOME` and optional rotation
- One-click Qoder OAuth login links and an Accounts tab
- CLI-reported credit metering, burn rate, and target/deadline pacing
- Strict model allowlist and an updated global model registry, including Sonus
- Indonesian/English web console and Windows daemon mode

See [CHANGELOG.md](CHANGELOG.md) for the full list.

## Project Scope

This project adapts the Qoder CLI (`qoderclicn` or `qodercli`) into a local-only OpenAI / Anthropic-compatible HTTP interface for studying protocol differences across local clients, message formats, streaming responses, and tool call schemas.

Two backends are supported:

- **CN backend**: `qoderclicn`, connecting to qoder.com.cn
- **Global backend**: `qodercli`, connecting to qoder.com

It is not an official API, does not imply official authorization, and does not provide account, Token, or quota services. All model calls depend on the user's own Qoder authentication.

## How It Works

`qoderclicn` and `qodercli` are command-line tools that accept text input and return text output. Many local clients and developer tools expect an OpenAI or Anthropic-format HTTP API. This project acts as a local adapter: it receives compatible API requests, translates them into CLI invocations, and converts CLI output back into compatible responses.

Supported local protocol formats:

- **OpenAI-compatible format**: `/v1/chat/completions`
- **Anthropic-compatible format**: `/v1/messages`

Both formats include tool-call field adaptation (`tool_calls` / `tool_use`) for compatibility research. Reliability depends on whether the underlying model consistently emits valid JSON.

## Tool Call Implementation

Because the CLI only handles text and has no native tool-calling channel, this project implements tool-call adaptation through prompt format instructions and output parsing: tool definitions are added as formatting guidance, then JSON tool calls are extracted from model text output.

This is different from calling official OpenAI, Anthropic, DeepSeek, or similar APIs. Official APIs usually provide a native `tools` parameter channel. This project only simulates protocol behavior at the text layer and should not be treated as an equivalent replacement.

## Security Boundaries

- Binds to `127.0.0.1` only, with no option to bind elsewhere
- **Cross-origin browser requests are refused** (loopback origins only). Otherwise
  any web page you visit could call the proxy in the background and spend your
  Qoder quota
- **Requests naming a non-loopback `Host` are refused**, which blocks DNS rebinding
- With `PROXY_API_KEY` set, `/v1/*` and `/usage/*` require the key
- Not intended or supported for public services, shared services, or commercial APIs
- Logs redact tokens, cookies, Authorization headers, and other sensitive data
- `.env`, tokens, and logs are excluded from version control

Worth stating plainly: **without `PROXY_API_KEY`, any process on your machine can
use the proxy.** Loopback binding keeps out the network, not your own machine.
Setting a key is recommended.

### Client Authentication (PROXY_API_KEY)

Once set in `.env`, clients must send the key as:

```text
Authorization: Bearer <PROXY_API_KEY>
```

or, as Anthropic-style clients prefer:

```text
x-api-key: <PROXY_API_KEY>
```

Leave it empty to require no key. `/health` is always open so scripts can probe
liveness.

If a local web app legitimately needs browser access, allow it explicitly with
`ALLOWED_ORIGINS`; if you deliberately reach the proxy under another hostname,
use `ALLOWED_HOSTS`. Both default to empty — once you use them, reviewing the
security model becomes your job.

### Upstream Authentication

| Backend | Auth Method | Environment Variable |
|---------|------------|--------------------|
| CN (`qoderclicn`) | Personal Access Token | `QODERCN_PERSONAL_ACCESS_TOKEN` |
| Global (`qodercli`) | OAuth login (`qodercli login`) | Not required |

### Server-Side Tool Execution (off by default)

`SERVER_TOOL_EXECUTION=1` makes the proxy run the model's tool calls **on your
machine**, and the model is steered by whatever prompt the client sent. Keep it
off unless your client genuinely cannot execute tools itself. When enabled:

- File operations are confined to `SERVER_TOOL_WORKSPACE` (default: the proxy's
  working directory). Absolute paths and symlinks leaving it are refused
- The `Bash` tool additionally requires `SERVER_TOOL_ALLOW_BASH=1` **and** a
  non-empty `SERVER_TOOL_BASH_ALLOWLIST`. Commands run without a shell, so
  chaining, pipes, redirection, and substitution are refused
- On Windows, skipping the shell means `.cmd`/`.bat` shims (such as `npm`) cannot
  run — only real executables (`node`, `git`, `python`)

Treat the feature as experimental, and pair it with `PROXY_API_KEY`.

## Reporting a Vulnerability

Please do not use public issues for vulnerabilities. Use GitHub's private
reporting form:
[Report a vulnerability](https://github.com/ShinRyu04/Qoder-Local-Gateway/security/advisories/new).
See [SECURITY.md](SECURITY.md) for details.

## Abuse Policy

- No public deployment
- No multi-user sharing
- No API resale
- No bypassing official billing, risk controls, rate limits, regional restrictions, or usage restrictions
- No collecting, storing, or forwarding other people's Tokens
- No providing, sharing, renting, reselling, or transferring accounts, Tokens, or quota

## Safety Recommendations

- Use only on your own machine
- Bind only to `127.0.0.1`
- Do not bind to `0.0.0.0` and do not expose the service to the public internet
- Do not send your Token to anyone
- Do not commit `.env` to Git
- If you suspect a Token leak, revoke the PAT immediately from the official Qoder account page and create a new one

## Setup

Requires Node.js 18+.

**CN backend** (required):

```bash
npm install -g @qodercn-ai/qoderclicn
qoderclicn --version
```

**Global backend** (optional):

```bash
npm install -g @qoder-ai/qodercli
qodercli --version
qodercli login   # must log in once
```

Install dependencies and create configuration:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and configure the backend and authentication:

```env
# Choose backend: "cn" or "global"
CLI_BACKEND=cn

# CN backend: your Personal Access Token
QODERCN_PERSONAL_ACCESS_TOKEN=your-cn-token

# Global backend: no token needed after running qodercli login
```

CN PAT page: https://qoder.com.cn/account/integrations

Store it securely. Do not commit `.env` to Git, and do not enter your Token into third-party clients or share it with others.

Start:

```powershell
npm start
```

On Windows, you can also double-click `start-proxy.cmd`.

Background mode (optional):

```powershell
npm run daemon start     # detached, waits for /health
npm run daemon status
npm run daemon logs 100
npm run daemon restart
npm run daemon stop
```

On Windows, `start-proxy-hidden.vbs` starts it without a window, and can be added
to Task Scheduler. The port comes from `~/.qorder-proxy/config.json`
(`{"port": 3000}`) or the `PORT` env var; logs and the PID file live there too.

Default local address:

```text
http://127.0.0.1:3000
```

If you manually change host behavior through environment variables or code edits, keep it bound to `127.0.0.1`. Do not bind to `0.0.0.0`, and do not expose it through port forwarding, reverse proxies, tunnels, or cloud servers.

## Supported Models

Global registry: `qoder-cn`, `auto`, `ultimate`, `performance`, `efficient`, `lite`, `cantus`, `sonus`, `fast`, `kimi-k3.1-pro`, `kimi-k2.8-preview`, `minimax-m3.1-flash`, `deepseek-flash`, `deepseek-v4.1-flash`, `qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-max`, `qwen3.7-plus`, `kimi-k3`, `kimi-k2.7-code`, `glm-5.3`, `glm-5.3-flash`, `deepseek-v4-pro`, `deepseek-v4-flash`, `minimax-m3`

`qwen3.8-max-effort-*` and `qwen3.7-max-effort-*` select the same model with a
different reasoning effort. Unknown IDs fall back to `auto` unless
`QODERCN_STRICT_MODELS=1` is set.

**Sonus** is the SOTA-exclusive model. While SOTA credits remain and are valid,
Sonus usage deducts from that SOTA pool; other models use the regular plan or
add-on credits. SOTA bonus credits expire, so check the expiry date in the Qoder
usage dashboard. Model availability is account-specific: the CLI silently falls
back to `auto` when a model is unavailable, and `QODERCN_STRICT_MODELS` only
validates the registry name, not server-side availability.

Reasoning effort aliases: `qwen3.8-max-effort-low`, `-medium`, `-high`, `-max`, and `qwen3.7-max-effort-low`, `-medium`, `-high`, `-max`

## Local Client Adaptation

### OpenAI-Compatible Interface

For local clients that support custom OpenAI-compatible endpoints:

- Base URL: `http://127.0.0.1:3000/v1`
- API Key: the `PROXY_API_KEY` you set in `.env`; if you did not set one, any
  placeholder works (for example `not-used`)
- Model: select from `/v1/models` or enter a model ID manually

Do not enter your Qoder Token into the client. Keep the Token only in this project's local `.env`.

## Dual Backend Switching

Switch backends via `CLI_BACKEND` in `.env`:

```env
CLI_BACKEND=cn       # use qoderclicn
CLI_BACKEND=global   # use qodercli
```

| Setting | CN Backend | Global Backend |
|---------|------------|---------------|
| CLI command | `qoderclicn` | `qodercli` |
| Auth method | Personal Access Token | `qodercli login` (OAuth) |
| Auth directory | `~/.qoderworkcn` | `~/.qoder` |
| Environment variable | `QODERCN_PERSONAL_ACCESS_TOKEN` | Not required (auto-auth after login) |

Restart the proxy after switching backends.

## Web Console Language

The web console has an **ID / EN** selector in the top-right corner. The choice is stored in browser `localStorage`, and labels, statuses, buttons and error messages switch instantly without a reload.

## Multi-Account Profiles (manual + automatic rotation)

> **Risk warning**: automatic rotation switches to another account when one hits
> a quota/rate/billing limit. This may violate Qoder's terms of service and can
> get accounts limited or banned. Use **accounts you own** only; you accept the
> risk. This project makes no promise about bypassing billing or sharing accounts.

- Each profile has its own home directory; the spawned CLI gets `USERPROFILE` /
  `HOME` overridden, so `~/.qoder/.auth` is isolated. Verified: a different home
  makes the CLI report "not logged in".
- Profiles live in `~/.qorder-proxy/profiles.json` (0600). The default profile
  uses the real home. The console has a dedicated **Accounts** tab to add,
  switch, remove and log in profiles.
- **One click to add an account**: press **Hubungkan akun** (label optional).
  The profile name and home are generated automatically
  (`~/.qoder-profiles/<name>`), then the `https://qoder.com/device/...` URL
  appears with **Buka halaman izin**, **Salin tautan**, and **Batal** buttons.
  After browser approval the status flips to `logged in`. **Batal** also deletes
  the profile created by that flow. Existing accounts have **Login** /
  **Login ulang**.
- Manual login fallback:

  ```powershell
  $env:USERPROFILE='C:\qoder-profiles\work'; qodercli login
  ```

- Manual selection: `x-qoder-profile: work` request header or `QODER_PROFILE=work`
  (both pin one account and skip rotation). **Aktifkan** in the console sets the
  default account.
- Automatic rotation (on by default, global backend only): requests start at the
  default account; quota/rate/billing or not-logged-in errors park that profile
  for a cooldown (15 min default) and the same request retries the next healthy
  profile. A stream that already emitted text is never replayed. Disable with
  `QODER_PROFILE_ROTATION=off`.
- Strict models: `QODERCN_STRICT_MODELS=1` rejects unknown models with 400 instead
  of silently falling back to `auto`.

### Anthropic-Compatible Interface

For local clients that support custom Anthropic-compatible endpoints:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000"
$env:ANTHROPIC_AUTH_TOKEN = "your-PROXY_API_KEY"   # any value if PROXY_API_KEY is unset
```

Do not append `/v1` to `ANTHROPIC_BASE_URL`; clients usually add API paths automatically.

### OpenCode Example

The repository includes `opencode.json` for local compatibility verification:

```powershell
opencode run --model qoder-cn-local/qwen3.8-max --variant high "reply OK"
```

If you set `PROXY_API_KEY`, replace `not-used` in `opencode.json`'s
`options.apiKey` with your key.

### OMP Example

OMP keeps custom OpenAI-compatible providers in `~/.omp/agent/models.yml`:

```yaml
providers:
  qoder:
    baseUrl: http://127.0.0.1:3000/v1
    apiKey: "local"
    api: openai-completions
    models:
      - id: qwen3.8-max
        name: "qwen3.8-max (Qoder)"
        supportsTools: true
        contextWindow: 200000
        maxTokens: 32000
```

Verify and run:

```powershell
omp models qoder
omp --model qoder/qwen3.8-max "reply OK"
```

If `PROXY_API_KEY` is set in `.env`, use that value as `apiKey` too. The
global/CN backend is still selected in `.env`; the OMP entry does not change.
For tool-heavy OMP sessions, fewer enabled tools give more reliable
tool-call formatting than a full MCP load.

## API Endpoints

With `PROXY_API_KEY` set, `/v1/*` and `/usage/*` require the key; `/health` does not.

| Method | Path | Key required | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
| GET | `/v1/models` | Yes | Model list |
| POST | `/v1/chat/completions` | Yes | OpenAI-compatible chat with tools field adaptation |
| POST | `/v1/messages` | Yes | Anthropic-compatible chat with tool_use field adaptation |
| POST | `/v1/messages/count_tokens` | Yes | Token estimation |
| GET | `/usage/local` | Yes | Local stats + CLI-reported credits + burn rate |
| POST | `/usage/reset-local` | Yes | Reset local stats (keeps the manual quota target) |
| GET | `/usage/burn-rate` | Yes | Burn rate and depletion projection |
| GET | `/usage/target` | Yes | Read the manual remaining-credit target |
| POST | `/usage/target` | Yes | Body `{"creditsRemaining": 2000, "deadline": "2026-11-11"}` |
| GET | `/accounts` | Yes | Profiles, auth state, cooldowns, active account |
| POST | `/accounts/active` | Yes | `{"name":"work"}` switches the default profile |
| POST | `/accounts` | Yes | `{"name","label","home"}` adds a profile |
| POST | `/accounts/login` | Yes | `{"name":"work"}` starts OAuth and returns the `url` |
| GET | `/accounts/login?name=work` | Yes | Reads the login process status |
| POST | `/accounts/login/cancel` | Yes | `{"name":"work"}` cancels the login process |
| DELETE | `/accounts?name=work` | Yes | Removes a profile (login files are kept) |

## Reasoning Options

Set global defaults via environment variables:

```powershell
$env:QODERCN_REASONING_EFFORT = "high"
$env:QODERCN_CONTEXT_WINDOW = "200000"
$env:QODERCN_MAX_OUTPUT_TOKENS = "4096"
```

Or specify per request via `reasoning_effort`, `context_window`, and `max_tokens`.

Other environment variables:

- `QODERCN_TIMEOUT_MS`: per-request timeout in milliseconds. Proxy prompts plus model queueing can take several minutes, so keep this generous (default 300000; `.env.example` suggests 600000).
- `QODERCN_CLI_TOOLS`: the CLI's built-in tools are disabled by default (`--tools=` is appended) so the model answers directly instead of running file/shell agent loops in the proxy's own directory. Set to `1` to keep the CLI's built-in tools.

## Streaming

When a client requests `stream: true`, this project uses the CLI's `--output-format stream-json` for incremental streaming and forwards text as local SSE events in real time — including requests that declare tools. For tool-declared requests the prose part streams immediately through a safety gate that withholds any tail which could still be or grow into the tool-call JSON block (unclosed or closed ` ```json ` fences, unbalanced or `"tool_calls"`-bearing JSON objects, trailing partial backticks); once the stream completes, the withheld tail is parsed and tool calls are appended as structured `tool_calls` / `tool_use` blocks. Agent clients such as Claude Code therefore show live progress while structured tool calling stays intact.

Exception: with `SERVER_TOOL_EXECUTION=1` (server-side tool execution), tool-declared streaming requests stay on the buffered path.

## Current Limitations

- Tool calls are implemented through prompt format instructions and text parsing, not native model capability
- In streaming mode, the tool-call JSON part is appended once at the end of the stream (incomplete JSON cannot be parsed early)
- Each request spawns a new CLI subprocess
- If the model emits invalid JSON or refuses the tool format, the response falls back to plain text
- In streaming mode, an unclosed fenced code block in a normal reply is withheld until its fence closes (conservative gate: delayed display, never leaked tool JSON)

## Quick Verification

```powershell
curl.exe http://127.0.0.1:3000/health
curl.exe http://127.0.0.1:3000/v1/models
curl.exe http://127.0.0.1:3000/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"qoder-cn\",\"messages\":[{\"role\":\"user\",\"content\":\"reply OK\"}]}"
```

## Testing

```powershell
npm test
```

## License

MIT. See [LICENSE](LICENSE).
