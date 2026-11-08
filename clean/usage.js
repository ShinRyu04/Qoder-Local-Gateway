'use strict';

const fs = require('fs');
const path = require('path');

const USAGE_FILE = path.join(__dirname, '..', 'usage.json');
const EVENTS_FILE = path.join(__dirname, '..', 'usage-events.jsonl');
const TARGET_FILE = path.join(__dirname, '..', 'usage-target.json');

// The test runner would otherwise write counters into the real usage files
// (node --test also sets NODE_TEST_CONTEXT in every test process).
const TEST_MODE = Boolean(process.env.NODE_TEST_CONTEXT);

const HOUR_MS = 60 * 60 * 1000;
const EVENT_RETENTION_MS = 7 * 24 * HOUR_MS;
const MAX_EVENTS = 5000;

const stats = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  requestsToday: 0,
  requestsByModel: {},
  lastRequestAt: null,
  errorCount: 0,
  estimatedInputTokens: 0,
  estimatedOutputTokens: 0,
  estimatedTotalTokens: 0,
  creditsTotal: 0,
  creditsToday: 0,
  creditsByModel: {},
  creditsByProfile: {},
  creditsCostUsd: 0,
  reportedCalls: 0,
};

// Credit samples persisted as append-only JSONL. Appending avoids the
// read-modify-write race that multiple concurrent CLI subprocesses would hit
// on a rewritten JSON file, and keeps a time series for burn-rate math.
let events = [];
let target = { creditsRemaining: null, deadline: null, updatedAt: null };
let loadedSnapshot = false;

let lastResetDate = getToday();

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function estimateTokens(text) {
  if (!text) return 0;
  // Simple estimate: ~4 chars per token for English, ~2 chars per token for CJK
  // Use a conservative 3 chars per token average
  return Math.ceil(String(text).length / 3);
}

function extractTextFromMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('');
      }
      return '';
    })
    .join('');
}

function pruneEvents(now) {
  while (events.length && (events[0].ts < now - EVENT_RETENTION_MS || events.length > MAX_EVENTS)) {
    events.shift();
  }
}

function appendCliEvent(model, cliUsage, ts) {
  const credits = Number(cliUsage.credits) || 0;
  const costUsd = Number(cliUsage.costUsd) || 0;
  if (!credits && !costUsd && !cliUsage.tokensAvailable) return;

  const event = {
    ts,
    model: model || 'unknown',
    profile: cliUsage.profile || 'default',
    credits,
    costUsd,
    inputTokens: Number(cliUsage.inputTokens) || 0,
    outputTokens: Number(cliUsage.outputTokens) || 0,
  };
  events.push(event);
  pruneEvents(ts);

  if (!TEST_MODE) {
    try {
      fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf8');
    } catch (_) {
      // Persistence is best-effort; live stats stay in memory.
    }
  }
}

function trackRequest({ model, inputText, outputText, isError, cliUsage }) {
  const today = getToday();
  if (today !== lastResetDate) {
    stats.requestsToday = 0;
    stats.creditsToday = 0;
    lastResetDate = today;
  }

  stats.totalRequests++;
  stats.requestsToday++;
  stats.lastRequestAt = new Date().toISOString();

  if (model) {
    stats.requestsByModel[model] = (stats.requestsByModel[model] || 0) + 1;
  }

  if (isError) {
    stats.errorCount++;
  }

  const inputTokens = estimateTokens(inputText);
  const outputTokens = estimateTokens(outputText);
  stats.estimatedInputTokens += inputTokens;
  stats.estimatedOutputTokens += outputTokens;
  stats.estimatedTotalTokens += inputTokens + outputTokens;

  if (cliUsage) {
    const credits = Number(cliUsage.credits) || 0;
    const costUsd = Number(cliUsage.costUsd) || 0;
    if (credits) {
      stats.creditsTotal += credits;
      stats.creditsToday += credits;
      const key = model || 'unknown';
      stats.creditsByModel[key] = (stats.creditsByModel[key] || 0) + credits;
      const profile = cliUsage.profile || 'default';
      stats.creditsByProfile[profile] = (stats.creditsByProfile[profile] || 0) + credits;
    }
    stats.creditsCostUsd += costUsd;
    if (credits || costUsd) stats.reportedCalls++;
    appendCliEvent(model, cliUsage, Date.now());
  }

  // Persist counters with the request so a hard restart cannot lose them.
  saveUsage();
}

/**
 * Credits are event-sourced: the append-only log is authoritative so a
 * restart before the 5-minute snapshot does not show zero credits while the
 * events are still on disk. Counters from usage.json remain the fallback for
 * a fresh install that has no event log yet.
 */
function recomputeCreditsFromEvents() {
  const todayStart = Date.parse(getToday());
  let total = 0;
  let today = 0;
  let costUsd = 0;
  let reportedCalls = 0;
  const byModel = {};
  const byProfile = {};

  for (const event of events) {
    const credits = Number(event.credits) || 0;
    const cost = Number(event.costUsd) || 0;
    total += credits;
    costUsd += cost;
    if (event.ts >= todayStart) today += credits;
    if (credits || cost) reportedCalls += 1;
    if (credits) {
      const key = event.model || 'unknown';
      byModel[key] = (byModel[key] || 0) + credits;
      const profile = event.profile || 'default';
      byProfile[profile] = (byProfile[profile] || 0) + credits;
    }
  }

  stats.creditsTotal = total;
  stats.creditsToday = today;
  stats.creditsCostUsd = costUsd;
  stats.creditsByModel = byModel;
  stats.creditsByProfile = byProfile;
  stats.reportedCalls = reportedCalls;
}

function summarizeWindow(now, windowMs) {
  const since = now - windowMs;
  let credits = 0;
  let count = 0;
  let firstTs = null;
  for (const event of events) {
    if (event.ts < since) continue;
    credits += event.credits || 0;
    count += 1;
    if (firstTs === null) firstTs = event.ts;
  }
  return { credits, count, firstTs };
}

function getBurnRate(now = Date.now()) {
  const hour = summarizeWindow(now, HOUR_MS);
  const sixHours = summarizeWindow(now, 6 * HOUR_MS);
  const day = summarizeWindow(now, 24 * HOUR_MS);

  // Rate over the observation span, floored at one minute so a burst of
  // requests right after startup does not produce an infinite projection.
  let ratePerHour = 0;
  if (hour.count && hour.firstTs !== null) {
    const spanMs = Math.max(now - hour.firstTs, 60 * 1000);
    ratePerHour = hour.credits / (spanMs / HOUR_MS);
  }

  const remaining = target.creditsRemaining;
  const projectedHours = remaining !== null && ratePerHour > 0 ? remaining / ratePerHour : null;

  const deadlineMs = target.deadline ? Date.parse(target.deadline) : null;
  const hoursLeft = deadlineMs !== null ? Math.max(0, (deadlineMs - now) / HOUR_MS) : null;
  const requiredRatePerHour =
    remaining !== null && hoursLeft !== null && hoursLeft > 0 ? remaining / hoursLeft : null;

  let pace = 'unknown';
  if (requiredRatePerHour !== null && requiredRatePerHour > 0 && ratePerHour > 0) {
    const ratio = ratePerHour / requiredRatePerHour;
    if (ratio >= 1.15) pace = 'ahead';
    else if (ratio >= 0.85) pace = 'on_track';
    else pace = 'behind';
  }

  return {
    creditsLastHour: hour.credits,
    creditsLast6Hours: sixHours.credits,
    creditsLast24Hours: day.credits,
    samplesLastHour: hour.count,
    ratePerHour,
    remaining,
    deadline: target.deadline,
    hoursLeft,
    requiredRatePerHour,
    pace,
    targetUpdatedAt: target.updatedAt,
    projectedHours,
    projectedEmptyAt:
      projectedHours !== null ? new Date(now + projectedHours * HOUR_MS).toISOString() : null,
  };
}

function getUsage() {
  const burnRate = getBurnRate();
  return {
    type: 'local-estimate',
    startedAt: stats.startedAt,
    totalRequests: stats.totalRequests,
    requestsToday: stats.requestsToday,
    requestsByModel: { ...stats.requestsByModel },
    lastRequestAt: stats.lastRequestAt,
    errorCount: stats.errorCount,
    estimatedInputTokens: stats.estimatedInputTokens,
    estimatedOutputTokens: stats.estimatedOutputTokens,
    estimatedTotalTokens: stats.estimatedTotalTokens,
    // Credits reported by the CLI itself. These are usage charges, not the
    // official remaining quota; the quota panel remains the source of truth.
    source: stats.reportedCalls > 0 ? 'cli-reported' : 'none',
    creditsTotal: stats.creditsTotal,
    creditsToday: stats.creditsToday,
    creditsByModel: { ...stats.creditsByModel },
    creditsByProfile: { ...stats.creditsByProfile },
    creditsCostUsd: stats.creditsCostUsd,
    reportedCalls: stats.reportedCalls,
    burnRate,
    officialQuota: {
      supported: false,
      message:
        'Official Qoder quota is not available from this local proxy. Please check it on the official Qoder account page.',
    },
  };
}

function getTarget() {
  return { ...target };
}

function normalizeDeadline(deadline) {
  if (deadline === null || deadline === undefined || deadline === '') return null;
  const text = String(deadline);
  // A bare date means "end of that day" in the server's local timezone.
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T23:59:59`)
    : new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError('deadline must be an ISO date-time or YYYY-MM-DD.');
  }
  return parsed.toISOString();
}

function setTarget(creditsRemaining, deadline) {
  const nextDeadline = deadline === undefined ? target.deadline : normalizeDeadline(deadline);

  if (creditsRemaining === null || creditsRemaining === undefined) {
    target = { creditsRemaining: null, deadline: nextDeadline, updatedAt: new Date().toISOString() };
  } else {
    const value = Number(creditsRemaining);
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('creditsRemaining must be a non-negative number or null.');
    }
    target = { creditsRemaining: value, deadline: nextDeadline, updatedAt: new Date().toISOString() };
  }

  if (!TEST_MODE) {
    try {
      fs.writeFileSync(
        TARGET_FILE,
        JSON.stringify(target, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch (_) {
      // Keep the in-memory target even if persistence fails.
    }
  }
  return getTarget();
}

function resetUsage() {
  stats.startedAt = new Date().toISOString();
  stats.totalRequests = 0;
  stats.requestsToday = 0;
  stats.requestsByModel = {};
  stats.lastRequestAt = null;
  stats.errorCount = 0;
  stats.estimatedInputTokens = 0;
  stats.estimatedOutputTokens = 0;
  stats.estimatedTotalTokens = 0;
  stats.creditsTotal = 0;
  stats.creditsToday = 0;
  stats.creditsByModel = {};
  stats.creditsByProfile = {};
  stats.creditsCostUsd = 0;
  stats.reportedCalls = 0;
  events = [];
  lastResetDate = getToday();

  // Clear persisted files (the manually entered quota target survives).
  for (const file of TEST_MODE ? [] : [USAGE_FILE, EVENTS_FILE]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) {
      // Silent fail
    }
  }
}

function saveUsage() {
  if (TEST_MODE) return;
  try {
    const data = JSON.stringify(getUsage(), null, 2);
    fs.writeFileSync(USAGE_FILE, data, 'utf8');
  } catch (_) {
    // Silent fail
  }
}

function loadUsage() {
  if (TEST_MODE) return;
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      if (data && typeof data === 'object') {
        stats.startedAt = data.startedAt || stats.startedAt;
        stats.totalRequests = data.totalRequests || 0;
        stats.requestsToday = data.requestsToday || 0;
        stats.requestsByModel = data.requestsByModel || {};
        stats.lastRequestAt = data.lastRequestAt || null;
        stats.errorCount = data.errorCount || 0;
        stats.estimatedInputTokens = data.estimatedInputTokens || 0;
        stats.estimatedOutputTokens = data.estimatedOutputTokens || 0;
        stats.estimatedTotalTokens = data.estimatedTotalTokens || 0;
        stats.creditsTotal = data.creditsTotal || 0;
        stats.creditsToday = data.creditsToday || 0;
        stats.creditsByModel = data.creditsByModel || {};
        stats.creditsByProfile = data.creditsByProfile || {};
        stats.creditsCostUsd = data.creditsCostUsd || 0;
        stats.reportedCalls = data.reportedCalls || 0;
        loadedSnapshot = true;
      }
    }
  } catch (_) {
    // Silent fail, use defaults
  }

  try {
    if (fs.existsSync(EVENTS_FILE)) {
      const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split(/\r?\n/);
      events = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event && Number.isFinite(event.ts)) events.push(event);
        } catch (_) {
          // Ignore a truncated tail from an interrupted append.
        }
      }
      pruneEvents(Date.now());
    }
  } catch (_) {
    events = [];
  }

  // Snapshots written before profile metering have no per-profile split.
  // Backfill just that bucket from the retained events; lifetime stays intact.
  if (loadedSnapshot && !Object.keys(stats.creditsByProfile || {}).length && events.length) {
    const byProfile = {};
    for (const event of events) {
      const credits = Number(event.credits) || 0;
      if (!credits) continue;
      const profile = event.profile || 'default';
      byProfile[profile] = (byProfile[profile] || 0) + credits;
    }
    stats.creditsByProfile = byProfile;
  }

  // usage.json is the lifetime source of truth (events age out after 7 days).
  // Rebuild from events only when the snapshot is missing or unreadable.
  if (!loadedSnapshot && events.length) recomputeCreditsFromEvents();

  try {
    if (fs.existsSync(TARGET_FILE)) {
      const data = JSON.parse(fs.readFileSync(TARGET_FILE, 'utf8'));
      const value = Number(data && data.creditsRemaining);
      target = {
        creditsRemaining: Number.isFinite(value) && value >= 0 ? value : null,
        deadline: (data && data.deadline) || null,
        updatedAt: (data && data.updatedAt) || null,
      };
    }
  } catch (_) {
    target = { creditsRemaining: null, updatedAt: null };
  }
}

// Load persisted stats on startup
loadUsage();

// Auto-save every 5 minutes
setInterval(saveUsage, 5 * 60 * 1000).unref();

module.exports = {
  trackRequest,
  getUsage,
  getBurnRate,
  getTarget,
  setTarget,
  resetUsage,
  saveUsage,
  extractTextFromMessages,
};
