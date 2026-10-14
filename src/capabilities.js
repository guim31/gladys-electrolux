// -----------------------------------------------------------------------------
// Reading the capabilities and the reported state of an appliance.
//
// GET /appliances/{id}/info describes what an appliance has, in three shapes
// the official SDK fixtures all show:
//   - flat paths: { "doorState": {...}, "userSelections/programUID": {...} };
//   - nested objects without a type: { "fridge": { "targetTemperatureC": {...} } };
//   - DAM objects: { "airConditioner": { "type": "object", "properties": {...} } }.
// They are all flattened to `path → capability` ("fridge/targetTemperatureC").
// The reported state (GET /state, `properties.reported`) nests the same way,
// and the live stream names a property by the same path.
//
// A capability can carry `triggers`: "when this value equals X, that command
// accepts these values" (e.g. applianceState RUNNING → executeCommand PAUSE).
// They tell which program command an appliance accepts right now.
// -----------------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A capability leaf: it declares an access or a scalar type. */
function isLeaf(value) {
  return (
    isObject(value) &&
    (typeof value.access === 'string' ||
      (typeof value.type === 'string' && value.type !== 'object'))
  );
}

/**
 * Flatten the capabilities to `{ path: capability }`.
 * @param {object} capabilities
 */
export function flattenCapabilities(capabilities) {
  const flat = {};
  const walk = (node, prefix) => {
    if (!isObject(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}/${key}` : key;
      if (isLeaf(value)) {
        flat[path] = value;
      } else if (isObject(value) && value.type === 'object') {
        walk(value.properties, path);
      } else if (isObject(value)) {
        walk(value, path);
      }
    }
  };
  walk(capabilities, '');
  return flat;
}

/**
 * A value of the reported state by path ("fridge/doorState"), or undefined.
 * @param {object} reported
 * @param {string} path
 */
export function readPath(reported, path) {
  let node = reported;
  for (const part of path.split('/')) {
    if (!isObject(node)) {
      return undefined;
    }
    node = node[part];
  }
  return node;
}

/**
 * Write a value of the reported state by path (a live stream update).
 * @param {object} reported mutated
 * @param {string} path
 * @param {unknown} value
 */
export function writePath(reported, path, value) {
  const parts = path.split('/');
  let node = reported;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(node[part])) {
      node[part] = {};
    }
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

/** The nested body of a command on a path: "fridge/fastMode", "ON" → { fridge: { fastMode: "ON" } }. */
export function bodyFor(path, value) {
  const body = {};
  writePath(body, path, value);
  return body;
}

/** The listed values of a capability (`values` keys), in the API's own case. */
export function valuesOf(capability) {
  return isObject(capability?.values) ? Object.keys(capability.values) : [];
}

/** The listed values not marked `disabled`. */
export function enabledValuesOf(capability) {
  if (!isObject(capability?.values)) {
    return [];
  }
  return Object.entries(capability.values)
    .filter(([, meta]) => !(isObject(meta) && meta.disabled === true))
    .map(([value]) => value);
}

/** Whether a capability may be written. */
export function isWritable(capability) {
  return typeof capability?.access === 'string' && capability.access.includes('write');
}

/** Whether a capability may be read. */
export function isReadable(capability) {
  return (
    isObject(capability) &&
    (capability.access === undefined ||
      capability.access.includes('read') ||
      capability.access === 'constant')
  );
}

/**
 * Numeric range of a capability: `min`/`max`/`step`, a DAM `range: [min, max,
 * step]`, or the numeric keys of `values`. Null when nothing says it.
 * @param {object} capability
 */
export function rangeOf(capability) {
  if (!isObject(capability)) {
    return null;
  }
  if (Array.isArray(capability.range) && capability.range.length >= 2) {
    const [min, max, step] = capability.range.map(Number);
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
      return { min, max, step: Number.isFinite(step) && step > 0 ? step : 1 };
    }
  }
  const min = Number(capability.min);
  const max = Number(capability.max);
  if (
    capability.min !== undefined &&
    capability.max !== undefined &&
    Number.isFinite(min) &&
    Number.isFinite(max) &&
    min <= max
  ) {
    const step = Number(capability.step);
    return { min, max, step: Number.isFinite(step) && step > 0 ? step : 1 };
  }
  const listed = valuesOf(capability)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (listed.length > 0) {
    return { min: listed[0], max: listed.at(-1), step: null, values: listed };
  }
  return null;
}

/** Whether a trigger condition holds for a value (`eq`, `ne`, `and`, `or`). */
function conditionHolds(condition, value) {
  if (!isObject(condition)) {
    return false;
  }
  const { operator, operand_1: left, operand_2: right } = condition;
  if (operator === 'and') {
    return conditionHolds(left, value) && conditionHolds(right, value);
  }
  if (operator === 'or') {
    return conditionHolds(left, value) || conditionHolds(right, value);
  }
  const resolve = (operand) => (operand === 'value' ? value : operand);
  const a = String(resolve(left));
  const b = String(resolve(right));
  if (operator === 'eq') {
    return a.toUpperCase() === b.toUpperCase();
  }
  if (operator === 'ne') {
    return a.toUpperCase() !== b.toUpperCase();
  }
  return false;
}

/**
 * What the triggers of `sourcePath` say about `targetPath` for the current
 * value of the source: the values it accepts, whether it is disabled. Null
 * when no trigger matches (the API decides).
 * @param {Record<string, object>} capabilities flattened
 * @param {string} sourcePath e.g. "applianceState"
 * @param {unknown} sourceValue
 * @param {string} targetPath e.g. "executeCommand"
 * @returns {{ values: string[]|null, disabled: boolean }|null}
 */
export function triggeredRule(capabilities, sourcePath, sourceValue, targetPath) {
  const triggers = capabilities[sourcePath]?.triggers;
  if (!Array.isArray(triggers) || sourceValue === undefined || sourceValue === null) {
    return null;
  }
  let values = null;
  let disabled = null;
  for (const trigger of triggers) {
    const action = trigger?.action?.[targetPath];
    if (!isObject(action) || !conditionHolds(trigger.condition, sourceValue)) {
      continue;
    }
    if (isObject(action.values)) {
      values = [...(values ?? []), ...Object.keys(action.values)];
    }
    if (typeof action.disabled === 'boolean') {
      disabled = action.disabled;
    }
  }
  if (values === null && disabled === null) {
    return null;
  }
  return { values, disabled: disabled === true };
}
