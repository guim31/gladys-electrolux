// -----------------------------------------------------------------------------
// The whole integration on the SDK's fake Gladys and a fake Electrolux: what a
// user sees after installing it, pasting the API key and the refresh token,
// and adding the appliances.
// -----------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createApp } from '../../src/app.js';
import { API_KEY, FIRST_REFRESH, createFakeElectrolux, idOf } from './fake-electrolux.js';

export const CONFIG = { api_key: API_KEY, refresh_token: FIRST_REFRESH, language: 'fr' };

/** A logger that keeps every line, by level. */
export function createCaptureLogger() {
  const lines = [];
  const write =
    (level) =>
    (...args) => {
      lines.push({
        level,
        text: args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
      });
    };
  const logger = {
    lines,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    at: (level) => lines.filter((line) => line.level === level).map((line) => line.text),
    clear: () => lines.splice(0),
  };
  logger.child = () => logger;
  return logger;
}

/** Wait until `check()` is truthy (polled), or fail. */
export async function waitFor(check, { timeout = 3000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {boolean} [options.addAll] the user adds every discovered device
 * @param {object} [options.electrolux] options of the fake Electrolux
 * @param {object} [options.app] extra options of createApp
 * @param {string} [options.dataDir] reuse a /data directory (a restart)
 */
export async function createWorld({
  config = CONFIG,
  addAll = true,
  electrolux: electroluxOptions,
  electroluxFake,
  app: appOptions = {},
  dataDir: givenDataDir,
} = {}) {
  const dataDir = givenDataDir ?? (await mkdtemp(join(tmpdir(), 'gladys-electrolux-')));
  const electrolux = electroluxFake ?? createFakeElectrolux(electroluxOptions);
  const gladys = createFakeGladys({ config });
  const logger = createCaptureLogger();
  const app = createApp({
    gladys,
    fetch: electrolux.fetch,
    dataDir,
    timers: false,
    stream: false,
    minGapMs: 0,
    logger,
    ...appOptions,
    hubOptions: { coalesceMs: 5, commandRereadMs: 10, ...(appOptions.hubOptions ?? {}) },
  });
  await gladys.connect();
  if (addAll) {
    for (const device of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(device);
    }
  }
  return {
    gladys,
    app,
    electrolux,
    logger,
    dataDir,
    /** The discovered device of a fixture appliance ("wm", "cr"…). */
    device: (name) =>
      gladys.fake.discoveredDevices.find((d) => d.external_id.endsWith(`:appliance:${idOf(name)}`)),
    /** The external id of a feature of a fixture appliance. */
    feature(name, key) {
      return `${this.device(name).external_id}:${key}`;
    },
    async close({ keepData = false } = {}) {
      app.stop();
      await gladys.disconnect().catch(() => {});
      if (!keepData) {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
}
