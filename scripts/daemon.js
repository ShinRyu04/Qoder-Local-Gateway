#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'clean', 'server.js');
const STATE_DIR = path.join(os.homedir(), '.qorder-proxy');
const PID_FILE = path.join(STATE_DIR, 'proxy.pid');
const LOG_FILE = path.join(STATE_DIR, 'proxy.log');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (data && typeof data === 'object') return data;
  } catch (_) {
    // Missing or invalid config falls back to defaults.
  }
  return {};
}

function resolvePort(config) {
  const value = Number(process.env.PORT || config.port || 3000);
  return Number.isFinite(value) && value > 0 ? value : 3000;
}

function readPid() {
  try {
    const value = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (_) {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  }
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await health(port);
    if (body && body.ok) return body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function start() {
  ensureStateDir();
  const config = readConfig();

  const pid = readPid();
  if (isAlive(pid)) {
    console.log(`qoder-proxy is already running (pid ${pid}).`);
    return 0;
  }

  const port = resolvePort(config);
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(port) },
  });
  child.unref();
  fs.closeSync(out);
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');

  const body = await waitForHealth(port, 5000);
  if (body) {
    console.log(`qoder-proxy started (pid ${child.pid}) at http://127.0.0.1:${port}`);
    console.log(`log: ${LOG_FILE}`);
    return 0;
  }

  console.error(`qoder-proxy spawned (pid ${child.pid}) but /health did not respond on port ${port}.`);
  console.error(`Check the log: ${LOG_FILE}`);
  return 1;
}

async function stop() {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    try {
      fs.rmSync(PID_FILE, { force: true });
    } catch (_) {
      // Ignore.
    }
    console.log('qoder-proxy is not running.');
    return 0;
  }

  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGTERM');
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch (_) {
    // Ignore.
  }

  if (isAlive(pid)) {
    console.error(`qoder-proxy (pid ${pid}) did not exit within 5s.`);
    return 1;
  }
  console.log(`qoder-proxy stopped (pid ${pid}).`);
  return 0;
}

async function status() {
  const config = readConfig();
  const port = resolvePort(config);
  const pid = readPid();

  if (!isAlive(pid)) {
    console.log('qoder-proxy is not running.');
    return 1;
  }

  const body = await health(port);
  if (body) {
    console.log(`qoder-proxy is running (pid ${pid}) at http://127.0.0.1:${port}`);
    return 0;
  }
  console.log(`qoder-proxy process ${pid} is alive but /health on port ${port} is not responding.`);
  return 1;
}

function logs() {
  const count = Math.max(1, Number(process.argv[3] || 50));
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/);
    const tail = lines.slice(-count - 1).join('\n').trimEnd();
    console.log(tail || '(log is empty)');
    return 0;
  } catch (_) {
    console.log('(no log file yet)');
    return 0;
  }
}

async function main() {
  const command = process.argv[2];
  switch (command) {
    case 'start':
      return start();
    case 'stop':
      return stop();
    case 'restart':
      await stop();
      return start();
    case 'status':
      return status();
    case 'logs':
      return logs();
    default:
      console.log('Usage: node scripts/daemon.js <start|stop|restart|status|logs [lines]>');
      console.log(`State: ${STATE_DIR}`);
      return command ? 1 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  });
