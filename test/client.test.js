// -----------------------------------------------------------------------------
// The Electrolux client against the fake API: the rotating refresh token kept
// in /data (and replaced when the user pastes a new one), the refused tokens,
// the quota (local ceiling, 429), the DAM command shape. No network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMAND_CEILING,
  QuotaError,
  READ_CEILING,
  ReauthorizationRequiredError,
  commandBody,
  createElectroluxClient,
  jwtExpiry,
} from '../src/electrolux/client.js';
import { createTokenStore, fingerprint } from '../src/electrolux/token-store.js';
import {
  API_KEY,
  FIRST_REFRESH,
  createFakeElectrolux,
  idOf,
  makeJwt,
} from './helpers/fake-electrolux.js';

async function setup({ config = { api_key: API_KEY, refresh_token: FIRST_REFRESH }, now } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'electrolux-client-'));
  const fake = createFakeElectrolux();
  const current = { ...config };
  const store = createTokenStore({ dir });
  const client = createElectroluxClient({
    getConfig: () => current,
    store,
    fetch: fake.fetch,
    minGapMs: 0,
    ...(now ? { now } : {}),
  });
  return {
    dir,
    fake,
    store,
    client,
    config: current,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test('the first call refreshes the token, and the new pair is kept in /data (mode 600)', async () => {
  const s = await setup();
  try {
    const list = await s.client.getAppliances();
    assert.equal(list.length, 15);
    assert.equal(s.fake.refreshCount, 1);
    const saved = JSON.parse(await readFile(s.store.file, 'utf8'));
    assert.equal(saved.refresh_token, 'refresh-1');
    assert.equal(saved.seed, fingerprint(FIRST_REFRESH));
    assert.ok(!JSON.stringify(saved).includes(FIRST_REFRESH), 'the pasted token is not stored');
    assert.equal((await stat(s.store.file)).mode & 0o777, 0o600);
    // The access token is reused while it is valid: no second refresh.
    await s.client.getState(idOf('wm'));
    assert.equal(s.fake.refreshCount, 1);
  } finally {
    await s.close();
  }
});

test('after a restart the stored refresh token wins over the configured one, already spent', async () => {
  const s = await setup();
  try {
    await s.client.getAppliances();
    const restarted = createElectroluxClient({
      getConfig: () => s.config,
      store: createTokenStore({ dir: s.dir }),
      fetch: s.fake.fetch,
      minGapMs: 0,
    });
    // The access token in /data is still valid: no refresh at all.
    await restarted.getAppliances();
    assert.equal(s.fake.refreshCount, 1);
    // Expired: refreshed from the stored token (refresh-1), not the pasted one.
    s.fake.validAccess = 'revoked';
    await restarted.getAppliances();
    assert.equal(s.fake.refreshCount, 2);
    assert.equal(s.fake.requests.filter((r) => r.body?.refreshToken === FIRST_REFRESH).length, 1);
  } finally {
    await s.close();
  }
});

test('a new refresh token pasted in the configuration replaces the stored pair', async () => {
  const s = await setup();
  try {
    await s.client.getAppliances();
    // The user created a new pair on the portal (the fake accepts it).
    s.fake.validRefresh = 'refresh-new';
    s.config.refresh_token = 'refresh-new';
    s.fake.validAccess = 'revoked';
    s.client.reset();
    await s.client.getAppliances();
    const saved = JSON.parse(await readFile(s.store.file, 'utf8'));
    assert.equal(saved.seed, fingerprint('refresh-new'));
  } finally {
    await s.close();
  }
});

test('a refused refresh token asks for a new pair', async () => {
  const s = await setup({ config: { api_key: API_KEY, refresh_token: 'not-a-valid-token' } });
  try {
    await assert.rejects(s.client.getAppliances(), ReauthorizationRequiredError);
    await assert.rejects(
      setup({ config: { api_key: '', refresh_token: '' } }).then((t) =>
        t.client.getAppliances().finally(t.close),
      ),
      ReauthorizationRequiredError,
    );
  } finally {
    await s.close();
  }
});

test('a wrong API key is refused cleanly, without a token in the message', async () => {
  const s = await setup({ config: { api_key: 'wrong-key', refresh_token: FIRST_REFRESH } });
  try {
    const err = await s.client.getAppliances().catch((error) => error);
    assert.ok(err instanceof ReauthorizationRequiredError);
    assert.match(err.message, /HTTP 403/);
    assert.ok(!err.message.includes(FIRST_REFRESH));
  } finally {
    await s.close();
  }
});

test('an access token rejected early is refreshed once and the call retried', async () => {
  const s = await setup();
  try {
    await s.client.getAppliances();
    s.fake.validAccess = makeJwt(Math.floor(Date.now() / 1000) + 3600, 'server-side');
    const state = await s.client.getState(idOf('cr'));
    assert.equal(state.applianceId, idOf('cr'));
    assert.equal(s.fake.refreshCount, 2);
  } finally {
    await s.close();
  }
});

test('a 429 pauses every read until Retry-After, then the calls resume', async () => {
  let clock = Date.now();
  const s = await setup({ now: () => clock });
  try {
    await s.client.getAppliances();
    s.fake.restStatus = 429;
    await assert.rejects(s.client.getAppliances(), QuotaError);
    s.fake.restStatus = 200;
    const before = s.fake.requests.length;
    await assert.rejects(s.client.getAppliances(), QuotaError);
    assert.equal(s.fake.requests.length, before, 'nothing sent while paused');
    clock += 601_000;
    assert.equal((await s.client.getAppliances()).length, 15);
  } finally {
    await s.close();
  }
});

test('the reads stop at 80 % of the daily quota, the commands keep a margin', async () => {
  let clock = Date.now();
  const s = await setup({ now: () => clock });
  try {
    await s.client.getAppliances();
    // Fill the 24 h window locally (reads are cheap on the fake).
    while (s.client.callsToday() < READ_CEILING) {
      await s.client.getState(idOf('wm'));
    }
    await assert.rejects(s.client.getState(idOf('wm')), QuotaError);
    await s.client.sendCommand(idOf('ac'), { executeCommand: 'ON' });
    assert.ok(READ_CEILING < COMMAND_CEILING);
    // A day later the window is empty again.
    clock += 24 * 3600 * 1000 + 1;
    await s.client.getState(idOf('wm'));
  } finally {
    await s.close();
  }
});

test('the DAM appliances take their command wrapped in a list', async () => {
  assert.deepEqual(commandBody('1:9000_00:1-0A', { airConditioner: { mode: 'cool' } }), {
    commands: [{ airConditioner: { mode: 'cool' } }],
  });
  assert.deepEqual(commandBody('9000_00:1-0A', { mode: 'COOL' }), { mode: 'COOL' });
  const s = await setup();
  try {
    await s.client.sendCommand(idOf('dam_ac'), { airConditioner: { executeCommand: 'on' } });
    assert.deepEqual(s.fake.commands.at(-1).body, {
      commands: [{ airConditioner: { executeCommand: 'on' } }],
    });
  } finally {
    await s.close();
  }
});

test('the expiry of an access token is read from the JWT', () => {
  assert.equal(jwtExpiry(makeJwt(1_800_000_000)), 1_800_000_000_000);
  assert.equal(jwtExpiry('not-a-jwt'), null);
});
