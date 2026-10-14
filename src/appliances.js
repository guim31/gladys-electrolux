// -----------------------------------------------------------------------------
// One Gladys device per Electrolux appliance: its features, built from the
// capabilities the appliance declares (GET /appliances/{id}/info), and their
// states, read from its reported state (GET /state or the live stream).
//
// External ids are forever: `appliance:<applianceId>` for the device (the id
// Electrolux keys the appliance on), a fixed English key per feature. A
// feature is declared when the appliance has the capability (or reports the
// value), never from a list of models; its key never moves to another device.
//
// Safety (Guilhem's rule, the OctoPrint lesson): nothing that heats is started
// remotely. Ovens, hobs, dryers and washer-dryers get read-only features (an
// oven light aside); the program commands live in src/commands.js, behind
// their own gates. A feature is writable only when its family allows it
// (COMMAND_KEYS_BY_FAMILY), checked again when a command arrives.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import {
  enabledValuesOf,
  flattenCapabilities,
  isReadable,
  isWritable,
  rangeOf,
  readPath,
  triggeredRule,
  valuesOf,
} from './capabilities.js';
import { CommandError } from './command-error.js';
import {
  ACTIVE_STATES,
  CYCLE_FAMILIES,
  REMOTE_CONTROL,
  ROBOT_CLEANING,
  ROBOT_ERROR,
  ROBOT_PAUSED,
  STATE,
  familyOf,
} from './electrolux/constants.js';
import {
  ALERT_TEXT,
  COMMAND_TEXT,
  FILTER_TEXT,
  NAMES,
  OPTION_TEXT,
  PHASE_TEXT,
  STATUS_TEXT,
  TYPE_NAMES,
  ZONE_NAMES,
  fill,
  fillAll,
  pickLanguage,
} from './i18n.js';

/** Shown in a text feature that has no value (Gladys ignores an empty text). */
export const NO_VALUE = '—';

/** The feature keys that accept a command, per family (src/commands.js checks it again). */
export const COMMAND_KEYS_BY_FAMILY = {
  oven: [/^(upper_|lower_)?light$/],
  fridge: [/^(fridge|freezer|extra)_(target_temperature|fast_mode)$/],
  air_conditioner: [/^(power|mode|target_temperature|fan_speed)$/],
  purifier: [/^(power|mode|fan_speed)$/],
  dehumidifier: [/^power$/],
};

/** Whether a feature key may receive a command on this family. */
export function isCommandAllowed(family, key) {
  return (COMMAND_KEYS_BY_FAMILY[family] ?? []).some((pattern) => pattern.test(key));
}

/** Compartments, and the prefix of their feature keys. */
const OVEN_ZONES = { upperOven: 'upper', bottomOven: 'lower' };
const FRIDGE_ZONES = { fridge: 'fridge', freezer: 'freezer', extraCavity: 'extra' };

/** Air conditioner modes and fan speeds, to the codes of Gladys (AC_MODE, AC_FAN_SPEED). */
const AC_MODE_CODES = { AUTO: 0, COOL: 1, HEAT: 2, DRY: 3, FANONLY: 4, FAN: 4 };
const AC_MODE_LABELS = { 0: 'ac_auto', 1: 'ac_cool', 2: 'ac_heat', 3: 'ac_dry', 4: 'ac_fan' };
const FAN_CODES = { AUTO: 0, LOW: 1, MIDDLE: 3, MEDIUM: 3, MID: 3, HIGH: 5, QUIET: 6, TURBO: 7 };
const FAN_LABELS = {
  0: 'fan_auto',
  1: 'fan_low',
  3: 'fan_medium',
  5: 'fan_high',
  6: 'fan_quiet',
  7: 'fan_turbo',
};
const normalizeToken = (value) =>
  String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

// --- Reading the API answers --------------------------------------------------

const numberOrNull = (value) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};

/** "COTTON_PR_ECO40-60" → "Eco40-60", "TRUE_FAN" → "True fan". */
export function humanize(code) {
  const text = String(code ?? '').trim();
  if (text === '') {
    return '';
  }
  const tail = text.includes('_PR_') ? text.slice(text.indexOf('_PR_') + 4) : text;
  const words = tail.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One appliance as the rest of the code sees it.
 * @param {{ applianceId: string, applianceName?: string, applianceType?: string }} entry GET /appliances
 * @param {object|null} info GET /appliances/{id}/info
 * @param {object|null} state GET /appliances/{id}/state
 */
export function parseAppliance(entry, info, state) {
  const identity = info?.applianceInfo ?? {};
  const reported = structuredClone(state?.properties?.reported ?? {});
  return {
    id: String(entry.applianceId),
    name: typeof entry.applianceName === 'string' ? entry.applianceName.trim() : '',
    type: String(entry.applianceType ?? ''),
    family: familyOf(entry.applianceType, identity.deviceType),
    brand: typeof identity.brand === 'string' ? identity.brand : '',
    model: typeof identity.model === 'string' ? identity.model : '',
    capabilities: flattenCapabilities(info?.capabilities ?? {}),
    capabilityHash: reported.applianceInfo?.capabilityHash ?? null,
    connectionState: state?.connectionState ?? null,
    reported,
  };
}

/** Whether the appliance is connected to the Electrolux cloud right now. */
export function isConnected(appliance) {
  const value =
    readPath(appliance.reported, 'connectivityState') ??
    readPath(appliance.reported, 'airConditioner/connectivityState') ??
    appliance.connectionState;
  return value === null || value === undefined || String(value).toLowerCase() === 'connected';
}

/** The brand as people write it: "AEG", "Electrolux", "Frigidaire". */
function brandName(brand) {
  const upper = String(brand ?? '').toUpperCase();
  if (upper === '' || upper === 'ELECTROLUX') {
    return 'Electrolux';
  }
  return upper.length <= 3 ? upper : upper.charAt(0) + upper.slice(1).toLowerCase();
}

/** The name shown for an appliance: the one given in the app, else "<Brand> <kind>". */
export function applianceName(appliance, language) {
  if (appliance.name) {
    return appliance.name;
  }
  return `${brandName(appliance.brand)} ${TYPE_NAMES[pickLanguage(language)][appliance.family]}`;
}

/** Compartments of an oven or a fridge (empty for a single cavity). */
export function zonesOf(appliance) {
  const table =
    appliance.family === 'oven' ? OVEN_ZONES : appliance.family === 'fridge' ? FRIDGE_ZONES : {};
  const paths = Object.keys(appliance.capabilities);
  return Object.keys(table).filter((zone) => paths.some((path) => path.startsWith(`${zone}/`)));
}

const STATE_PRIORITY = [
  STATE.ALARM,
  STATE.RUNNING,
  STATE.PAUSED,
  STATE.DELAYED_START,
  STATE.READY_TO_START,
  STATE.END_OF_CYCLE,
  STATE.IDLE,
  STATE.OFF,
];

/** The state of a zone (or of the appliance with zone ''), upper-cased, or null. */
export function zoneState(appliance, zone) {
  const value = readPath(appliance.reported, zone ? `${zone}/applianceState` : 'applianceState');
  return typeof value === 'string' && value !== '' ? value.toUpperCase() : null;
}

/**
 * The state key of an appliance (a key of STATUS_TEXT).
 * @param {ReturnType<typeof parseAppliance>} appliance
 */
export function statusKey(appliance) {
  if (!isConnected(appliance)) {
    return 'NOT_CONNECTED';
  }
  const reported = appliance.reported;
  if (appliance.family === 'robot') {
    const code = numberOrNull(reported.robotStatus);
    if (code === null) {
      return 'UNKNOWN';
    }
    if (ROBOT_CLEANING.includes(code) || code === 13) {
      return 'CLEANING';
    }
    if (ROBOT_PAUSED.includes(code)) {
      return 'PAUSED';
    }
    if (code === 5 || code === 7) {
      return 'RETURNING';
    }
    if (code === 9 || code === 12) {
      return 'CHARGING';
    }
    if (code === 10) {
      return 'SLEEPING';
    }
    if (code === ROBOT_ERROR) {
      return 'ERROR';
    }
    return code === 14 ? 'UPDATING' : 'UNKNOWN';
  }
  if (typeof reported.Workmode === 'string') {
    return reported.Workmode.toUpperCase() === 'POWEROFF' ? 'OFF' : 'ON';
  }
  const own = zoneState(appliance, '') ?? zoneState(appliance, 'airConditioner');
  if (own) {
    return STATUS_TEXT.en[own] ? own : own === 'ALERT' ? 'ALARM' : 'UNKNOWN';
  }
  const zones = zonesOf(appliance)
    .map((zone) => zoneState(appliance, zone))
    .filter(Boolean);
  if (zones.length > 0) {
    return STATE_PRIORITY.find((candidate) => zones.includes(candidate)) ?? 'UNKNOWN';
  }
  return 'UNKNOWN';
}

/** Status text of an appliance, in the language of the configuration. */
export function statusText(appliance, language) {
  return STATUS_TEXT[pickLanguage(language)][statusKey(appliance)];
}

/** Active alerts of an appliance (top level and compartments), as codes. */
export function alertCodes(appliance) {
  const codes = new Set();
  const collect = (list) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const alert of list) {
      const code = typeof alert === 'string' ? alert : alert?.code;
      if (code !== undefined && code !== null && String(code) !== '') {
        codes.add(String(code));
      }
    }
  };
  collect(appliance.reported.alerts);
  for (const zone of zonesOf(appliance)) {
    collect(readPath(appliance.reported, `${zone}/alerts`));
  }
  return [...codes].sort();
}

/** One alert in words. */
export function alertText(code, language) {
  const table = ALERT_TEXT[pickLanguage(language)];
  if (table[code] && code !== 'code') {
    return table[code];
  }
  return /^\d+$/.test(code) ? fill(table.code, { code }) : humanize(code);
}

/** Phase in words, or null when there is none to show. */
function phaseText(code, language) {
  const upper = String(code ?? '').toUpperCase();
  if (upper === '' || ['UNAVAILABLE', 'CYCLE_PHASE_HIDDEN', 'NONE'].includes(upper)) {
    return null;
  }
  return PHASE_TEXT[pickLanguage(language)][upper] ?? humanize(upper);
}

/** Program in words, or null (no program, an internal one). */
export function programText(code) {
  const upper = String(code ?? '').toUpperCase();
  if (upper === '' || upper === 'KEY_ERROR' || upper.includes('HIDDEN') || upper === 'NONE') {
    return null;
  }
  return humanize(code);
}

/** Seconds of a time field, or null (absent, -1 "not set"). */
function secondsOf(value) {
  const number = numberOrNull(value);
  return number === null || number < 0 ? null : number;
}

/**
 * Timing of the cycle of a zone: seconds left, seconds before a delayed start,
 * seconds before the expected end. Null fields when unknown.
 */
export function cycleTiming(appliance, zone = '') {
  const at = (name) => readPath(appliance.reported, zone ? `${zone}/${name}` : name);
  const state = zone ? zoneState(appliance, zone) : (zoneState(appliance, '') ?? null);
  const left = secondsOf(at('timeToEnd'));
  const startIn = secondsOf(at('startTime'));
  const stopIn = secondsOf(at('stopTime'));
  if (state === STATE.DELAYED_START) {
    // The SDK's reading: stopTime counts to the end, startTime to the start.
    if (stopIn !== null && stopIn > 0) {
      return { left, startIn: Math.max(0, stopIn - (left ?? 0)), endIn: stopIn };
    }
    if (startIn !== null && startIn > 0) {
      // Without a duration (an oven set to start later), the end is unknown.
      return { left, startIn, endIn: left ? startIn + left : null };
    }
    return { left, startIn: null, endIn: null };
  }
  if (state === STATE.RUNNING) {
    return { left, startIn: null, endIn: left !== null && left > 0 ? left : null };
  }
  return { left, startIn: null, endIn: null };
}

/** "14:35" in the time zone of Gladys (TZ, set by the supervisor). */
export function clockTime(date, language) {
  return new Intl.DateTimeFormat(pickLanguage(language), {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/** Round to one decimal: an API sends 176.66666 for a setpoint typed in °F. */
const round1 = (value) => Math.round(value * 10) / 10;

// --- The features ---------------------------------------------------------------

const TEXT = {
  category: CAT.TEXT,
  type: TYPES.TEXT.TEXT,
  min: 0,
  max: 0,
  read_only: true,
  has_feedback: false,
  keep_history: false,
};
const DURATION = {
  category: CAT.DURATION,
  type: TYPES.DURATION.INTEGER,
  unit: UNITS.MINUTES,
  min: 0,
  max: 6000,
  read_only: true,
  has_feedback: false,
  keep_history: false,
};
const temperatureSensor = (type = TYPES.SENSOR.DECIMAL, min = -40, max = 400) => ({
  category: CAT.TEMPERATURE_SENSOR,
  type,
  unit: UNITS.CELSIUS,
  min,
  max,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});
const OPENING = {
  category: CAT.OPENING_SENSOR,
  type: TYPES.SENSOR.BINARY,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
};
const command = (category, type, extra = {}) => ({
  category,
  type,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...extra,
});
const sensor = (category, type, unit, min, max) => ({
  category,
  type,
  ...(unit ? { unit } : {}),
  min,
  max,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});

/** The value of a command, checked against a numeric range, snapped to its step or list. */
function snapToRange(range, value, language) {
  const number = Number(value);
  const bounds = { min: range.min, max: range.max };
  if (!Number.isFinite(number) || number < range.min - 0.01 || number > range.max + 0.01) {
    throw new CommandError(fillAll(COMMAND_TEXT.outOfRange, bounds), language);
  }
  if (Array.isArray(range.values) && range.values.length > 0) {
    return range.values.reduce((best, candidate) =>
      Math.abs(candidate - number) < Math.abs(best - number) ? candidate : best,
    );
  }
  const steps = Math.round((number - range.min) / (range.step || 1));
  return round1(Math.min(range.max, range.min + steps * (range.step || 1)));
}

/** The API value for "on" or "off" among the values of a command capability. */
function onOffValue(capability, on) {
  const wanted = on ? 'ON' : 'OFF';
  return valuesOf(capability).find((value) => value.toUpperCase() === wanted) ?? wanted;
}

/**
 * The feature definitions of an appliance: the Gladys declaration (`spec`,
 * `name`), how to read its state (`read`), and for a command how to build the
 * API body (`write`).
 * @param {ReturnType<typeof parseAppliance>} appliance
 * @param {string} language feature names and option labels
 */
export function featureDefs(appliance, language) {
  const lang = pickLanguage(language);
  const caps = appliance.capabilities;
  const val = (path) => readPath(appliance.reported, path);
  const has = (path) => isReadable(caps[path]);
  const present = (path) => has(path) || numberOrNull(val(path)) !== null;
  const defs = [];
  const nameOf = (key, zone) =>
    zone ? fill(NAMES[lang][`zone_${key}`], { zone: ZONE_NAMES[lang][zone] }) : NAMES[lang][key];
  const add = (key, nameKey, zone, spec, read, write) => {
    const allowed = write && isCommandAllowed(appliance.family, key);
    defs.push({
      key,
      name: nameOf(nameKey, zone),
      spec: allowed ? spec : { ...spec, read_only: true, has_feedback: false },
      read,
      write: allowed ? write : undefined,
    });
  };
  const text = (value) => ({ text: value === null || value === '' ? NO_VALUE : value });

  add('status', 'status', '', TEXT, () => text(statusText(appliance, lang)));
  if (
    caps.alerts ||
    Array.isArray(appliance.reported.alerts) ||
    zonesOf(appliance).some((zone) => caps[`${zone}/alerts`])
  ) {
    add('alerts', 'alerts', '', TEXT, () =>
      text(
        alertCodes(appliance)
          .map((code) => alertText(code, lang))
          .join(', ')
          .slice(0, 250),
      ),
    );
  }

  // --- Washing machines, dryers, dishwashers: the cycle -----------------------
  if (CYCLE_FAMILIES.includes(appliance.family)) {
    const active = () => ACTIVE_STATES.includes(zoneState(appliance, ''));
    if (has('userSelections/programUID') || val('userSelections/programUID') !== undefined) {
      add('program', 'program', '', TEXT, () =>
        text(programText(val('userSelections/programUID'))),
      );
    }
    if (has('cyclePhase')) {
      add('phase', 'phase', '', TEXT, () =>
        text(active() ? phaseText(val('cyclePhase'), lang) : null),
      );
    }
    if (has('timeToEnd')) {
      add('remaining_time', 'remaining_time', '', DURATION, () => {
        const { left } = cycleTiming(appliance);
        return active() && left !== null ? Math.round(left / 60) : 0;
      });
      add('end_time', 'end_time', '', TEXT, (now) => {
        const { endIn } = cycleTiming(appliance);
        return text(endIn ? clockTime(new Date(now + endIn * 1000), lang) : null);
      });
    }
    if (has('startTime') || has('stopTime')) {
      add('start_in', 'start_in', '', DURATION, () => {
        const { startIn } = cycleTiming(appliance);
        return startIn ? Math.round(startIn / 60) : 0;
      });
    }
    if (has('doorState')) {
      // Opening sensor: 0 = open, 1 = closed (Gladys' OPENING_SENSOR_STATE).
      add('door', 'door', '', OPENING, () => doorValue(val('doorState')));
    }
    if (has('remoteControl')) {
      add(
        'remote_start',
        'remote_start',
        '',
        sensor(CAT.INPUT, TYPES.SENSOR.BINARY, null, 0, 1),
        () => (String(val('remoteControl')).toUpperCase() === REMOTE_CONTROL.ENABLED ? 1 : 0),
      );
    }
  }

  // --- Ovens: one cavity, or an upper and a lower one ---------------------------
  if (appliance.family === 'oven') {
    const zones = zonesOf(appliance);
    for (const zone of zones.length > 0 ? zones : ['']) {
      const prefix = zone ? `${OVEN_ZONES[zone]}_` : '';
      const path = (name) => (zone ? `${zone}/${name}` : name);
      const active = () => ACTIVE_STATES.includes(zoneState(appliance, zone));
      if (zone) {
        add(`${prefix}status`, 'status', zone, TEXT, () => {
          const state = isConnected(appliance) ? zoneState(appliance, zone) : 'NOT_CONNECTED';
          return text(STATUS_TEXT[lang][state] ?? STATUS_TEXT[lang].UNKNOWN);
        });
      }
      if (has(path('program'))) {
        add(`${prefix}program`, 'program', zone, TEXT, () =>
          text(active() ? programText(val(path('program'))) : null),
        );
      }
      if (has(path('displayTemperatureC'))) {
        add(`${prefix}temperature`, 'temperature', zone, temperatureSensor(), () =>
          roundOrNull(val(path('displayTemperatureC'))),
        );
      }
      if (has(path('targetTemperatureC'))) {
        // The setpoint, shown read only: an oven is never set remotely.
        add(`${prefix}target_temperature`, 'target_temperature', zone, temperatureSensor(), () =>
          active() ? roundOrNull(val(path('targetTemperatureC'))) : null,
        );
      }
      if (has(path('displayFoodProbeTemperatureC'))) {
        add(
          `${prefix}probe_temperature`,
          'probe_temperature',
          zone,
          temperatureSensor(TYPES.TEMPERATURE_SENSOR.PROBE),
          () =>
            String(val(path('foodProbeInsertionState'))).toUpperCase() === 'INSERTED'
              ? roundOrNull(val(path('displayFoodProbeTemperatureC')))
              : null,
        );
      }
      if (has(path('timeToEnd'))) {
        add(`${prefix}remaining_time`, 'remaining_time', zone, DURATION, () => {
          const { left } = cycleTiming(appliance, zone);
          return active() && left !== null ? Math.round(left / 60) : 0;
        });
        add(`${prefix}end_time`, 'end_time', zone, TEXT, (now) => {
          const { endIn } = cycleTiming(appliance, zone);
          return text(endIn ? clockTime(new Date(now + endIn * 1000), lang) : null);
        });
      }
      if (has(path('doorState'))) {
        add(`${prefix}door`, 'door', zone, OPENING, () => doorValue(val(path('doorState'))));
      }
      if (has(path('cavityLight'))) {
        add(
          `${prefix}light`,
          'light',
          zone,
          command(CAT.LIGHT, TYPES.LIGHT.BINARY),
          () =>
            typeof val(path('cavityLight')) === 'boolean'
              ? val(path('cavityLight'))
                ? 1
                : 0
              : null,
          isWritable(caps[path('cavityLight')])
            ? { path: path('cavityLight'), kind: 'setting', encode: (value) => Number(value) === 1 }
            : undefined,
        );
      }
    }
  }

  // --- Fridges: setpoint, door and fast mode per compartment ------------------
  if (appliance.family === 'fridge') {
    for (const zone of zonesOf(appliance)) {
      const prefix = `${FRIDGE_ZONES[zone]}_`;
      const path = (name) => `${zone}/${name}`;
      if (has(path('displayTemperatureC'))) {
        add(`${prefix}temperature`, 'temperature', zone, temperatureSensor(), () =>
          roundOrNull(val(path('displayTemperatureC'))),
        );
      }
      const target = caps[path('targetTemperatureC')];
      const range = rangeOf(target);
      if (target && range) {
        add(
          `${prefix}target_temperature`,
          'target_temperature',
          zone,
          command(CAT.THERMOSTAT, TYPES.THERMOSTAT.TARGET_TEMPERATURE, {
            unit: UNITS.CELSIUS,
            min: range.min,
            max: range.max,
          }),
          () => roundOrNull(val(path('targetTemperatureC'))),
          isWritable(target)
            ? {
                path: path('targetTemperatureC'),
                kind: 'setting',
                encode: (value) => snapToRange(range, value, lang),
              }
            : undefined,
        );
      }
      if (has(path('doorState'))) {
        add(`${prefix}door`, 'door', zone, OPENING, () => doorValue(val(path('doorState'))));
      }
      const fast = caps[path('fastMode')];
      if (fast && valuesOf(fast).some((value) => value.toUpperCase() === 'ON')) {
        add(
          `${prefix}fast_mode`,
          'fast_mode',
          zone,
          command(CAT.SWITCH, TYPES.SWITCH.BINARY),
          () => onOffState(val(path('fastMode'))),
          isWritable(fast)
            ? {
                path: path('fastMode'),
                kind: 'setting',
                encode: (value) => onOffValue(fast, Number(value) === 1),
              }
            : undefined,
        );
      }
    }
  }

  // --- Air conditioners: the classic model, and the DAM one -------------------
  if (appliance.family === 'air_conditioner') {
    const dam = Boolean(caps['airConditioner/mode'] || caps['airConditioner/executeCommand']);
    const p = dam
      ? {
          state: 'airConditioner/applianceState',
          execute: 'airConditioner/executeCommand',
          mode: 'airConditioner/mode',
          target: 'airConditioner/targetTemperature',
          fan: 'airConditioner/fanMode',
          ambient: 'temperature',
        }
      : {
          state: 'applianceState',
          execute: 'executeCommand',
          mode: 'mode',
          target: 'targetTemperatureC',
          fan: 'fanSpeedSetting',
          ambient: 'ambientTemperatureC',
        };
    if (caps[p.execute]) {
      add(
        'power',
        'power',
        '',
        command(CAT.AIR_CONDITIONING, TYPES.AIR_CONDITIONING.BINARY),
        () => {
          const state = String(val(p.state) ?? '').toUpperCase();
          if (state === '') {
            return null;
          }
          return state === 'OFF' || String(val(p.mode)).toUpperCase() === 'OFF' ? 0 : 1;
        },
        {
          path: p.execute,
          kind: 'setting',
          encode: (value) => onOffValue(caps[p.execute], Number(value) === 1),
        },
      );
    }
    addCodedSelect(add, caps[p.mode], p.mode, val, {
      key: 'mode',
      category: CAT.AIR_CONDITIONING,
      type: TYPES.AIR_CONDITIONING.MODE,
      codes: AC_MODE_CODES,
      labels: AC_MODE_LABELS,
      lang,
    });
    const target = caps[p.target];
    const targetRange = rangeOf(target);
    if (target && targetRange) {
      add(
        'target_temperature',
        'target_temperature',
        '',
        command(CAT.AIR_CONDITIONING, TYPES.AIR_CONDITIONING.TARGET_TEMPERATURE, {
          unit: UNITS.CELSIUS,
          min: Math.floor(targetRange.min),
          max: Math.ceil(targetRange.max),
        }),
        () => roundOrNull(val(p.target)),
        isWritable(target)
          ? {
              path: p.target,
              kind: 'setting',
              encode: (value) => {
                const number = Number(value);
                if (
                  !Number.isFinite(number) ||
                  number < Math.floor(targetRange.min) ||
                  number > Math.ceil(targetRange.max)
                ) {
                  throw new CommandError(
                    fillAll(COMMAND_TEXT.outOfRange, {
                      min: Math.floor(targetRange.min),
                      max: Math.ceil(targetRange.max),
                    }),
                    lang,
                  );
                }
                return Math.min(
                  targetRange.max,
                  Math.max(targetRange.min, Math.round(number * 2) / 2),
                );
              },
            }
          : undefined,
      );
    }
    addCodedSelect(add, caps[p.fan], p.fan, val, {
      key: 'fan_speed',
      category: CAT.AIR_CONDITIONING,
      type: TYPES.AIR_CONDITIONING.FAN_SPEED,
      codes: FAN_CODES,
      labels: FAN_LABELS,
      lang,
    });
    if (present(p.ambient)) {
      add('temperature', 'temperature', '', temperatureSensor(TYPES.SENSOR.DECIMAL, -40, 80), () =>
        roundOrNull(val(p.ambient)),
      );
    }
    if (has('filterState')) {
      add('filter', 'filter', '', TEXT, () => text(filterText(val('filterState'), lang)));
    }
  }

  // --- Air purifiers ------------------------------------------------------------
  if (appliance.family === 'purifier') {
    const workmode = caps.Workmode;
    const execute = caps.executeCommand;
    if (execute || workmode) {
      // Switching on picks the automatic mode when the purifier has one.
      const onMode = ['AUTO', 'SMART', 'MANUAL']
        .map((wanted) => enabledValuesOf(workmode).find((value) => value.toUpperCase() === wanted))
        .find(Boolean);
      add(
        'power',
        'power',
        '',
        command(CAT.SWITCH, TYPES.SWITCH.BINARY),
        () => {
          if (execute) {
            const state = String(val('applianceState') ?? '').toUpperCase();
            return state === '' ? null : state === 'RUNNING' ? 1 : 0;
          }
          return typeof val('Workmode') === 'string'
            ? val('Workmode').toUpperCase() === 'POWEROFF'
              ? 0
              : 1
            : null;
        },
        execute
          ? {
              path: 'executeCommand',
              kind: 'setting',
              encode: (value) => onOffValue(execute, Number(value) === 1),
            }
          : {
              path: 'Workmode',
              kind: 'setting',
              encode: (value) =>
                Number(value) === 1
                  ? (onMode ?? 'Auto')
                  : (valuesOf(workmode).find((v) => v.toUpperCase() === 'POWEROFF') ?? 'PowerOff'),
            },
      );
    }
    const modes = enabledValuesOf(workmode).filter((value) => value.toUpperCase() !== 'POWEROFF');
    if (modes.length > 0) {
      add(
        'mode',
        'mode',
        '',
        command(CAT.TEXT, TYPES.TEXT.SELECT, {
          max: 0,
          keep_history: false,
          supported_options: modes.map((value, index) => ({
            value,
            label: OPTION_TEXT[lang][`purifier_${value.toLowerCase()}`] ?? humanize(value),
            sort_order: index,
          })),
        }),
        () => {
          const current = val('Workmode');
          return typeof current === 'string' && modes.includes(current) ? { text: current } : null;
        },
        {
          path: 'Workmode',
          kind: 'setting',
          encode: (value) => {
            const wanted = modes.find((mode) => mode.toUpperCase() === String(value).toUpperCase());
            if (!wanted) {
              throw new CommandError(COMMAND_TEXT.unsupported, lang);
            }
            return wanted;
          },
        },
      );
    }
    const fan = caps.Fanspeed;
    const fanRange = rangeOf(fan);
    if (fan && fanRange) {
      add(
        'fan_speed',
        'fan_speed',
        '',
        command(CAT.FAN, TYPES.FAN.SPEED, { min: fanRange.min, max: fanRange.max }),
        () => numberOrNull(val('Fanspeed')),
        isWritable(fan)
          ? {
              path: 'Fanspeed',
              kind: 'setting',
              encode: (value) => {
                const rule = triggeredRule(caps, 'Workmode', val('Workmode'), 'Fanspeed');
                if (rule?.disabled) {
                  throw new CommandError(COMMAND_TEXT.manualFirst, lang);
                }
                return Math.round(snapToRange({ ...fanRange, step: 1 }, value, lang));
              },
            }
          : undefined,
      );
    }
    const firstPresent = (...paths) => paths.find((path) => present(path));
    const pm25 = firstPresent('PM2_5', 'PM2_5_approximate');
    if (pm25) {
      add(
        'pm25',
        'pm25',
        '',
        sensor(CAT.PM25_SENSOR, TYPES.SENSOR.DECIMAL, UNITS.MICROGRAM_PER_CUBIC_METER, 0, 1000),
        () => roundOrNull(val(pm25)),
      );
    }
    if (present('PM10')) {
      add(
        'pm10',
        'pm10',
        '',
        sensor(CAT.PM10_SENSOR, TYPES.SENSOR.DECIMAL, UNITS.MICROGRAM_PER_CUBIC_METER, 0, 1000),
        () => roundOrNull(val('PM10')),
      );
    }
    if (present('TVOC')) {
      add('voc', 'voc', '', sensor(CAT.VOC_SENSOR, TYPES.SENSOR.DECIMAL, UNITS.PPB, 0, 5000), () =>
        roundOrNull(val('TVOC')),
      );
    }
    const co2 = firstPresent('CO2', 'ECO2');
    if (co2) {
      add(
        'co2',
        'co2',
        '',
        sensor(CAT.CO2_SENSOR, TYPES.SENSOR.INTEGER, UNITS.PPM, 0, 10000),
        () => {
          const value = numberOrNull(val(co2));
          return value === null ? null : Math.round(value);
        },
      );
    }
    if (present('Humidity')) {
      add(
        'humidity',
        'humidity',
        '',
        sensor(CAT.HUMIDITY_SENSOR, TYPES.SENSOR.DECIMAL, UNITS.PERCENT, 0, 100),
        () => roundOrNull(val('Humidity')),
      );
    }
    if (present('Temp')) {
      add('temperature', 'temperature', '', temperatureSensor(TYPES.SENSOR.DECIMAL, -40, 80), () =>
        roundOrNull(val('Temp')),
      );
    }
    const filterLife = firstPresent('FilterLife', 'FilterLife_1');
    if (filterLife) {
      add(
        'filter_life',
        'filter_life',
        '',
        sensor(
          CAT.HEPA_FILTER_MONITORING,
          TYPES.FILTER_MONITORING.FILTER_LIFE_REMAINING,
          UNITS.PERCENT,
          0,
          100,
        ),
        () => numberOrNull(val(filterLife)),
      );
    }
  }

  // --- Dehumidifiers --------------------------------------------------------------
  if (appliance.family === 'dehumidifier') {
    if (caps.executeCommand) {
      add(
        'power',
        'power',
        '',
        command(CAT.SWITCH, TYPES.SWITCH.BINARY),
        () => {
          const state = String(val('applianceState') ?? '').toUpperCase();
          return state === '' ? null : state === 'OFF' ? 0 : 1;
        },
        {
          path: 'executeCommand',
          kind: 'setting',
          encode: (value) => onOffValue(caps.executeCommand, Number(value) === 1),
        },
      );
    }
    if (present('sensorHumidity')) {
      add(
        'humidity',
        'humidity',
        '',
        sensor(CAT.HUMIDITY_SENSOR, TYPES.SENSOR.DECIMAL, UNITS.PERCENT, 0, 100),
        () => roundOrNull(val('sensorHumidity')),
      );
    }
    if (has('filterState')) {
      add('filter', 'filter', '', TEXT, () => text(filterText(val('filterState'), lang)));
    }
  }

  // --- Fridges and robots: what the rest of the family reports -------------------
  if (appliance.family === 'fridge') {
    if (present('sensorHumidity')) {
      add(
        'humidity',
        'humidity',
        '',
        sensor(CAT.HUMIDITY_SENSOR, TYPES.SENSOR.DECIMAL, UNITS.PERCENT, 0, 100),
        () => roundOrNull(val('sensorHumidity')),
      );
    }
    if (has('waterFilterState')) {
      add('water_filter', 'water_filter', '', TEXT, () =>
        text(filterText(val('waterFilterState'), lang)),
      );
    }
    if (has('airFilterState')) {
      add('air_filter', 'air_filter', '', TEXT, () =>
        text(filterText(val('airFilterState'), lang)),
      );
    }
  }
  if (appliance.family === 'robot' && present('batteryStatus')) {
    // Six levels (1 to 6), as the Electrolux app shows them.
    add(
      'battery',
      'battery',
      '',
      sensor(CAT.BATTERY, TYPES.BATTERY.INTEGER, UNITS.PERCENT, 0, 100),
      () => {
        const level = numberOrNull(val('batteryStatus'));
        return level === null ? null : Math.round((Math.min(6, Math.max(0, level)) / 6) * 100);
      },
    );
  }
  return defs;
}

/**
 * A select whose values Gladys knows by code (air conditioner mode, fan
 * speed): the options the appliance lists, the others left out.
 */
function addCodedSelect(add, capability, path, val, { key, category, type, codes, labels, lang }) {
  if (!capability) {
    return;
  }
  const options = valuesOf(capability)
    .map((value) => ({ value, code: codes[normalizeToken(value)] }))
    .filter((option) => option.code !== undefined);
  if (options.length === 0) {
    return;
  }
  const byCode = new Map();
  for (const option of options) {
    if (!byCode.has(option.code)) {
      byCode.set(option.code, option.value);
    }
  }
  const sorted = [...byCode.keys()].sort((a, b) => a - b);
  add(
    key,
    key,
    '',
    command(category, type, {
      min: sorted[0],
      max: sorted.at(-1),
      supported_options: sorted.map((code, index) => ({
        value: code,
        label: OPTION_TEXT[lang][labels[code]],
        sort_order: index,
      })),
    }),
    () => {
      const code = codes[normalizeToken(val(path))];
      return code === undefined ? null : code;
    },
    isWritable(capability)
      ? {
          path,
          kind: 'setting',
          encode: (value) => {
            const apiValue = byCode.get(Number(value));
            if (apiValue === undefined) {
              throw new CommandError(COMMAND_TEXT.unsupported, lang);
            }
            return apiValue;
          },
        }
      : undefined,
  );
}

function doorValue(value) {
  const upper = String(value ?? '').toUpperCase();
  if (upper === 'OPEN') {
    return 0;
  }
  return upper === 'CLOSED' ? 1 : null;
}

function onOffState(value) {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const upper = String(value ?? '').toUpperCase();
  return upper === 'ON' ? 1 : upper === 'OFF' ? 0 : null;
}

function roundOrNull(value) {
  const number = numberOrNull(value);
  return number === null ? null : round1(number);
}

function filterText(value, language) {
  const upper = String(value ?? '').toUpperCase();
  if (upper === '') {
    return null;
  }
  return FILTER_TEXT[pickLanguage(language)][upper] ?? humanize(upper);
}

// --- The Gladys device and its states -------------------------------------------

/** External ids of an appliance. */
export function idsOf(gladys, applianceId) {
  return gladys.externalIds('appliance', applianceId);
}

/**
 * The device published to Gladys for an appliance.
 * @param {object} gladys GladysIntegration (externalIds)
 * @param {ReturnType<typeof parseAppliance>} appliance
 * @param {string} language feature names language
 */
export function buildDevice(gladys, appliance, language) {
  const lang = pickLanguage(language);
  const ids = idsOf(gladys, appliance.id);
  const params = [{ name: 'electrolux_type', value: appliance.type || appliance.family }];
  if (appliance.model) {
    params.push({ name: 'model', value: appliance.model });
  }
  return {
    name: applianceName(appliance, lang),
    external_id: ids.device,
    // The container refreshes by itself (live stream + its own timer, see
    // src/hub.js): Gladys#3198 makes the core's polling unreliable. onPoll
    // stays as a fallback, and skips when the container read recently.
    should_poll: true,
    poll_frequency: DEVICE_POLL_FREQUENCIES.EVERY_MINUTES,
    params,
    features: featureDefs(appliance, lang).map(({ key, name, spec }) => ({
      name,
      external_id: ids.feature(key),
      ...spec,
    })),
  };
}

/**
 * The states of an appliance, keyed by feature key (a number, or `{ text }`).
 * A value the appliance does not give is left out: Gladys keeps the last one.
 * @param {ReturnType<typeof parseAppliance>} appliance
 * @param {{ language: string, now: number }} options
 */
export function stateValues(appliance, { language, now }) {
  const values = {};
  const connected = isConnected(appliance);
  for (const def of featureDefs(appliance, language)) {
    if (!connected && def.key !== 'status') {
      // Not connected: the last known values stay, the state says why.
      continue;
    }
    const value = def.read(now);
    if (value !== null && value !== undefined) {
      values[def.key] = value;
    }
  }
  return values;
}

/** The states of an appliance in the `publishStates` format. */
export function buildStates(gladys, appliance, options) {
  const ids = idsOf(gladys, appliance.id);
  return Object.entries(stateValues(appliance, options)).map(([key, value]) =>
    typeof value === 'number'
      ? { device_feature_external_id: ids.feature(key), state: value }
      : { device_feature_external_id: ids.feature(key), text: value.text },
  );
}
