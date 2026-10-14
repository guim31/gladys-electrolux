// -----------------------------------------------------------------------------
// The integration end to end, on the SDK's fake Gladys and a fake Electrolux:
// the reads by the container's own timer (without onPoll), the live stream,
// the scene triggers, the commands, the quota, quiet logs and no secret in them.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { QUOTA } from '../src/electrolux/constants.js';
import {
  HEARTBEAT_MS,
  READ_BUDGET_PER_DAY,
  TRIGGERS,
  WIDGET_KEY,
  fallbackPeriod,
} from '../src/hub.js';
import { API_KEY, FIRST_REFRESH, idOf } from './helpers/fake-electrolux.js';
import { CONFIG, createWorld, waitFor } from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

/** Put the fixture washing machine in a running cycle (on the fake's side). */
function runWasher(world, { left = 1500 } = {}) {
  const r = world.electrolux.states[idOf('wm')].properties.reported;
  r.applianceState = 'RUNNING';
  r.cyclePhase = 'WASH';
  r.timeToEnd = left;
  r.stopTime = -1;
  r.remoteControl = 'ENABLED';
  return r;
}

test('nothing is read nor published before the key and the token are filled in', async () => {
  const world = await createWorld({ config: { language: 'en' } });
  try {
    assert.deepEqual(world.gladys.fake.discoveredDevices, []);
    assert.equal(world.electrolux.requests.length, 0);
    assert.equal(world.gladys.fake.connectionStatus.connected, false);
    assert.match(world.gladys.fake.connectionStatus.message.en, /API key and the refresh token/);
    const widget = await world.gladys.fake.widgetGet(WIDGET_KEY, { settings: {}, language: 'fr' });
    assert.match(widget.data.content.components[0].text, /clé d'API/);
  } finally {
    await world.close();
  }
});

test('a refused refresh token asks for a new pair, once', async () => {
  const world = await createWorld({ config: { ...CONFIG, refresh_token: 'spent-token' } });
  try {
    assert.equal(world.gladys.fake.connectionStatus.connected, false);
    assert.match(world.gladys.fake.connectionStatus.message.fr, /nouvelle paire de jetons/);
    await world.app.hub.refresh();
    assert.equal(world.logger.at('warn').length, 1);
  } finally {
    await world.close();
  }
});

test('the states of the added devices are published, the others are not', async () => {
  const world = await createWorld({ addAll: false });
  try {
    assert.equal(world.gladys.fake.states.length, 0);
    assert.equal(world.gladys.fake.connectionStatus.connected, true);
    const fridge = world.device('cr');
    await world.gladys.fake.deviceCreated(fridge);
    assert.ok(world.gladys.fake.states.length > 0);
    assert.ok(
      world.gladys.fake.states.every((s) =>
        s.device_feature_external_id.startsWith(fridge.external_id),
      ),
    );
    assert.equal(
      world.gladys.fake.lastState(world.feature('cr', 'freezer_target_temperature')),
      -18,
    );
    assert.ok(world.gladys.fake.widgetRefreshes.includes(WIDGET_KEY));
    assert.deepEqual(world.gladys.fake.transports.at(-1), {
      device_external_id: fridge.external_id,
      transport: 'cloud',
    });
  } finally {
    await world.close();
  }
});

test('the container refreshes the states by itself, without onPoll', async () => {
  const world = await createWorld({
    app: { timers: true, hubOptions: { periods: { fallbackMs: 30, streamingMs: 30 } } },
  });
  try {
    const remaining = world.feature('wm', 'remaining_time');
    assert.equal(world.gladys.fake.lastState(remaining), 30);
    runWasher(world, { left: 540 });
    await waitFor(() => world.gladys.fake.lastState(remaining) === 9, { label: 'timer refresh' });
    // No onPoll was ever called: the fake records every message it sent.
    assert.ok(!world.gladys.fake.wsMessages.some((m) => JSON.stringify(m).includes('"poll"')));
  } finally {
    await world.close();
  }
});

test('the capabilities are read once per appliance, the states at every read', async () => {
  const world = await createWorld();
  try {
    const infos = () => world.electrolux.count((r) => r.path.endsWith('/info'));
    const states = () => world.electrolux.count((r) => r.path.endsWith('/state'));
    assert.equal(infos(), 15);
    await world.app.hub.refresh();
    assert.equal(infos(), 15, 'no second read of the capabilities');
    assert.equal(states(), 30);
    // A firmware update changes the capability hash: read them again.
    world.electrolux.states[idOf('dw')].properties.reported.applianceInfo.capabilityHash = 'new';
    await world.app.hub.refresh();
    assert.equal(infos(), 16);
  } finally {
    await world.close();
  }
});

test('onPoll is a fallback that skips when the container read recently', async () => {
  const world = await createWorld();
  try {
    const reads = () => world.electrolux.count('/api/v1/appliances');
    const before = reads();
    const ack = await world.gladys.fake.poll(world.device('wm'));
    assert.equal(ack.success, true);
    assert.equal(reads(), before);
  } finally {
    await world.close();
  }
});

test('the reading pace keeps to the quota whatever the number of appliances', () => {
  for (const count of [1, 3, 15, 40]) {
    const period = fallbackPeriod(count);
    assert.ok(period >= 2 * 60 * 1000);
    const callsPerDay = (86_400_000 / period) * (1 + count);
    assert.ok(callsPerDay <= READ_BUDGET_PER_DAY + 1, `${count} appliances: ${callsPerDay}/day`);
  }
  assert.ok(READ_BUDGET_PER_DAY <= QUOTA.PER_DAY / 2);
});

test('only the changes are published, with a heartbeat well under 12 hours', async (t) => {
  const world = await createWorld();
  try {
    const calls = [];
    const original = world.gladys.publishChangedStates.bind(world.gladys);
    t.mock.method(world.gladys, 'publishChangedStates', (states, options) => {
      calls.push(options);
      return original(states, options);
    });
    const count = world.gladys.fake.states.length;
    await world.app.hub.refresh();
    assert.equal(world.gladys.fake.states.length, count, 'an unchanged read publishes nothing');
    assert.ok(calls.length > 0 && calls.every((options) => options.heartbeat === HEARTBEAT_MS));
    assert.ok(HEARTBEAT_MS <= 12 * 3600 * 1000);
  } finally {
    await world.close();
  }
});

test('the live stream brings the changes, and "cycle finished" fires once per transition', async () => {
  const world = await createWorld({ app: { stream: true } });
  try {
    await waitFor(() => world.app.hub.streamUp, { label: 'stream' });
    const id = idOf('wm');
    world.electrolux.push(id, 'applianceState', 'RUNNING');
    world.electrolux.push(id, 'timeToEnd', 600);
    world.electrolux.push(id, 'stopTime', -1);
    await waitFor(() => world.gladys.fake.lastState(world.feature('wm', 'remaining_time')) === 10, {
      label: 'stream update',
    });
    assert.deepEqual(world.gladys.fake.sceneEvents, [], 'nothing fired at startup');

    world.electrolux.push(id, 'applianceState', 'END_OF_CYCLE');
    world.electrolux.push(id, 'timeToEnd', 0);
    await waitFor(() => world.gladys.fake.sceneEvents.length === 1, { label: 'trigger' });
    const [event] = world.gladys.fake.sceneEvents;
    assert.equal(event.key, TRIGGERS.FINISHED);
    assert.deepEqual(event.data, {
      device: world.device('wm').external_id,
      device_name: 'Lave-linge',
      program: 'Synthetics',
    });
    assert.equal(world.gladys.fake.lastState(world.feature('wm', 'status')), 'Terminé');
    // The data carries the declared filter fields and variables, nothing else.
    const declared = manifest.scene_triggers.find((t) => t.key === TRIGGERS.FINISHED);
    assert.deepEqual(
      Object.keys(event.data).sort(),
      [...declared.fields, ...declared.variables].map((f) => f.key).sort(),
    );

    // The same state again (stream, then a read): no second event.
    world.electrolux.push(id, 'applianceState', 'END_OF_CYCLE');
    world.electrolux.states[id].properties.reported.applianceState = 'END_OF_CYCLE';
    await world.app.hub.refresh();
    assert.equal(world.gladys.fake.sceneEvents.length, 1);
  } finally {
    await world.close();
  }
});

test('a program that runs out back to idle counts as finished, a stop at mid-cycle not', async () => {
  const world = await createWorld();
  try {
    const r = runWasher(world, { left: 60 });
    await world.app.hub.refresh();
    r.applianceState = 'IDLE';
    await world.app.hub.refresh();
    assert.deepEqual(
      world.gladys.fake.sceneEvents.map((e) => e.key),
      [TRIGGERS.FINISHED],
    );
    runWasher(world, { left: 3000 });
    await world.app.hub.refresh();
    r.applianceState = 'IDLE';
    await world.app.hub.refresh();
    assert.equal(world.gladys.fake.sceneEvents.length, 1);
  } finally {
    await world.close();
  }
});

test('a new alert fires "appliance alert" once, with its words and code', async () => {
  const world = await createWorld();
  try {
    const alerts = world.electrolux.states[idOf('cr')].properties.reported.freezer.alerts;
    alerts.push({ code: 'DOOR_ALARM', severity: 'ALERT', acknowledgeStatus: 'NOT_NEEDED' });
    await world.app.hub.refresh();
    await world.app.hub.refresh();
    assert.deepEqual(
      world.gladys.fake.sceneEvents.map((e) => [
        e.key,
        e.data.device_name,
        e.data.alert,
        e.data.code,
      ]),
      [[TRIGGERS.ALERT, 'Réfrigérateur', 'Porte restée ouverte', 'DOOR_ALARM']],
    );
    const declared = manifest.scene_triggers.find((t) => t.key === TRIGGERS.ALERT);
    assert.deepEqual(
      Object.keys(world.gladys.fake.sceneEvents[0].data).sort(),
      [...declared.fields, ...declared.variables].map((f) => f.key).sort(),
    );
  } finally {
    await world.close();
  }
});

test('an appliance that drops off the cloud gets the unreachable badge', async () => {
  const world = await createWorld();
  try {
    world.electrolux.states[idOf('dw')].properties.reported.connectivityState = 'disconnected';
    await world.app.hub.refresh();
    assert.deepEqual(world.gladys.fake.transports.at(-1), {
      device_external_id: world.device('dw').external_id,
      transport: 'unreachable',
    });
    assert.equal(world.gladys.fake.lastState(world.feature('dw', 'status')), 'Non connecté');
    assert.ok(
      world.logger.at('info').some((line) => /not connected to the Electrolux cloud/.test(line)),
    );
  } finally {
    await world.close();
  }
});

test('a new appliance appearing in the stream is published at the next read', async () => {
  let clock = Date.now();
  const world = await createWorld({
    electrolux: { names: ['wm'] },
    app: { stream: true, now: () => clock },
  });
  try {
    await waitFor(() => world.app.hub.streamUp, { label: 'stream' });
    assert.equal(world.gladys.fake.discoveredDevices.length, 1);
    const fake = world.electrolux;
    const { fixture } = await import('./helpers/fake-electrolux.js');
    const entry = fixture('appliances').find((a) => a.applianceId === idOf('ac'));
    fake.appliances.push(entry);
    fake.infos[entry.applianceId] = fixture('ac_details');
    fake.states[entry.applianceId] = fixture('ac_state');
    clock += 6 * 60 * 1000;
    fake.push(entry.applianceId, 'applianceState', 'RUNNING');
    await waitFor(() => world.gladys.fake.discoveredDevices.length === 2, {
      label: 'new appliance',
    });
  } finally {
    await world.close();
  }
});

test('a feature command goes to Electrolux, a refused one tells why', async () => {
  const world = await createWorld();
  try {
    const fridge = world.device('cr');
    const setpoint = fridge.features.find((f) =>
      f.external_id.endsWith(':freezer_target_temperature'),
    );
    const ack = await world.gladys.fake.setValue(fridge, setpoint, -20);
    assert.equal(ack.success, true);
    assert.deepEqual(world.electrolux.commands.at(-1), {
      id: idOf('cr'),
      body: { freezer: { targetTemperatureC: -20 } },
    });
    assert.ok(
      world.logger
        .at('info')
        .includes('Command freezer_target_temperature=-20 sent to Réfrigérateur'),
    );
    // Stream down: the appliance is read again shortly after the command.
    const states = () => world.electrolux.count((r) => r.path.endsWith(`/state`));
    const before = states();
    await waitFor(() => states() === before + 1, { label: 'read after command' });

    world.electrolux.commandStatus = 400;
    const refused = await world.gladys.fake.setValue(fridge, setpoint, -19);
    assert.equal(refused.success, false);
    assert.match(refused.error, /Electrolux a refusé la commande \(HTTP 400\)/);

    const sent = world.electrolux.commands.length;
    const oven = world.device('ov');
    const light = oven.features.find((f) => f.external_id.endsWith(':light'));
    assert.equal(light.read_only, false);
    const notConnected = await world.gladys.fake.setValue(
      world.device('td'),
      world.device('td').features[0],
      1,
    );
    assert.equal(notConnected.success, false);
    assert.equal(world.electrolux.commands.length, sent, 'nothing sent');
  } finally {
    await world.close();
  }
});

test('the scene action starts a washing machine only when allowed, never an oven', async () => {
  const world = await createWorld();
  try {
    const r = world.electrolux.states[idOf('wm')].properties.reported;
    r.applianceState = 'READY_TO_START';
    r.remoteControl = 'ENABLED';
    await world.app.hub.refresh();
    const washer = world.device('wm');
    const off = await world.gladys.fake.sceneAction('appliance_command', {
      device: washer.external_id,
      command: 'start',
    });
    assert.equal(off.success, false);
    assert.match(off.error, /départ à distance est désactivé/);
    assert.equal(world.electrolux.commands.length, 0);

    await world.gladys.fake.configUpdated({ ...CONFIG, allow_remote_start: 'true' });
    const ok = await world.gladys.fake.sceneAction('appliance_command', {
      device: washer.external_id,
      command: 'start',
    });
    assert.deepEqual(ok, { success: true, data: { outputs: { sent: true } } });
    assert.deepEqual(world.electrolux.commands.at(-1), {
      id: idOf('wm'),
      body: { executeCommand: 'START' },
    });

    const oven = await world.gladys.fake.sceneAction('appliance_command', {
      device: world.device('ov').external_id,
      command: 'start',
    });
    assert.equal(oven.success, false);
    assert.match(oven.error, /rien qui chauffe/);
    assert.equal(world.electrolux.commands.length, 1);
  } finally {
    await world.close();
  }
});

test('the connection test lists the appliances and the calls of the day', async () => {
  const world = await createWorld({ config: { ...CONFIG, language: 'en' } });
  try {
    const ack = await world.gladys.fake.action('test_connection', {});
    assert.equal(ack.success, true);
    assert.match(ack.data.message.fr, /^Connecté à Electrolux : 15 appareil\(s\) : Lave-linge/);
    assert.match(ack.data.message.en, /\d+ API calls in the last 24 h/);
    world.electrolux.restStatus = 0;
    const failed = await world.gladys.fake.action('test_connection', {});
    assert.equal(failed.success, false);
    assert.match(failed.error, /Electrolux cannot be reached: network/);
  } finally {
    await world.close();
  }
});

test('an Electrolux outage is reported once, and its end once', async () => {
  const world = await createWorld();
  try {
    world.logger.clear();
    world.electrolux.restStatus = 503;
    await world.app.hub.refresh();
    await world.app.hub.refresh();
    await world.app.hub.refresh();
    assert.equal(world.logger.at('warn').length, 1);
    assert.equal(world.gladys.fake.connectionStatus.connected, false);
    world.electrolux.restStatus = 200;
    await world.app.hub.refresh();
    assert.deepEqual(world.logger.at('info'), ['Electrolux cloud reachable again']);
    assert.equal(world.gladys.fake.connectionStatus.connected, true);
  } finally {
    await world.close();
  }
});

test('a 429 pauses the reads, says so once in the configuration screen', async () => {
  const world = await createWorld();
  try {
    world.logger.clear();
    world.electrolux.restStatus = 429;
    await world.app.hub.refresh();
    world.electrolux.restStatus = 200;
    const before = world.electrolux.requests.length;
    await world.app.hub.refresh();
    assert.equal(world.electrolux.requests.length, before, 'no call while paused');
    assert.equal(world.logger.at('warn').length, 1);
    assert.match(world.gladys.fake.connectionStatus.message.fr, /Quota de l'API Electrolux/);
  } finally {
    await world.close();
  }
});

test('a normal cycle writes nothing at info level, and no secret ever reaches the logs', async () => {
  const world = await createWorld({ app: { stream: true } });
  try {
    await waitFor(() => world.app.hub.streamUp, { label: 'stream' });
    const startup = world.logger.lines.length;
    world.logger.lines.splice(0); // the startup lines (life cycle) are allowed
    assert.ok(startup > 0);

    // A normal cycle: a read, stream changes, the widget, a poll.
    runWasher(world, { left: 900 });
    await world.app.hub.refresh();
    world.electrolux.push(idOf('wm'), 'timeToEnd', 840);
    await waitFor(() => world.gladys.fake.lastState(world.feature('wm', 'remaining_time')) === 14, {
      label: 'stream update',
    });
    await world.gladys.fake.widgetGet(WIDGET_KEY, {
      settings: {},
      language: 'fr',
      units: 'metric',
    });
    await world.gladys.fake.poll(world.device('wm'));
    assert.deepEqual(world.logger.at('info'), []);
    assert.deepEqual(world.logger.at('warn'), []);

    // Secrets: the API key and every token, at every level, whole run.
    world.electrolux.closeStreams();
    world.electrolux.validAccess = 'revoked';
    world.electrolux.validRefresh = 'nothing-matches';
    await world.app.hub.refresh();
    const everything = world.logger.lines.map((line) => line.text).join('\n');
    const secrets = [API_KEY, FIRST_REFRESH, 'refresh-1', 'refresh-2'];
    for (const secret of secrets) {
      assert.ok(!everything.includes(secret), `"${secret}" found in the logs`);
    }
    assert.ok(!/eyJ[\w-]+\.[\w-]+/.test(everything), 'an access token found in the logs');
  } finally {
    await world.close();
  }
});

test('a new language republishes the texts in it', async () => {
  const world = await createWorld();
  try {
    const status = world.feature('wm', 'status');
    assert.equal(world.gladys.fake.lastState(status), 'Départ différé');
    await world.gladys.fake.configUpdated({ ...CONFIG, language: 'de' });
    assert.equal(world.gladys.fake.lastState(status), 'Startaufschub');
  } finally {
    await world.close();
  }
});
