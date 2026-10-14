// -----------------------------------------------------------------------------
// The integration, wired on a Gladys client: every handler registered before
// connect(). index.js gives it the real client; the tests give it the SDK's
// fake Gladys and a fake Electrolux (`fetch`), and run it end to end.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  ElectroluxApiError,
  QuotaError,
  ReauthorizationRequiredError,
  createElectroluxClient,
} from './electrolux/client.js';
import { createTokenStore } from './electrolux/token-store.js';
import { createHub } from './hub.js';
import { TEST_TEXT, fillAll } from './i18n.js';
import { createSceneActions } from './scenes.js';
import { createWidgets } from './widgets.js';

const defaultLogger = createLogger({ name: 'electrolux' });

/**
 * @param {object} options
 * @param {object} options.gladys GladysIntegration, or the SDK's fake Gladys
 * @param {typeof fetch} [options.fetch] the network (a fake Electrolux in the tests)
 * @param {string} [options.dataDir] where the tokens live (/data)
 * @param {() => number} [options.now]
 * @param {boolean} [options.timers] periodic reads (off in most tests)
 * @param {boolean} [options.stream] live stream (off in most tests)
 * @param {object} [options.hubOptions] timing overrides of the hub (tests)
 * @param {number} [options.minGapMs] spacing of the API calls (tests)
 * @param {object} [options.logger]
 */
export function createApp({
  gladys,
  fetch = globalThis.fetch,
  dataDir,
  now = () => Date.now(),
  timers = true,
  stream = true,
  hubOptions = {},
  minGapMs,
  logger = defaultLogger,
}) {
  let config = normalizeConfig(gladys.config ?? {});
  const getConfig = () => config;
  const store = createTokenStore({ dir: dataDir });
  const client = createElectroluxClient({ getConfig, store, fetch, now, minGapMs });
  const hub = createHub({ gladys, client, getConfig, now, timers, stream, logger, ...hubOptions });
  const restart = () => hub.start().catch((err) => logger.error(`Start failed (${err.message})`));

  // --- Devices ----------------------------------------------------------------
  gladys.onScanRequest(() => hub.scan());
  gladys.onPoll(() => hub.poll());
  gladys.onSetValue((device, feature, value) => hub.setValue(device, feature, value));
  gladys.onDeviceCreated((device) => hub.deviceCreated(device));
  gladys.onDeviceUpdated((device) => hub.deviceCreated(device));

  // --- Configuration action -----------------------------------------------------
  gladys.onAction('test_connection', async () => {
    try {
      const list = await client.getAppliances();
      const names = (Array.isArray(list) ? list : [])
        .map((entry) => entry?.applianceName || entry?.applianceType)
        .filter(Boolean);
      logger.info(`Connection test: ${names.length} appliance(s)`);
      if (names.length === 0) {
        return TEST_TEXT.none;
      }
      return fillAll(TEST_TEXT.ok, {
        n: names.length,
        list: names.join(', ').slice(0, 120),
        calls: client.callsToday(),
      });
    } catch (err) {
      const detail =
        err instanceof ReauthorizationRequiredError ||
        err instanceof ElectroluxApiError ||
        err instanceof QuotaError
          ? err.message
          : `network (${err.message})`;
      logger.info(`Connection test failed: ${detail}`);
      throw new Error(fillAll(TEST_TEXT.failed, { detail })[config.language], { cause: err });
    }
  });

  // --- Scenes and widgets -------------------------------------------------------
  for (const [key, handler] of Object.entries(createSceneActions({ hub }))) {
    gladys.onSceneAction(key, handler);
  }
  for (const [key, widget] of Object.entries(createWidgets({ gladys, hub }))) {
    gladys.onWidgetGet(key, widget.get);
  }

  // --- Life cycle ---------------------------------------------------------------
  gladys.onConfigUpdated(async (raw) => {
    const next = normalizeConfig(raw);
    const changed = JSON.stringify(next) !== JSON.stringify(config);
    if (next.refresh_token !== config.refresh_token || next.api_key !== config.api_key) {
      client.reset();
    }
    config = next;
    if (changed) {
      logger.info('Configuration updated');
      await restart();
    }
  });

  gladys.on('connected', async () => {
    config = normalizeConfig(gladys.config ?? (await gladys.getConfig()));
    await restart();
  });

  gladys.on('disconnected', () => hub.stop());

  return { hub, client, store, getConfig, stop: () => hub.stop() };
}
