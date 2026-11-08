const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const qoderCli = require('../clean/qodercn-cli');
const { createApp } = require('../clean/app');
const {
  resetUsage,
  getUsage,
  getBurnRate,
  setTarget,
  trackRequest,
} = require('../clean/usage');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

const RESULT_RECORD = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'OK',
  total_cost_usd: 0,
  total_credits: 0.32162142857142856,
  usage: { input_tokens: 0, output_tokens: 0 },
  modelUsage: {
    qmodel_38max: {
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      credits: 0.32162142857142856,
    },
  },
};

test('extractCliUsage reads total_credits and model breakdown', () => {
  const usage = qoderCli.extractCliUsage([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } },
    RESULT_RECORD,
  ]);

  assert.equal(usage.credits, 0.32162142857142856);
  assert.equal(usage.costUsd, 0);
  assert.equal(usage.models.qmodel_38max.credits, 0.32162142857142856);
  // qodercli currently reports zero tokens under plan metering.
  assert.equal(usage.tokensAvailable, false);
});

test('extractCliUsage ignores records without usage data', () => {
  const usage = qoderCli.extractCliUsage([{ type: 'assistant' }, { type: 'result', result: 'x' }]);
  assert.equal(usage.credits, 0);
  assert.deepEqual(usage.models, {});
  assert.equal(usage.tokensAvailable, false);
});

test('mergeCliUsage accumulates credits across tool-loop turns', () => {
  const first = qoderCli.extractCliUsage([RESULT_RECORD]);
  const second = qoderCli.extractCliUsage([
    { type: 'result', total_credits: 0.5, total_cost_usd: 0.01, modelUsage: { m: { credits: 0.5, costUSD: 0.01 } } },
  ]);
  const total = qoderCli.mergeCliUsage(first, second);

  assert.ok(Math.abs(total.credits - 0.8216214285714286) < 1e-12);
  assert.equal(total.costUsd, 0.01);
  assert.equal(total.models.qmodel_38max.credits, 0.32162142857142856);
  assert.equal(total.models.m.credits, 0.5);
});

test('global backend accepts OAuth state without a token env var', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-auth-'));
  const authDir = path.join(temp, '.auth');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'user'), '{"token":"x"}');

  const backend = {
    name: 'global',
    command: 'qodercli',
    homeDir: temp,
    tokenEnvVar: 'QODER_PAT_TEST_ONLY',
  };

  const previous = process.env.QODER_PAT_TEST_ONLY;
  delete process.env.QODER_PAT_TEST_ONLY;
  try {
    assert.equal(qoderCli.hasCliAuth(backend), true);
    assert.equal(qoderCli.resolveCliToken(backend), '');
  } finally {
    if (previous !== undefined) process.env.QODER_PAT_TEST_ONLY = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('missing global OAuth state yields a clear 401', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-noauth-'));
  const backend = {
    name: 'global',
    command: 'qodercli',
    homeDir: temp,
    tokenEnvVar: 'QODER_PAT_TEST_ONLY',
  };

  const previous = process.env.QODER_PAT_TEST_ONLY;
  delete process.env.QODER_PAT_TEST_ONLY;
  try {
    assert.equal(qoderCli.hasCliAuth(backend), false);
    assert.throws(
      () => qoderCli.resolveCliToken(backend),
      (error) => error.status === 401 && error.code === 'cli_token_missing' && /login/.test(error.message)
    );
  } finally {
    if (previous !== undefined) process.env.QODER_PAT_TEST_ONLY = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('usage accumulates CLI credits and projects burn-down', () => {
  resetUsage();
  setTarget(2000);
  try {
    trackRequest({
      model: 'qwen3.8-max',
      inputText: 'hi',
      outputText: 'ok',
      isError: false,
      cliUsage: {
        credits: 1.5,
        costUsd: 0.02,
        models: {},
        inputTokens: 0,
        outputTokens: 0,
        tokensAvailable: false,
      },
    });

    const usage = getUsage();
    assert.equal(usage.creditsTotal, 1.5);
    assert.equal(usage.creditsToday, 1.5);
    assert.equal(usage.creditsByModel['qwen3.8-max'], 1.5);
    assert.equal(usage.source, 'cli-reported');

    const burn = getBurnRate();
    assert.equal(burn.remaining, 2000);
    assert.ok(burn.ratePerHour > 0);
    assert.ok(burn.projectedHours > 0);
  } finally {
    resetUsage();
    setTarget(null);
  }
});

test('chat request records credits reported by the CLI', async () => {
  const originalRun = qoderCli.runQoderCnCli;
  qoderCli.runQoderCnCli = async ({ onUsage }) => {
    if (onUsage) {
      onUsage({
        credits: 0.25,
        costUsd: 0.001,
        models: { qmodel_test: { credits: 0.25, costUsd: 0.001, inputTokens: 0, outputTokens: 0 } },
        inputTokens: 0,
        outputTokens: 0,
        tokensAvailable: false,
      });
    }
    return 'OK';
  };
  resetUsage();

  const { server, baseUrl } = await listen(createApp());
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.8-max',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);

    const usage = await (await fetch(`${baseUrl}/usage/local`)).json();
    assert.equal(usage.creditsTotal, 0.25);
    assert.equal(usage.creditsByModel['qwen3.8-max'], 0.25);
    assert.equal(usage.source, 'cli-reported');
  } finally {
    qoderCli.runQoderCnCli = originalRun;
    resetUsage();
    server.close();
  }
});

test('usage target endpoint stores the remaining balance', async () => {
  resetUsage();
  const { server, baseUrl } = await listen(createApp());
  try {
    const saved = await fetch(`${baseUrl}/usage/target`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creditsRemaining: 1234.5 }),
    });
    assert.equal(saved.status, 200);
    const burn = await saved.json();
    assert.equal(burn.remaining, 1234.5);

    const read = await (await fetch(`${baseUrl}/usage/burn-rate`)).json();
    assert.equal(read.remaining, 1234.5);
  } finally {
    setTarget(null);
    server.close();
  }
});
