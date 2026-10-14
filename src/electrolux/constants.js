// -----------------------------------------------------------------------------
// Electrolux Group Developer API: endpoints, appliance types, the vocabulary
// of the states, and the quota the API enforces per API key.
//
// Sources: the official Python SDK (electrolux-oss/electrolux-group-developer-sdk,
// Apache-2.0) for the endpoints, the types and the command values; the quota
// figures are the ones the electrolux-to-mqtt bridge (MIT) documents from the
// developer portal ("Quotas and rate limits" page, not reachable from here).
// -----------------------------------------------------------------------------

export const API_BASE_URL = 'https://api.developer.electrolux.one';

export const PATHS = {
  TOKEN_REFRESH: '/api/v1/token/refresh',
  APPLIANCES: '/api/v1/appliances',
  INFO: (id) => `/api/v1/appliances/${encodeURIComponent(id)}/info`,
  STATE: (id) => `/api/v1/appliances/${encodeURIComponent(id)}/state`,
  COMMAND: (id) => `/api/v1/appliances/${encodeURIComponent(id)}/command`,
  LIVESTREAM: '/api/v1/configurations/livestream',
};

/** Where the developer creates the API key and the tokens. */
export const PORTAL_URL = 'https://developer.electrolux.one/dashboard';

/**
 * Quota of the API, per API key: 5000 calls a day, 10 a second, 5 at once.
 * The integration keeps to a fraction of it (src/hub.js): the user may use the
 * same key elsewhere, and a restart costs a full read.
 */
export const QUOTA = { PER_DAY: 5000, PER_SECOND: 10, CONCURRENT: 5 };

/**
 * Families of appliances, from the `applianceType` of GET /appliances (the
 * official SDK's APPLIANCE_TYPE_CLASS_MAP), the `deviceType` of the info as a
 * fallback.
 */
const FAMILY_BY_TYPE = {
  WM: 'washer',
  WD: 'washer_dryer',
  TD: 'dryer',
  DW: 'dishwasher',
  OV: 'oven',
  SO: 'oven',
  HB: 'hob',
  HD: 'hood',
  CR: 'fridge',
  AC: 'air_conditioner',
  CA: 'air_conditioner',
  AZUL: 'air_conditioner',
  BOGONG: 'air_conditioner',
  PANTHER: 'air_conditioner',
  TELICA: 'air_conditioner',
  DAM_AC: 'air_conditioner',
  FUJI: 'purifier',
  MUJU: 'purifier',
  PUREA9: 'purifier',
  VERBIER: 'purifier',
  WELLA5: 'purifier',
  WELLA7: 'purifier',
  DH: 'dehumidifier',
  HUSKY: 'dehumidifier',
  '700SERIES': 'robot',
  PUREI9: 'robot',
  GORDIAS: 'robot',
  CYBELE: 'robot',
};

const FAMILY_BY_DEVICE_TYPE = [
  [/WASHER_DRYER|WASHER-DRYER/, 'washer_dryer'],
  [/WASHING_MACHINE|WASHER/, 'washer'],
  [/DRYER/, 'dryer'],
  [/DISH/, 'dishwasher'],
  [/OVEN/, 'oven'],
  [/HOB/, 'hob'],
  [/HOOD/, 'hood'],
  [/FRIDGE|FREEZER|REFRIGERATOR|MULTIDOOR|FREESTANDING/, 'fridge'],
  [/AIR_CONDITIONER/, 'air_conditioner'],
  [/PURIFIER/, 'purifier'],
  [/DEHUMIDIFIER/, 'dehumidifier'],
  [/VACUUM/, 'robot'],
];

/**
 * @param {string} applianceType from GET /appliances
 * @param {string} [deviceType] from GET /appliances/{id}/info
 */
export function familyOf(applianceType, deviceType) {
  const byType = FAMILY_BY_TYPE[String(applianceType ?? '').toUpperCase()];
  if (byType) {
    return byType;
  }
  const upper = String(deviceType ?? '').toUpperCase();
  return FAMILY_BY_DEVICE_TYPE.find(([pattern]) => pattern.test(upper))?.[1] ?? 'other';
}

/** Families that run a program with a duration (washing, drying, dishes). */
export const CYCLE_FAMILIES = ['washer', 'washer_dryer', 'dryer', 'dishwasher'];

/** `applianceState` values, upper-cased (the DAM appliances write them in lower case). */
export const STATE = {
  OFF: 'OFF',
  IDLE: 'IDLE',
  READY_TO_START: 'READY_TO_START',
  DELAYED_START: 'DELAYED_START',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  END_OF_CYCLE: 'END_OF_CYCLE',
  ALARM: 'ALARM',
};

/** A program is under way: time left and expected end mean something. */
export const ACTIVE_STATES = [STATE.RUNNING, STATE.PAUSED, STATE.DELAYED_START];

/** `remoteControl` values: only ENABLED lets a program be started or paused. */
export const REMOTE_CONTROL = {
  ENABLED: 'ENABLED',
  NOT_SAFETY_RELEVANT_ENABLED: 'NOT_SAFETY_RELEVANT_ENABLED',
  DISABLED: 'DISABLED',
  TEMPORARY_LOCKED: 'TEMPORARY_LOCKED',
};

/** `executeCommand` values of the programs. */
export const EXECUTE = {
  START: 'START',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  STOP: 'STOPRESET',
};

/** Robot vacuum `robotStatus` codes (Pure i9 protocol). */
export const ROBOT_CLEANING = [1, 3];
export const ROBOT_PAUSED = [2, 4, 6, 8];
export const ROBOT_ERROR = 11;
