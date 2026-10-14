// -----------------------------------------------------------------------------
// The live picture of the Electrolux account, and everything that follows.
//
// Sources, in order of preference:
//   1. the live stream (src/electrolux/livestream.js): every property change
//      within seconds, one call per connection;
//   2. a full read by the container's own timer (GET /appliances, then the
//      state of each appliance, its capabilities only when they changed):
//      every 30 minutes while the stream is up (the safety net, and the
//      heartbeat of the values that never change), and while it is down as
//      often as the quota allows (READ_BUDGET_PER_DAY, 2 minutes at best);
//   3. the core's onPoll, a fallback only: Gladys#3198 makes it unreliable,
//      and it is skipped whenever the container read recently.
//
// The quota is 5000 calls a day per API key: a full read costs 1 + one per
// appliance, so the fallback period grows with the number of appliances. The
// client refuses reads past 80 % of the quota and stops after a 429.
//
// What follows from a change: the states of the devices the user added (only
// the changes, `publishChangedStates`), their cloud/unreachable badge, the
// scene triggers (`cycle_finished`, `appliance_alert`: one event per
// transition, never at startup), and a nudge to the dashboard widget.
//
// Logs stay quiet: a normal cycle writes nothing at info level. The life
// cycle does (account connected, appliance found, stream lost and back, one
// line per user command), and a repeated failure writes one line when it
// starts and one when it is over (src/issues.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  alertCodes,
  alertText,
  applianceName,
  buildDevice,
  buildStates,
  cycleTiming,
  idsOf,
  isConnected,
  parseAppliance,
  programText,
  statusKey,
} from './appliances.js';
import { writePath } from './capabilities.js';
import { CommandError } from './command-error.js';
import { featureCommand, programCommand } from './commands.js';
import { hasCredentials } from './config.js';
import { CYCLE_FAMILIES } from './electrolux/constants.js';
import {
  ElectroluxApiError,
  QuotaError,
  ReauthorizationRequiredError,
} from './electrolux/client.js';
import { startLiveStream } from './electrolux/livestream.js';
import { COMMAND_TEXT, CONNECTION_TEXT, STATUS_TEXT, fillAll, pickLanguage } from './i18n.js';
import { createIssueLog } from './issues.js';

export const READ_PERIOD_STREAMING_MS = 30 * 60 * 1000;
export const READ_PERIOD_MIN_MS = 2 * 60 * 1000;
/** Calls a day the periodic reads may spend (the quota is 5000; the rest is margin). */
export const READ_BUDGET_PER_DAY = 2000;
/** A value that never changes is sent again this often (Gladys flags 48 h). */
export const HEARTBEAT_MS = 6 * 60 * 60 * 1000;
/** Stream changes of one appliance arriving together are published together. */
export const COALESCE_MS = 300;
/** Wait before the next stream attempt when Electrolux refuses it. */
export const STREAM_REFUSED_DELAY_MS = 60 * 60 * 1000;
export const WIDGET_KEY = 'running_appliances';
export const TRIGGERS = { FINISHED: 'cycle_finished', ALERT: 'appliance_alert' };

const defaultLogger = createLogger({ name: 'electrolux' });

/** Families whose end of program is news (the `cycle_finished` trigger). */
const FINISHING_FAMILIES = [...CYCLE_FAMILIES, 'oven'];
const RUNNING_KEYS = ['RUNNING', 'PAUSED'];

/**
 * Period of the full read while the stream is down, for this many appliances.
 * @param {number} count
 */
export function fallbackPeriod(count) {
  const perRead = 1 + Math.max(1, count);
  return Math.max(READ_PERIOD_MIN_MS, Math.ceil((86_400_000 * perRead) / READ_BUDGET_PER_DAY));
}

/**
 * @param {object} options
 * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
 * @param {ReturnType<import('./electrolux/client.js').createElectroluxClient>} options.client
 * @param {() => object} options.getConfig the current normalized config
 * @param {() => number} [options.now]
 * @param {boolean} [options.timers] run the periodic read (tests may turn it off)
 * @param {boolean} [options.stream] open the live stream (tests may turn it off)
 * @param {object} [options.streamTiming] reconnection timing (tests)
 * @param {{ streamingMs?: number, fallbackMs?: number }} [options.periods] read periods (tests)
 * @param {number} [options.coalesceMs]
 * @param {number} [options.commandRereadMs] read again after a command, stream down
 * @param {object} [options.logger]
 */
export function createHub({
  gladys,
  client,
  getConfig,
  now = () => Date.now(),
  timers = true,
  stream: useStream = true,
  streamTiming,
  periods = {},
  coalesceMs = COALESCE_MS,
  commandRereadMs = 5_000,
  logger = defaultLogger,
}) {
  const issues = createIssueLog(logger);
  /** applianceId → parsed appliance */
  const appliances = new Map();
  /** applianceId → { info, hash } (capabilities change with a firmware only) */
  const infos = new Map();
  /** applianceId → { status, alerts, left } seen last, for the triggers */
  const previous = new Map();
  /** applianceId → last transport published */
  const transports = new Map();
  /** appliance ids already announced in the logs */
  const announced = new Set();
  /** applianceId → timer of a coalesced stream update */
  const pending = new Map();
  let published = new Set();
  let lastReadAt = null;
  let reading = null;
  let stream = null;
  let streamUrl = null;
  let streamUp = false;
  let streamEverUp = false;
  let timer = null;
  let running = false;
  let configured = false;
  let accountAnnounced = false;
  let reported = null;
  let widgetSignature = '';

  const language = () => getConfig().language;
  const streamingMs = periods.streamingMs ?? READ_PERIOD_STREAMING_MS;
  const period = () =>
    streamUp ? streamingMs : (periods.fallbackMs ?? fallbackPeriod(appliances.size));
  const createdIds = () => new Set((gladys.devices ?? []).map((device) => device.external_id));

  /** The connection badge of the Configuration screen, sent on change only. */
  async function report(key) {
    if (reported === key) {
      return;
    }
    reported = key;
    try {
      if (key === 'ok') {
        await gladys.setConnectionStatus(true);
      } else {
        await gladys.setConnectionStatus(false, CONNECTION_TEXT[key]);
      }
    } catch (err) {
      reported = null;
      logger.debug(`Connection status not sent (${err.message})`);
    }
  }

  /** A failed exchange with Electrolux: logged once while it lasts, badge updated. */
  async function handleFailure(key, label, err) {
    if (err instanceof ReauthorizationRequiredError) {
      issues.fail(
        'auth',
        `Electrolux refused the tokens, a new token pair is needed (${err.message})`,
      );
      await report('reauthorize');
      return;
    }
    if (err instanceof QuotaError) {
      issues.fail('quota', `Electrolux API quota: reads paused (${err.message})`);
      await report('quota');
      return;
    }
    issues.fail(key, `${label} failed (${err.message})`);
    await report('unreachable');
  }

  function findId(externalId) {
    for (const id of appliances.keys()) {
      if (idsOf(gladys, id).device === externalId) {
        return id;
      }
    }
    return null;
  }

  /** The name the user sees: the Gladys device name, else ours. */
  function displayName(id) {
    const ids = idsOf(gladys, id);
    const created = (gladys.devices ?? []).find((device) => device.external_id === ids.device);
    return created?.name || applianceName(appliances.get(id), language());
  }

  async function publishDiscovered() {
    const list = [...appliances.values()];
    for (const appliance of list) {
      if (!announced.has(appliance.id)) {
        announced.add(appliance.id);
        logger.info(
          `Electrolux appliance found: ${applianceName(appliance, language())} (${appliance.family}${appliance.model ? `, ${appliance.model}` : ''})`,
        );
      }
    }
    try {
      await gladys.publishDiscoveredDevices(
        list.map((appliance) => buildDevice(gladys, appliance, language())),
      );
      published = new Set(list.map((appliance) => appliance.id));
      issues.ok('discovery', 'Appliances published to Gladys again');
    } catch (err) {
      issues.fail('discovery', `Publishing the appliances to Gladys failed (${err.message})`);
    }
  }

  /** States of the given appliances, those the user added only. */
  async function publishStates(list, { onlyIds } = {}) {
    const created = onlyIds ?? createdIds();
    const states = list
      .filter((appliance) => created.has(idsOf(gladys, appliance.id).device))
      .flatMap((appliance) => buildStates(gladys, appliance, { language: language(), now: now() }));
    if (states.length === 0) {
      return;
    }
    try {
      const result = await gladys.publishChangedStates(states, { heartbeat: HEARTBEAT_MS });
      logger.debug(`${result?.count ?? 0} state(s) sent to Gladys`);
      issues.ok('states', 'States reach Gladys again');
    } catch (err) {
      issues.fail('states', `Sending the states to Gladys failed (${err.message})`);
    }
  }

  async function publishTransports(list, { force = false } = {}) {
    const created = createdIds();
    const entries = [];
    for (const appliance of list) {
      const externalId = idsOf(gladys, appliance.id).device;
      const transport = isConnected(appliance) ? 'cloud' : 'unreachable';
      if (!created.has(externalId) || (!force && transports.get(appliance.id) === transport)) {
        continue;
      }
      if (transports.has(appliance.id) && transports.get(appliance.id) !== transport) {
        logger.info(
          `${displayName(appliance.id)}: ${transport === 'cloud' ? 'connected to the Electrolux cloud again' : 'not connected to the Electrolux cloud'}`,
        );
      }
      transports.set(appliance.id, transport);
      entries.push({ external_id: externalId, transport });
    }
    if (entries.length > 0) {
      await gladys.publishTransports(entries).catch((err) => {
        logger.debug(`Transport badges not sent (${err.message})`);
      });
    }
  }

  /** Scene events for the transitions of one appliance. */
  async function fireTriggers(appliance) {
    if (!isConnected(appliance)) {
      return;
    }
    const before = previous.get(appliance.id);
    const status = statusKey(appliance);
    const alerts = alertCodes(appliance);
    const { left } = cycleTiming(appliance);
    const program = String(
      appliance.reported.userSelections?.programUID ?? appliance.reported.program ?? '',
    );
    previous.set(appliance.id, {
      status,
      alerts,
      left,
      program: RUNNING_KEYS.includes(status) && program ? program : (before?.program ?? ''),
    });
    if (!before) {
      // First sight (startup, new appliance): a state, not a transition.
      return;
    }
    const device = idsOf(gladys, appliance.id).device;
    const name = displayName(appliance.id);
    const events = [];
    const wasRunning = RUNNING_KEYS.includes(before.status);
    const endedNow = status === 'END_OF_CYCLE' && before.status !== 'END_OF_CYCLE';
    // Some appliances go back to idle without an "end of cycle" state: a
    // program that ran its time out counts as finished, a stop at mid-cycle not.
    const ranOut =
      ['IDLE', 'OFF'].includes(status) && before.status === 'RUNNING' && (before.left ?? 0) <= 120;
    if (FINISHING_FAMILIES.includes(appliance.family) && wasRunning && (endedNow || ranOut)) {
      events.push([
        TRIGGERS.FINISHED,
        { device, device_name: name, program: programText(program || before.program) ?? '' },
      ]);
    }
    const fresh = alerts.filter((code) => !before.alerts.includes(code)).slice(0, 5);
    for (const code of fresh) {
      events.push([
        TRIGGERS.ALERT,
        { device, device_name: name, alert: alertText(code, language()), code },
      ]);
    }
    if (fresh.length === 0 && status === 'ALARM' && before.status !== 'ALARM') {
      events.push([
        TRIGGERS.ALERT,
        {
          device,
          device_name: name,
          alert: STATUS_TEXT[pickLanguage(language())].ALARM,
          code: 'ALARM',
        },
      ]);
    }
    for (const [key, data] of events) {
      logger.debug(`Scene trigger ${key} for ${name}`);
      await gladys.publishSceneEvent(key, data).catch((err) => {
        logger.warn(`Scene trigger ${key} not delivered (${err.message})`);
      });
    }
  }

  /** Nudge the widget when what it lists changes (states, not minutes). */
  function nudgeWidget({ force = false } = {}) {
    const signature = JSON.stringify(
      [...appliances.values()].map((appliance) => [appliance.id, statusKey(appliance)]),
    );
    if (!force && signature === widgetSignature) {
      return;
    }
    widgetSignature = signature;
    try {
      gladys.requestWidgetRefresh(WIDGET_KEY);
    } catch (err) {
      logger.debug(`Widget refresh not requested (${err.message})`);
    }
  }

  /** Take in appliances read from the API or changed by the stream. */
  async function apply(list) {
    let unknown = false;
    for (const appliance of list) {
      if (!published.has(appliance.id)) {
        unknown = true;
      }
      appliances.set(appliance.id, appliance);
    }
    for (const appliance of list) {
      await fireTriggers(appliance);
    }
    if (unknown) {
      await publishDiscovered();
    }
    await publishStates(list);
    await publishTransports(list);
    nudgeWidget();
  }

  /** State (and capabilities when they changed) of one appliance of the list. */
  async function readOne(entry) {
    const state = await client.getState(entry.applianceId);
    const hash = state?.properties?.reported?.applianceInfo?.capabilityHash ?? null;
    const known = infos.get(entry.applianceId);
    if (!known || (hash && known.hash && known.hash !== hash)) {
      try {
        infos.set(entry.applianceId, { info: await client.getInfo(entry.applianceId), hash });
      } catch (err) {
        if (err instanceof ReauthorizationRequiredError || err instanceof QuotaError) {
          throw err;
        }
        logger.debug(`Capabilities of an appliance not read (${err.message})`);
      }
    }
    return parseAppliance(entry, infos.get(entry.applianceId)?.info ?? null, state);
  }

  /**
   * Full read of the account, unless one ran less than `minAgeMs` ago.
   * Concurrent callers share the read in progress. Never throws.
   */
  function refresh({ minAgeMs = 0 } = {}) {
    if (reading) {
      return reading;
    }
    if (!configured || (lastReadAt !== null && now() - lastReadAt < minAgeMs)) {
      return Promise.resolve();
    }
    reading = (async () => {
      try {
        const entries = (await client.getAppliances()) ?? [];
        lastReadAt = now();
        const list = [];
        for (const entry of Array.isArray(entries) ? entries : []) {
          if (typeof entry?.applianceId !== 'string') {
            continue;
          }
          try {
            list.push(await readOne(entry));
          } catch (err) {
            if (err instanceof ReauthorizationRequiredError || err instanceof QuotaError) {
              throw err;
            }
            logger.debug(`An appliance was not read (${err.message})`);
          }
        }
        issues.ok('read', 'Electrolux cloud reachable again');
        issues.ok('auth', 'Electrolux tokens accepted again');
        issues.ok('quota', 'Electrolux API quota available again');
        await report('ok');
        if (!accountAnnounced) {
          accountAnnounced = true;
          logger.info(`Electrolux account connected: ${list.length} appliance(s)`);
        }
        await apply(list);
      } catch (err) {
        await handleFailure('read', 'Reading the Electrolux appliances', err);
      } finally {
        reading = null;
      }
    })();
    return reading;
  }

  /** Read one appliance again (after a command, stream down). */
  async function refreshOne(id) {
    const appliance = appliances.get(id);
    if (!appliance) {
      return;
    }
    try {
      const state = await client.getState(id);
      const entry = {
        applianceId: id,
        applianceName: appliance.name,
        applianceType: appliance.type,
      };
      await apply([parseAppliance(entry, infos.get(id)?.info ?? null, state)]);
    } catch (err) {
      logger.debug(`Reading an appliance again failed (${err.message})`);
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!timers || !running) {
      return;
    }
    const delay = period();
    timer = setTimeout(async () => {
      timer = null;
      await refresh({ minAgeMs: delay / 2 });
      schedule();
    }, delay);
    timer.unref?.();
  }

  /** One property of one appliance changed (live stream). */
  function onStreamEvent(data) {
    const id = data?.applianceId;
    const property = data?.property;
    if (typeof id !== 'string' || typeof property !== 'string' || !('value' in data)) {
      logger.debug('Live stream event ignored');
      return;
    }
    const appliance = appliances.get(id);
    if (!appliance) {
      // A new appliance: read the account (at most every 5 minutes).
      refresh({ minAgeMs: 5 * 60 * 1000 });
      return;
    }
    if (property === 'connectionState') {
      appliance.connectionState = data.value;
    } else {
      writePath(appliance.reported, property, data.value);
      if (property === 'connectivityState') {
        appliance.connectionState = data.value;
      }
    }
    if (pending.has(id)) {
      return;
    }
    const flush = setTimeout(() => {
      pending.delete(id);
      apply([appliances.get(id)]).catch((err) =>
        logger.debug(`Live stream update failed (${err.message})`),
      );
    }, coalesceMs);
    flush.unref?.();
    pending.set(id, flush);
  }

  function onStreamStatus(state, err) {
    if (state === 'connected') {
      const wasDown = !streamUp;
      streamUp = true;
      if (!streamEverUp) {
        streamEverUp = true;
        logger.info('Electrolux live stream connected');
      } else {
        issues.ok('stream', 'Electrolux live stream is back');
      }
      if (wasDown) {
        // What happened while it was down: read once, unless just done.
        refresh({ minAgeMs: 5 * 60 * 1000 });
        schedule();
      }
      return;
    }
    const wasUp = streamUp;
    streamUp = false;
    if (state === 'failed') {
      if (
        err instanceof ElectroluxApiError &&
        [401, 403, 404, 0].includes(err.status) &&
        !(err instanceof QuotaError)
      ) {
        streamUrl = null;
      }
      if (err instanceof ReauthorizationRequiredError || err instanceof QuotaError) {
        handleFailure('stream', 'Electrolux live stream', err);
      } else {
        issues.fail(
          'stream',
          `Electrolux live stream unavailable (${err?.message ?? 'closed'}), reading every ${Math.round(fallbackPeriod(appliances.size) / 60000)} minutes meanwhile`,
        );
      }
    } else {
      logger.debug('Electrolux live stream closed, reopening');
    }
    if (wasUp) {
      schedule();
    }
  }

  function startStream() {
    stream?.stop();
    stream = null;
    if (!useStream) {
      return;
    }
    stream = startLiveStream({
      open: async (signal) => {
        if (!streamUrl) {
          const config = await client.getLivestreamConfig();
          if (typeof config?.url !== 'string' || config.url === '') {
            throw new ElectroluxApiError(404, 'Electrolux sent no live stream URL');
          }
          streamUrl = config.url;
        }
        return client.openStream(streamUrl, signal);
      },
      onEvent: onStreamEvent,
      onStatus: onStreamStatus,
      retryDelay: (err) => {
        if (err instanceof QuotaError) {
          return Math.max(60_000, (err.until ?? 0) - now());
        }
        if (err instanceof ReauthorizationRequiredError) {
          return STREAM_REFUSED_DELAY_MS;
        }
        if (err instanceof ElectroluxApiError && [403, 404, 429].includes(err.status)) {
          return STREAM_REFUSED_DELAY_MS;
        }
        return null;
      },
      timing: streamTiming,
      now,
    });
  }

  function stopAll() {
    running = false;
    clearTimeout(timer);
    timer = null;
    stream?.stop();
    stream = null;
    streamUp = false;
    for (const flush of pending.values()) {
      clearTimeout(flush);
    }
    pending.clear();
  }

  /** Turn a failed command into the message the user reads. */
  function commandFailure(err) {
    if (err instanceof CommandError) {
      return err;
    }
    if (err instanceof ReauthorizationRequiredError) {
      return new CommandError(COMMAND_TEXT.notLinked, language());
    }
    if (err instanceof QuotaError) {
      return new CommandError(COMMAND_TEXT.quota, language());
    }
    const detail = err instanceof ElectroluxApiError ? `HTTP ${err.status}` : err.message;
    return new CommandError(fillAll(COMMAND_TEXT.failed, { detail }), language());
  }

  /**
   * Check then send a user command: one info line whatever the outcome.
   * @param {string} id
   * @param {() => object} buildBody throws a CommandError when refused
   * @param {string} what for the log line
   */
  async function send(id, buildBody, what) {
    const name = displayName(id);
    try {
      await client.sendCommand(id, buildBody());
    } catch (err) {
      const failure = commandFailure(err);
      logger.info(`${what} on ${name} refused: ${failure.message}`);
      throw failure;
    }
    logger.info(`${what} sent to ${name}`);
    if (!streamUp) {
      // No stream to report the result: read that appliance again shortly.
      setTimeout(() => refreshOne(id), commandRereadMs).unref?.();
    }
  }

  function applianceFor(externalId) {
    const id = findId(externalId);
    const appliance = id ? appliances.get(id) : null;
    if (!appliance) {
      throw new CommandError(COMMAND_TEXT.unknownDevice, language());
    }
    return appliance;
  }

  return {
    get appliances() {
      return appliances;
    },
    get configured() {
      return configured;
    },
    get streamUp() {
      return streamUp;
    },
    get period() {
      return period();
    },

    /** (Re)start: on connection to Gladys, a new configuration. */
    async start() {
      stopAll();
      running = true;
      appliances.clear();
      infos.clear();
      previous.clear();
      published = new Set();
      transports.clear();
      lastReadAt = null;
      reported = null;
      streamUrl = null;
      gladys.forgetPublishedStates?.();
      configured = hasCredentials(getConfig());
      if (!configured) {
        await report('missingCredentials');
        nudgeWidget({ force: true });
        return;
      }
      await refresh();
      if (!running) {
        return;
      }
      startStream();
      schedule();
    },

    stop: stopAll,

    refresh,

    /** The core's onPoll (fallback): reads unless the container just did. */
    async poll() {
      await refresh({ minAgeMs: period() * 0.9 });
    },

    /** Gladys asks for the device list (Discover tab): no new read when recent. */
    async scan() {
      await refresh({ minAgeMs: 60_000 });
      await publishDiscovered();
    },

    /** A device was added (or updated) in Gladys: send everything now. */
    async deviceCreated(device) {
      const id = findId(device.external_id);
      if (!id) {
        return;
      }
      await publishStates([appliances.get(id)], { onlyIds: new Set([device.external_id]) });
      transports.delete(id);
      await publishTransports([appliances.get(id)], { force: true });
      nudgeWidget({ force: true });
    },

    /** onSetValue: a command on a feature (power, setpoint, mode…). */
    async setValue(device, feature, value) {
      const appliance = applianceFor(device.external_id);
      const key = feature.external_id.slice(device.external_id.length + 1);
      await send(
        appliance.id,
        () => featureCommand(appliance, key, value, language()),
        `Command ${key}=${value}`,
      );
    },

    /** The `appliance_command` scene action. */
    async runCommand(deviceExternalId, command) {
      const appliance = applianceFor(deviceExternalId);
      await send(
        appliance.id,
        () =>
          programCommand(appliance, command, {
            language: language(),
            allowRemoteStart: getConfig().allow_remote_start,
          }),
        `Command ${command}`,
      );
    },

    displayName,
    findId,
  };
}
