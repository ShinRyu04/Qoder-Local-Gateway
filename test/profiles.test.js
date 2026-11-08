const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-profiles-'));
process.env.QODER_PROFILES_FILE = path.join(tmp, 'profiles.json');
process.env.QODERCN_STRICT_MODELS = '1';
process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT || 'test';

const profiles = require('../clean/profiles');
const qoderCli = require('../clean/qodercn-cli');
const models = require('../clean/models');
const usage = require('../clean/usage');

function freshConfig() {
  fs.rmSync(process.env.QODER_PROFILES_FILE, { force: true });
}

test('profile defaults: single default profile, rotation on, 15 minute cooldown', () => {
  freshConfig();
  const config = profiles.getConfig();
  assert.equal(config.active, 'default');
  assert.equal(config.rotation, true);
  assert.equal(config.cooldownMs, 15 * 60 * 1000);
  assert.equal(config.profiles.length, 1);
  assert.equal(config.profiles[0].name, 'default');
  assert.equal(config.profiles[0].home, null);
  assert.equal(profiles.getActiveProfile().name, 'default');
});

test('profile lifecycle persists and validates names', () => {
  freshConfig();
  const home = path.join(tmp, 'work-home');
  profiles.addProfile({ name: 'work', label: 'Work', home });

  const saved = JSON.parse(fs.readFileSync(process.env.QODER_PROFILES_FILE, 'utf8'));
  assert.equal(saved.profiles.length, 2);
  assert.equal(saved.profiles[1].name, 'work');
  assert.equal(saved.profiles[1].home, path.resolve(home));

  const auto = profiles.addProfile({ name: 'auto-home' });
  assert.equal(auto.home, path.join(os.homedir(), '.qoder-profiles', 'auto-home'));
  profiles.removeProfile('auto-home');

  assert.throws(() => profiles.addProfile({ name: 'work', home }), RangeError);
  assert.throws(() => profiles.addProfile({ name: 'default', home }), RangeError);
  assert.throws(() => profiles.addProfile({ name: 'bad name!', home }), RangeError);
  assert.throws(() => profiles.setActiveProfile('missing'), RangeError);

  profiles.setActiveProfile('work');
  assert.equal(profiles.getActiveProfile().name, 'work');
  assert.equal(profiles.removeProfile('work'), 'default');
  assert.throws(() => profiles.removeProfile('default'), RangeError);
  assert.throws(() => profiles.removeProfile('missing'), RangeError);
});

test('auth detection checks the profile home .qoder/.auth directory', () => {
  freshConfig();
  const loggedIn = path.join(tmp, 'auth-home');
  const empty = path.join(tmp, 'empty-home');
  const partial = path.join(tmp, 'partial-home');
  const authDir = path.join(loggedIn, '.qoder', '.auth');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'user'), '{"account":"redacted"}');
  fs.mkdirSync(empty, { recursive: true });

  // qodercli writes these before the browser approves; they must not count.
  const partialDir = path.join(partial, '.qoder', '.auth');
  fs.mkdirSync(partialDir, { recursive: true });
  fs.writeFileSync(path.join(partialDir, '.credential-transaction'), '');
  fs.writeFileSync(path.join(partialDir, 'machine_id'), 'machine');
  fs.writeFileSync(path.join(partialDir, 'dynamic-texts.json'), '{}');

  profiles.addProfile({ name: 'authy', home: loggedIn });
  profiles.addProfile({ name: 'empty', home: empty });
  profiles.addProfile({ name: 'partial', home: partial });

  const byName = Object.fromEntries(
    profiles.getPublicProfiles().map((profile) => [profile.name, profile])
  );
  assert.equal(byName.authy.auth, true);
  assert.equal(byName.empty.auth, false);
  assert.equal(byName.partial.auth, false);
  assert.equal(profiles.hasAuthDir(path.join(tmp, 'does-not-exist')), false);
});

test('profileEnv isolates USERPROFILE and HOME only for non-default profiles', () => {
  const home = path.join(tmp, 'env-home');
  const env = profiles.profileEnv({ name: 'work', home });
  assert.equal(env.USERPROFILE, home);
  assert.equal(env.HOME, home);
  if (process.platform === 'win32') {
    assert.ok(env.HOMEDRIVE);
    assert.ok(env.HOMEPATH);
  }
  assert.deepEqual(profiles.profileEnv({ name: 'default', home: null }), {});
});

test('rotation order starts at active, wraps, and skips cooled profiles', () => {
  freshConfig();
  profiles.addProfile({ name: 'alpha', home: path.join(tmp, 'alpha') });
  profiles.addProfile({ name: 'beta', home: path.join(tmp, 'beta') });
  profiles.clearCooldown('default');
  profiles.setActiveProfile('alpha');

  assert.deepEqual(
    profiles.rotationOrder().map((profile) => profile.name),
    ['alpha', 'beta', 'default']
  );

  profiles.markCooldown('alpha', 60_000);
  assert.deepEqual(
    profiles.rotationOrder().map((profile) => profile.name),
    ['beta', 'default']
  );
  assert.ok(profiles.cooldownUntil('alpha'));

  profiles.clearCooldown('alpha');
  profiles.markCooldown('default', 60_000);
  profiles.markCooldown('beta', 60_000);
  assert.deepEqual(
    profiles.rotationOrder().map((profile) => profile.name),
    ['alpha']
  );

  process.env.QODER_PROFILE_ROTATION = 'off';
  assert.deepEqual(
    profiles.rotationOrder().map((profile) => profile.name),
    ['alpha']
  );
  delete process.env.QODER_PROFILE_ROTATION;

  profiles.clearCooldown('default');
  profiles.clearCooldown('beta');
  profiles.setActiveProfile('default');
});

test('pinned profile disables rotation and rejects unknown names', () => {
  freshConfig();
  profiles.addProfile({ name: 'pinned', home: path.join(tmp, 'pinned') });
  profiles.addProfile({ name: 'other', home: path.join(tmp, 'other') });
  profiles.markCooldown('pinned', 60_000);

  assert.deepEqual(
    profiles.rotationOrder('pinned').map((profile) => profile.name),
    ['pinned']
  );
  assert.throws(() => profiles.rotationOrder('missing'), RangeError);
  profiles.clearCooldown('pinned');
});

test('classifyCliFailure separates auth, quota and generic upstream errors', () => {
  const auth = qoderCli.classifyCliFailure(
    [{ type: 'result', is_error: true, result: 'Not logged in. Please run /login.' }],
    ''
  );
  assert.equal(auth.status, 401);
  assert.equal(auth.code, 'cli_not_authenticated');
  assert.equal(qoderCli.isSwitchableError(auth), true);

  const quota = qoderCli.classifyCliFailure([], 'HTTP 429: rate limit reached');
  assert.equal(quota.status, 429);
  assert.equal(quota.code, 'profile_quota_exhausted');
  assert.equal(qoderCli.isSwitchableError(quota), true);

  const billing = qoderCli.classifyCliFailure([], 'insufficient credits for this model');
  assert.equal(billing.code, 'profile_quota_exhausted');

  const generic = qoderCli.classifyCliFailure([{ type: 'result', is_error: true, result: 'boom' }], '');
  assert.equal(generic.status, 502);
  assert.equal(generic.code, 'upstream_error');
  assert.equal(qoderCli.isSwitchableError(generic), false);

  assert.equal(qoderCli.classifyCliFailure([{ type: 'result', result: 'OK' }], ''), null);
  assert.equal(qoderCli.classifyCliFailure([], ''), null);
});

test('strict mode rejects unknown models instead of falling back to auto', () => {
  assert.throws(
    () => models.resolveModelRoute('definitely-not-a-model'),
    (error) => error.status === 400 && error.code === 'model_not_supported'
  );

  const known = models.resolveModelRoute('glm-5.3');
  assert.equal(known.baseModelId, 'glm-5.3');
  assert.equal(known.reasoningEffort, undefined);

  const effort = models.resolveModelRoute('glm-5.3-effort-high');
  assert.equal(effort.baseModelId, 'glm-5.3');
  assert.equal(effort.reasoningEffort, 'high');
  assert.equal(effort.cliModel, known.cliModel);
});

test('deadline pacing computes required rate and clears cleanly', () => {
  usage.setTarget(120, '2030-01-01');
  const target = usage.getTarget();
  assert.equal(target.creditsRemaining, 120);
  assert.ok(target.deadline);
  assert.ok(Date.parse(target.deadline) > Date.now());

  const burn = usage.getBurnRate();
  assert.ok(burn.hoursLeft > 0);
  assert.ok(burn.requiredRatePerHour > 0);
  assert.equal(burn.pace, 'unknown');
  assert.equal(burn.deadline, target.deadline);

  assert.throws(() => usage.setTarget(120, 'not-a-date'), RangeError);

  usage.setTarget(120, null);
  assert.equal(usage.getTarget().deadline, null);
  assert.equal(usage.getBurnRate().requiredRatePerHour, null);

  usage.setTarget(null, null);
  assert.equal(usage.getTarget().creditsRemaining, null);
});

test('usage payload exposes per-profile credit buckets', () => {
  const payload = usage.getUsage();
  assert.equal(typeof payload.creditsByProfile, 'object');
  assert.ok(payload.creditsByProfile);
});
