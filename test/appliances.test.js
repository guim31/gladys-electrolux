// -----------------------------------------------------------------------------
// The devices built from the real answers of the API: features from the
// capabilities (never a list of models), the states read from the reported
// state, the opening sensor convention, the program and phase texts, the
// timings of a delayed start, the safety of what is writable.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  NO_VALUE,
  alertCodes,
  buildDevice,
  cycleTiming,
  featureDefs,
  humanize,
  isConnected,
  parseAppliance,
  stateValues,
  statusKey,
} from '../src/appliances.js';
import { bodyFor, flattenCapabilities, rangeOf, triggeredRule } from '../src/capabilities.js';
import { familyOf } from '../src/electrolux/constants.js';
import { fixture, idOf } from './helpers/fake-electrolux.js';

const NOW = Date.UTC(2026, 9, 14, 10, 0, 0);
const gladys = createFakeGladys();

/** A fixture appliance, optionally with its reported state changed. */
function load(name, patch = (reported) => reported) {
  const entry = fixture('appliances').find((item) => item.applianceId === idOf(name));
  const state = fixture(`${name}_state`);
  patch(state.properties.reported, state);
  return parseAppliance(entry, fixture(`${name}_details`), state);
}

const keysOf = (appliance) => featureDefs(appliance, 'en').map((def) => def.key);
const values = (appliance, language = 'en') => stateValues(appliance, { language, now: NOW });

test('the families come from the appliance type, the device type as a fallback', () => {
  assert.equal(familyOf('WM'), 'washer');
  assert.equal(familyOf('PUREi9'), 'robot');
  assert.equal(familyOf('Muju'), 'purifier');
  assert.equal(familyOf('XYZ', 'WASHER_DRYER'), 'washer_dryer');
  assert.equal(familyOf('XYZ', 'BUILT-IN OVEN'), 'oven');
  assert.equal(familyOf('XYZ', 'TOASTER'), 'other');
});

test('the capabilities are flattened whatever their shape', () => {
  const wm = flattenCapabilities(fixture('wm_details').capabilities);
  assert.ok(wm['userSelections/programUID'] && wm.doorState && wm.executeCommand);
  const cr = flattenCapabilities(fixture('cr_details').capabilities);
  assert.equal(cr['freezer/targetTemperatureC'].min, -23);
  const dam = flattenCapabilities(fixture('dam_ac_details').capabilities);
  assert.deepEqual(rangeOf(dam['airConditioner/targetTemperature']), { min: 16, max: 32, step: 1 });
  assert.deepEqual(bodyFor('fridge/fastMode', 'ON'), { fridge: { fastMode: 'ON' } });
});

test('a washing machine waiting for its delayed start', () => {
  const wm = load('wm');
  assert.equal(statusKey(wm), 'DELAYED_START');
  assert.deepEqual(keysOf(wm), [
    'status',
    'alerts',
    'program',
    'phase',
    'remaining_time',
    'end_time',
    'start_in',
    'door',
    'remote_start',
  ]);
  // stopTime 4 h, program 30 min: starts in 3 h 30, ends in 4 h.
  assert.deepEqual(cycleTiming(wm), { left: 1800, startIn: 12600, endIn: 14400 });
  const v = values(wm);
  assert.deepEqual(v.status, { text: 'Delayed start' });
  assert.deepEqual(v.program, { text: 'Synthetics' });
  assert.deepEqual(v.phase, { text: NO_VALUE });
  assert.equal(v.remaining_time, 30);
  assert.equal(v.start_in, 210);
  assert.equal(v.door, 1, 'closed door = 1');
  assert.equal(v.remote_start, 0, 'NOT_SAFETY_RELEVANT_ENABLED is not armed');
  assert.ok(
    featureDefs(wm, 'en').every((def) => def.spec.read_only),
    'nothing writable',
  );
});

test('a running cycle: phase, time left and expected end', () => {
  const wm = load('wm', (r) => {
    r.applianceState = 'RUNNING';
    r.cyclePhase = 'SPIN';
    r.timeToEnd = 1500;
    r.stopTime = -1;
  });
  const v = values(wm, 'fr');
  assert.deepEqual(v.status, { text: 'En marche' });
  assert.deepEqual(v.phase, { text: 'Essorage' });
  assert.equal(v.remaining_time, 25);
  assert.equal(v.start_in, 0);
  assert.match(v.end_time.text, /^\d\d:\d\d$/);
});

test('the opening sensor follows Gladys: 0 = open, 1 = closed', () => {
  assert.equal(values(load('dw')).door, 0, 'the fixture dishwasher door is open');
  assert.equal(values(load('dw', (r) => (r.doorState = 'CLOSED'))).door, 1);
});

test('the alerts are named, compartments included', () => {
  const dw = load('dw');
  assert.deepEqual(alertCodes(dw), ['DISH_ALARM_RINSE_AID_LOW', 'DISH_ALARM_SALT_MISSING']);
  assert.deepEqual(values(dw, 'fr').alerts, { text: 'Liquide de rinçage bas, Manque de sel' });
  const cr = load('cr', (r) => r.freezer.alerts.push({ code: 'DOOR_ALARM', severity: 'ALERT' }));
  assert.deepEqual(values(cr, 'de').alerts, { text: 'Tür offen geblieben' });
  assert.deepEqual(values(load('so')).alerts, { text: 'Code 36' });
});

test('an appliance off the cloud publishes its state only', () => {
  const td = load('td');
  assert.equal(isConnected(td), false, 'connectivityState says disconnected');
  assert.deepEqual(values(td, 'fr'), { status: { text: 'Non connecté' } });
});

test('an oven is read only, its light aside; a double oven gets two cavities', () => {
  const ov = load('ov');
  const defs = featureDefs(ov, 'en');
  assert.deepEqual(
    defs.filter((def) => !def.spec.read_only).map((def) => def.key),
    ['light'],
  );
  assert.equal(
    defs.find((d) => d.key === 'target_temperature').spec.category,
    'temperature-sensor',
  );
  // Delayed start without a duration: no expected end.
  assert.deepEqual(values(ov).end_time, { text: NO_VALUE });
  assert.equal(values(ov).temperature, 130);

  const so = load('so');
  const keys = keysOf(so);
  assert.ok(keys.includes('upper_temperature') && keys.includes('lower_temperature'));
  assert.equal(statusKey(so), 'RUNNING', 'the busiest cavity');
  assert.deepEqual(values(so).lower_program, { text: 'Bake' });
  assert.equal(
    featureDefs(so, 'fr').find((d) => d.key === 'lower_temperature').name,
    'Température four du bas',
  );
});

test('a fridge: a setpoint per compartment, from its own range or list', () => {
  const cr = load('cr');
  const defs = featureDefs(cr, 'fr');
  const freezer = defs.find((d) => d.key === 'freezer_target_temperature');
  assert.equal(freezer.spec.category, 'thermostat');
  assert.deepEqual([freezer.spec.min, freezer.spec.max], [-23, -13]);
  assert.equal(freezer.name, 'Consigne congélateur');
  const extra = defs.find((d) => d.key === 'extra_target_temperature');
  assert.deepEqual([extra.spec.min, extra.spec.max], [-2, 7]);
  assert.equal(extra.write.encode(1), 0, 'snapped to the nearest listed value');
  assert.equal(values(cr).freezer_target_temperature, -18);
  assert.equal(values(cr).fridge_fast_mode, 0);
  assert.equal(values(cr).humidity, 51);
});

test('air conditioners, classic and DAM: power, mode, setpoint, fan with their options', () => {
  const ac = load('ac');
  const mode = featureDefs(ac, 'en').find((d) => d.key === 'mode');
  assert.deepEqual(
    mode.spec.supported_options.map((o) => [o.value, o.label]),
    [
      [1, 'Cooling'],
      [4, 'Fan only'],
    ],
    'ECO has no Gladys mode: left out',
  );
  assert.equal(mode.write.encode(4), 'FANONLY');
  assert.equal(values(ac).power, 0);
  assert.equal(values(ac).fan_speed, 1);

  const dam = load('dam_ac');
  const damDefs = featureDefs(dam, 'en');
  assert.equal(damDefs.find((d) => d.key === 'mode').write.encode(1), 'cool');
  assert.equal(damDefs.find((d) => d.key === 'fan_speed').write.encode(3), 'medium');
  assert.equal(damDefs.find((d) => d.key === 'power').write.path, 'airConditioner/executeCommand');
  assert.deepEqual(values(dam).target_temperature, 19);
  assert.equal(values(dam).temperature, 25);
});

test('air purifiers: modes as a list, fan speed, air quality when present', () => {
  const a9 = load('purea9');
  const defs = featureDefs(a9, 'fr');
  assert.deepEqual(
    defs.find((d) => d.key === 'mode').spec.supported_options.map((o) => o.label),
    ['Manuel', 'Auto'],
  );
  const v = values(a9);
  assert.deepEqual(
    [v.power, v.mode, v.fan_speed, v.pm25, v.pm10, v.voc, v.co2, v.humidity, v.filter_life],
    [1, { text: 'Auto' }, 3, 3, 4, 120, 640, 47, 82],
  );
  // Switching on picks the automatic mode, switching off PowerOff.
  const power = defs.find((d) => d.key === 'power');
  assert.equal(power.write.encode(1), 'Auto');
  assert.equal(power.write.encode(0), 'PowerOff');
  // The PM2.5 of a Muju is "approximate", not in its capabilities, still shown.
  assert.equal(values(load('ap')).pm25, 4.5);
});

test('a robot vacuum: state and battery', () => {
  const rvc = load('rvc');
  assert.equal(statusKey(rvc), 'SLEEPING');
  assert.equal(values(rvc).battery, 100);
  assert.equal(statusKey(load('rvc', (r) => (r.robotStatus = 1))), 'CLEANING');
});

test('the device is polled by Gladys once a minute at most, as a fallback', () => {
  const device = buildDevice(gladys, load('wm'), 'fr');
  assert.equal(device.should_poll, true);
  assert.equal(device.poll_frequency, 60000);
  assert.equal(device.name, 'Lave-linge', 'the name given in the Electrolux app');
  const unnamed = parseAppliance(
    { applianceId: 'x', applianceType: 'WM' },
    fixture('wm_details'),
    fixture('wm_state'),
  );
  assert.equal(buildDevice(gladys, unnamed, 'de').name, 'AEG Waschmaschine');
});

test('the triggers of the capabilities say which command is accepted now', () => {
  const caps = flattenCapabilities(fixture('wm_details').capabilities);
  assert.deepEqual(triggeredRule(caps, 'applianceState', 'RUNNING', 'executeCommand'), {
    values: ['PAUSE'],
    disabled: false,
  });
  assert.deepEqual(
    triggeredRule(caps, 'applianceState', 'PAUSED', 'executeCommand').values.sort(),
    ['RESUME', 'STOPRESET'],
  );
  assert.equal(triggeredRule(caps, 'applianceState', 'RUNNING', 'nothing'), null);
});

test('program codes read like words', () => {
  assert.equal(humanize('COTTON_PR_ECO40-60'), 'Eco40-60');
  assert.equal(humanize('TRUE_FAN'), 'True fan');
  assert.equal(humanize(''), '');
});
