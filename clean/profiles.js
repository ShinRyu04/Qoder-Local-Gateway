'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_NAME = 'default';
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

function configFile() {
  return process.env.QODER_PROFILES_FILE || path.join(os.homedir(), '.qorder-proxy', 'profiles.json');
}

function defaultConfig() {
  return {
    active: DEFAULT_NAME,
    rotation: true,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    profiles: [{ name: DEFAULT_NAME, label: 'Default (OAuth ~/.qoder)', home: null }],
  };
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!NAME_RE.test(name)) return null;
  const home = raw.home === null || raw.home === undefined || raw.home === '' ? null : String(raw.home);
  return {
    name,
    label: String(raw.label || name).slice(0, 64),
    home,
  };
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== 'object') return base;

  const seen = new Set();
  const profiles = [];
  for (const entry of Array.isArray(raw.profiles) ? raw.profiles : []) {
    const profile = normalizeProfile(entry);
    if (!profile || seen.has(profile.name)) continue;
    seen.add(profile.name);
    profiles.push(profile);
  }
  if (!profiles.length) profiles.push(...base.profiles);
  if (!seen.has(DEFAULT_NAME)) profiles.unshift(base.profiles[0]);

  const active = profiles.some((profile) => profile.name === raw.active) ? raw.active : profiles[0].name;
  const cooldownMs = Number(raw.cooldownMs);

  return {
    active,
    rotation: raw.rotation !== false,
    cooldownMs: Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : DEFAULT_COOLDOWN_MS,
    profiles,
  };
}

function readConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configFile(), 'utf8')));
  } catch (_) {
    return defaultConfig();
  }
}

function writeConfig(config) {
  const target = configFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function getConfig() {
  return readConfig();
}

function hasAuthDir(authDir) {
  try {
    if (!fs.statSync(authDir).isDirectory()) return false;
    return fs.readdirSync(authDir).some((name) => {
      // `qodercli login` pre-creates these before the browser approves the
      // account, so counting them would report "logged in" too early.
      if (name === '.credential-transaction' || name === 'machine_id') return false;
      if (name.endsWith('.lock') || /^dynamic-/.test(name)) return false;
      try {
        const entry = fs.statSync(path.join(authDir, name));
        return entry.isFile() && entry.size > 0;
      } catch (_) {
        return false;
      }
    });
  } catch (_) {
    return false;
  }
}

function profileAuthDir(profile) {
  const base = profile && profile.home ? profile.home : os.homedir();
  return path.join(base, '.qoder', '.auth');
}

function hasProfileAuth(profile) {
  return hasAuthDir(profileAuthDir(profile));
}

// Profile home directories are isolated by overriding USERPROFILE/HOME on the
// spawned CLI, which is verified to move its `.qoder/.auth` lookup.
function profileEnv(profile) {
  if (!profile || !profile.home) return {};
  const env = { USERPROFILE: profile.home, HOME: profile.home };
  if (process.platform === 'win32') {
    const parsed = path.parse(profile.home);
    env.HOMEDRIVE = parsed.root.replace(/\\$/, '');
    env.HOMEPATH = profile.home.slice(parsed.root.length);
  }
  return env;
}

const cooldowns = new Map();

function markCooldown(name, ms) {
  if (!name) return null;
  const config = readConfig();
  const duration = Number(ms) > 0 ? Number(ms) : config.cooldownMs;
  const until = Date.now() + duration;
  cooldowns.set(name, until);
  return until;
}

function clearCooldown(name) {
  cooldowns.delete(name);
}

function cooldownUntil(name) {
  const until = cooldowns.get(name);
  if (!until) return null;
  if (until <= Date.now()) {
    cooldowns.delete(name);
    return null;
  }
  return until;
}

function getProfile(name) {
  return readConfig().profiles.find((profile) => profile.name === name) || null;
}

function getActiveProfile() {
  const config = readConfig();
  return config.profiles.find((profile) => profile.name === config.active) || config.profiles[0];
}

function setActiveProfile(name) {
  const config = readConfig();
  if (!config.profiles.some((profile) => profile.name === name)) {
    throw new RangeError(`Unknown profile: ${name}`);
  }
  config.active = name;
  writeConfig(config);
  return getProfile(name);
}

function addProfile({ name, label, home }) {
  const config = readConfig();
  const cleanName = String(name || '').trim();
  if (!NAME_RE.test(cleanName)) {
    throw new RangeError('Profile name must match [A-Za-z0-9_-]{1,32}.');
  }
  if (config.profiles.some((profile) => profile.name === cleanName)) {
    throw new RangeError(`Profile already exists: ${cleanName}`);
  }
  if (cleanName === DEFAULT_NAME) {
    throw new RangeError(`"${DEFAULT_NAME}" is reserved.`);
  }
  const providedHome = home === null || home === undefined || home === '' ? null : String(home);
  // Never share the real home with the default profile: an omitted home gets
  // its own isolated directory, so adding an account only needs a name.
  const cleanHome = providedHome
    ? path.resolve(providedHome)
    : path.join(os.homedir(), '.qoder-profiles', cleanName);
  if (!path.isAbsolute(cleanHome)) {
    throw new RangeError('Profile home must be an absolute path.');
  }
  const profile = { name: cleanName, label: String(label || cleanName).slice(0, 64), home: cleanHome };
  config.profiles.push(profile);
  writeConfig(config);
  return profile;
}

function removeProfile(name) {
  const config = readConfig();
  if (name === DEFAULT_NAME) {
    throw new RangeError('The default profile cannot be removed.');
  }
  const before = config.profiles.length;
  config.profiles = config.profiles.filter((profile) => profile.name !== name);
  if (config.profiles.length === before) {
    throw new RangeError(`Unknown profile: ${name}`);
  }
  if (config.active === name) config.active = DEFAULT_NAME;
  cooldowns.delete(name);
  writeConfig(config);
  return config.active;
}

function getPublicProfiles() {
  const config = readConfig();
  return config.profiles.map((profile) => ({
    name: profile.name,
    label: profile.label,
    home: profile.home,
    auth: hasProfileAuth(profile),
    active: profile.name === config.active,
    cooldownUntil: cooldownUntil(profile.name),
  }));
}

/**
 * Ring order for a request: pinned profile only, otherwise healthy profiles
 * starting from the active one and wrapping around. Pinned requests skip
 * rotation entirely, matching the explicit per-request account selector.
 */
function rotationOrder(preferredName) {
  const config = readConfig();
  const pinned = preferredName || process.env.QODER_PROFILE || null;
  if (pinned) {
    const profile = config.profiles.find((entry) => entry.name === pinned);
    if (!profile) throw new RangeError(`Unknown profile: ${pinned}`);
    return [profile];
  }

  const start = config.profiles.findIndex((profile) => profile.name === config.active);
  const ordered = [];
  for (let i = 0; i < config.profiles.length; i += 1) {
    ordered.push(config.profiles[(start + i + config.profiles.length) % config.profiles.length]);
  }

  if (!config.rotation || process.env.QODER_PROFILE_ROTATION === 'off') {
    return [ordered[0]];
  }

  const healthy = ordered.filter((profile) => cooldownUntil(profile.name) === null);
  return healthy.length ? healthy : [ordered[0]];
}

module.exports = {
  DEFAULT_NAME,
  addProfile,
  clearCooldown,
  cooldownUntil,
  configFile,
  getActiveProfile,
  getConfig,
  getProfile,
  getPublicProfiles,
  hasAuthDir,
  hasProfileAuth,
  markCooldown,
  profileAuthDir,
  profileEnv,
  removeProfile,
  rotationOrder,
  setActiveProfile,
};
