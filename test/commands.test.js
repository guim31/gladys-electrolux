// -----------------------------------------------------------------------------
// The gates of the commands, pinned without network: nothing that heats is
// started or resumed, a washing machine starts only with the integration's
// consent AND remote start armed on it, a command is refused with a clear
// message when the appliance does not accept it now.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppliance } from '../src/appliances.js';
import { CommandError } from '../src/command-error.js';
import { PROGRAM_COMMANDS, featureCommand, programCommand } from '../src/commands.js';
import { COMMAND_TEXT } from '../src/i18n.js';
import { fixture, idOf } from './helpers/fake-electrolux.js';

function load(name, patch = () => {}) {
  const entry = fixture('appliances').find((item) => item.applianceId === idOf(name));
  const state = fixture(`${name}_state`);
  patch(state.properties.reported);
  return parseAppliance(entry, fixture(`${name}_details`), state);
}

const ready = (r) => {
  r.applianceState = 'READY_TO_START';
  r.remoteControl = 'ENABLED';
};
const EN = { language: 'en', allowRemoteStart: true };

/** The message a refused command carries. */
function refusal(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CommandError, err.message);
    return err.message;
  }
  assert.fail('the command was not refused');
}

test('a washing machine starts with consent, remote start armed and ready', () => {
  assert.deepEqual(programCommand(load('wm', ready), 'start', EN), { executeCommand: 'START' });
  assert.equal(
    refusal(() => programCommand(load('wm', ready), 'start', { ...EN, allowRemoteStart: false })),
    COMMAND_TEXT.remoteStartOff.en,
  );
  assert.equal(
    refusal(() =>
      programCommand(
        load('wm', (r) => {
          ready(r);
          r.remoteControl = 'NOT_SAFETY_RELEVANT_ENABLED';
        }),
        'start',
        EN,
      ),
    ),
    COMMAND_TEXT.remoteDisabled.en,
  );
  assert.equal(
    refusal(() =>
      programCommand(
        load('wm', (r) => {
          ready(r);
          r.applianceState = 'RUNNING';
        }),
        'start',
        EN,
      ),
    ),
    COMMAND_TEXT.notAvailable.en,
  );
});

test('nothing that heats is started or resumed remotely', () => {
  assert.deepEqual(PROGRAM_COMMANDS.start.families, ['washer']);
  for (const name of ['td', 'wd', 'dw', 'ov']) {
    const appliance = load(name, ready);
    const message = refusal(() => programCommand(appliance, 'start', EN));
    if (name === 'dw') {
      assert.equal(message, COMMAND_TEXT.unsupported.en, 'a dishwasher is not started either');
    } else {
      assert.equal(message, COMMAND_TEXT.unsafe.en, `${name} start`);
    }
  }
  for (const name of ['td', 'wd', 'ov']) {
    const paused = load(name, (r) => {
      r.applianceState = 'PAUSED';
      r.remoteControl = 'ENABLED';
    });
    assert.equal(
      refusal(() => programCommand(paused, 'resume', EN)),
      COMMAND_TEXT.unsafe.en,
    );
  }
  // No feature of an oven but its light accepts a command.
  assert.equal(
    refusal(() => featureCommand(load('ov'), 'target_temperature', 200, 'en')),
    COMMAND_TEXT.unsafe.en,
  );
});

test('pause, resume and stop follow the state the capabilities allow', () => {
  const running = load('wm', (r) => {
    r.applianceState = 'RUNNING';
    r.remoteControl = 'ENABLED';
  });
  assert.deepEqual(programCommand(running, 'pause', EN), { executeCommand: 'PAUSE' });
  assert.equal(
    refusal(() => programCommand(running, 'stop', EN)),
    COMMAND_TEXT.notAvailable.en,
  );
  const paused = load('wm', (r) => {
    r.applianceState = 'PAUSED';
    r.remoteControl = 'ENABLED';
  });
  assert.deepEqual(programCommand(paused, 'resume', EN), { executeCommand: 'RESUME' });
  assert.deepEqual(programCommand(paused, 'stop', EN), { executeCommand: 'STOPRESET' });
  // A dryer may be paused and stopped: the safe direction.
  const dryer = load('td', (r) => {
    r.applianceState = 'RUNNING';
    r.remoteControl = 'ENABLED';
    r.connectivityState = 'connected';
  });
  assert.deepEqual(programCommand(dryer, 'pause', EN), { executeCommand: 'PAUSE' });
  // The oven of the fixture may be stopped (its remote control is enabled).
  const oven = load('ov', (r) => (r.applianceState = 'RUNNING'));
  assert.deepEqual(programCommand(oven, 'stop', EN), { executeCommand: 'STOPRESET' });
});

test('an appliance off the cloud or without remote control refuses with a reason', () => {
  assert.equal(
    refusal(() => programCommand(load('td'), 'pause', EN)),
    COMMAND_TEXT.disconnected.en,
  );
  const locked = load('cr', (r) => (r.remoteControl = 'TEMPORARY_LOCKED'));
  assert.equal(
    refusal(() => featureCommand(locked, 'fridge_target_temperature', 4, 'en')),
    COMMAND_TEXT.remoteDisabled.en,
  );
});

test('feature commands build the API body, nested by compartment', () => {
  const cr = load('cr');
  assert.deepEqual(featureCommand(cr, 'freezer_target_temperature', -20, 'en'), {
    freezer: { targetTemperatureC: -20 },
  });
  assert.equal(
    refusal(() => featureCommand(cr, 'freezer_target_temperature', -5, 'en')),
    'Value out of range (-23 to -13).',
  );
  assert.deepEqual(featureCommand(cr, 'fridge_fast_mode', 1, 'en'), { fridge: { fastMode: 'ON' } });
  assert.deepEqual(featureCommand(load('ov'), 'light', 1, 'en'), { cavityLight: true });
  assert.deepEqual(featureCommand(load('so'), 'lower_light', 0, 'en'), {
    bottomOven: { cavityLight: false },
  });
  assert.deepEqual(featureCommand(load('ac'), 'power', 1, 'en'), { executeCommand: 'ON' });
  assert.deepEqual(featureCommand(load('ac'), 'target_temperature', 21.3, 'en'), {
    targetTemperatureC: 21.5,
  });
  assert.deepEqual(featureCommand(load('dam_ac'), 'mode', 3, 'en'), {
    airConditioner: { mode: 'dry' },
  });
  assert.deepEqual(featureCommand(load('purea9'), 'mode', 'Manual', 'en'), { Workmode: 'Manual' });
  assert.deepEqual(featureCommand(load('dh'), 'power', 1, 'en'), { executeCommand: 'ON' });
});

test('a purifier fan speed is refused outside the manual mode', () => {
  const auto = load('purea9');
  assert.equal(
    refusal(() => featureCommand(auto, 'fan_speed', 5, 'en')),
    COMMAND_TEXT.manualFirst.en,
  );
  const manual = load('purea9', (r) => (r.Workmode = 'Manual'));
  assert.deepEqual(featureCommand(manual, 'fan_speed', 5, 'en'), { Fanspeed: 5 });
  assert.match(
    refusal(() => featureCommand(manual, 'fan_speed', 12, 'en')),
    /1 to 9/,
  );
});

test('the refusal carries the four languages', () => {
  try {
    programCommand(load('ov', ready), 'start', { language: 'de', allowRemoteStart: true });
  } catch (err) {
    assert.equal(err.message, COMMAND_TEXT.unsafe.de);
    assert.deepEqual(Object.keys(err.texts).sort(), ['de', 'en', 'es', 'fr']);
  }
});
