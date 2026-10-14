// -----------------------------------------------------------------------------
// What may be sent to an appliance, and the body of PUT /appliances/{id}/command.
//
// Gates before anything leaves the container:
//   1. safety: a command must be allowed for the family of the appliance
//      (COMMAND_KEYS_BY_FAMILY in src/appliances.js, PROGRAM_COMMANDS here).
//      Nothing that heats is started or resumed remotely: no oven, no hob, no
//      dryer, no washer-dryer (it may dry). Stopping and pausing are safe.
//   2. consent: starting a washing machine needs the "remote start" toggle of
//      the integration (off by default) AND remote start armed on the machine
//      (`remoteControl: ENABLED`, the user pressed the button on it).
//   3. availability: the appliance must be connected, its remote control
//      enabled, and its capabilities must accept the command in its current
//      state (the `triggers` of `applianceState`): the user gets a clear
//      message instead of an HTTP 400.
// Pure functions: the tests pin every gate without any network.
// -----------------------------------------------------------------------------

import { bodyFor, triggeredRule, valuesOf } from './capabilities.js';
import { CommandError } from './command-error.js';
import { featureDefs, isCommandAllowed, isConnected, zoneState } from './appliances.js';
import { EXECUTE, REMOTE_CONTROL, STATE } from './electrolux/constants.js';
import { COMMAND_TEXT } from './i18n.js';

/** Commands of the `appliance_command` scene action, and who may get them. */
export const PROGRAM_COMMANDS = {
  // Starting: a washing machine only, behind the consent gate.
  start: { value: EXECUTE.START, families: ['washer'] },
  pause: { value: EXECUTE.PAUSE, families: ['washer', 'washer_dryer', 'dryer', 'dishwasher'] },
  // Resuming restarts the heating of a dryer: never remotely.
  resume: { value: EXECUTE.RESUME, families: ['washer', 'dishwasher'] },
  // Stopping is always the safe direction, an oven included.
  stop: {
    value: EXECUTE.STOP,
    families: ['washer', 'washer_dryer', 'dryer', 'dishwasher', 'oven'],
  },
};

/** When the capabilities say nothing: what each state accepts. */
const DEFAULT_ACCEPTED = {
  [STATE.READY_TO_START]: [EXECUTE.START],
  [STATE.RUNNING]: [EXECUTE.PAUSE, EXECUTE.STOP],
  [STATE.DELAYED_START]: [EXECUTE.PAUSE, EXECUTE.STOP],
  [STATE.PAUSED]: [EXECUTE.RESUME, EXECUTE.STOP],
  [STATE.END_OF_CYCLE]: [EXECUTE.STOP],
};

const HEATING_FAMILIES = ['oven', 'hob', 'dryer', 'washer_dryer'];

function refused(appliance, language) {
  return new CommandError(
    HEATING_FAMILIES.includes(appliance.family) ? COMMAND_TEXT.unsafe : COMMAND_TEXT.unsupported,
    language,
  );
}

const remoteControlOf = (appliance) =>
  appliance.reported.remoteControl === undefined
    ? null
    : String(appliance.reported.remoteControl).toUpperCase();

/**
 * The body for a command on a device feature (onSetValue).
 * @param {object} appliance parsed appliance
 * @param {string} key feature key (`power`, `fridge_target_temperature`…)
 * @param {number|string} value
 * @param {string} language
 */
export function featureCommand(appliance, key, value, language) {
  if (!isCommandAllowed(appliance.family, key)) {
    throw refused(appliance, language);
  }
  const def = featureDefs(appliance, language).find((candidate) => candidate.key === key);
  if (!def?.write) {
    throw new CommandError(COMMAND_TEXT.unsupported, language);
  }
  if (!isConnected(appliance)) {
    throw new CommandError(COMMAND_TEXT.disconnected, language);
  }
  const remote = remoteControlOf(appliance);
  if (remote === REMOTE_CONTROL.DISABLED || remote === REMOTE_CONTROL.TEMPORARY_LOCKED) {
    throw new CommandError(COMMAND_TEXT.remoteDisabled, language);
  }
  return bodyFor(def.write.path, def.write.encode(value));
}

/**
 * The body for a program command (scene action).
 * @param {object} appliance parsed appliance
 * @param {'start'|'pause'|'resume'|'stop'} command
 * @param {{ language: string, allowRemoteStart: boolean }} options
 */
export function programCommand(appliance, command, { language, allowRemoteStart }) {
  const definition = PROGRAM_COMMANDS[command];
  const caps = appliance.capabilities;
  if (!definition || !definition.families.includes(appliance.family) || !caps.executeCommand) {
    throw refused(appliance, language);
  }
  if (command === 'start' && !allowRemoteStart) {
    throw new CommandError(COMMAND_TEXT.remoteStartOff, language);
  }
  if (!isConnected(appliance)) {
    throw new CommandError(COMMAND_TEXT.disconnected, language);
  }
  const remote = remoteControlOf(appliance);
  if (remote !== null && remote !== REMOTE_CONTROL.ENABLED) {
    // NOT_SAFETY_RELEVANT_ENABLED lets settings through, never a program command.
    throw new CommandError(COMMAND_TEXT.remoteDisabled, language);
  }
  const accepted = valuesOf(caps.executeCommand).map((value) => value.toUpperCase());
  if (accepted.length > 0 && !accepted.includes(definition.value)) {
    throw refused(appliance, language);
  }
  const state = zoneState(appliance, '');
  const rule = triggeredRule(caps, 'applianceState', state, 'executeCommand');
  const now = rule?.values ?? DEFAULT_ACCEPTED[state] ?? [];
  if (rule?.disabled || !now.map((value) => value.toUpperCase()).includes(definition.value)) {
    throw new CommandError(COMMAND_TEXT.notAvailable, language);
  }
  return { executeCommand: definition.value };
}
