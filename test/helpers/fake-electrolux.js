// -----------------------------------------------------------------------------
// A fake Electrolux Group Developer API behind a `fetch` function: the token
// refresh (single-use refresh tokens, like the real one), the REST API
// (GET /appliances, /info, /state, PUT /command), the livestream configuration
// and the Server-Sent Events stream, serving the real answers of the API
// recorded by the official SDK's tests (test/fixtures/electrolux/,
// Apache-2.0, anonymized). No network, ever.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const API_KEY = 'api-key-0123456789';
export const FIRST_REFRESH = 'refresh-0';
const STREAM_URL = 'https://streaming.fake-electrolux.test/livestream';

export function fixture(name) {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/electrolux/${name}.json`, import.meta.url), 'utf8'),
  );
}

/** Fixture prefix of each appliance of the listing, in order. */
export const FIXTURE_NAMES = [
  'wm',
  'wd',
  'td',
  'dw',
  'ov',
  'so',
  'hb',
  'hd',
  'cr',
  'ac',
  'dam_ac',
  'ap',
  'dh',
  'rvc',
  'purea9',
];

/** The id of a fixture appliance ("wm" → its applianceId). */
export function idOf(name) {
  return fixture(`${name}_state`).applianceId;
}

/** A JWT the client can read the expiry of (unsigned: the fake does not check). */
export function makeJwt(expSeconds, id = 'x') {
  const part = (object) => Buffer.from(JSON.stringify(object)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part({ exp: expSeconds, sub: id })}.sig`;
}

const json = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/**
 * @param {object} [options]
 * @param {string[]} [options.names] fixture appliances of the account
 */
export function createFakeElectrolux({ names = FIXTURE_NAMES } = {}) {
  const list = fixture('appliances');
  const fake = {
    appliances: names.map((name) => list.find((entry) => entry.applianceId === idOf(name))),
    infos: Object.fromEntries(names.map((name) => [idOf(name), fixture(`${name}_details`)])),
    states: Object.fromEntries(names.map((name) => [idOf(name), fixture(`${name}_state`)])),
    requests: [],
    commands: [],
    /** The refresh token the API accepts now (single use). */
    validRefresh: FIRST_REFRESH,
    refreshCount: 0,
    validAccess: null,
    /** Lifetime of the access tokens issued (seconds). */
    accessLifetime: 12 * 3600,
    /** Status forced on the REST calls (0 = network error, 429 = rate limit). */
    restStatus: 200,
    /** Status of PUT /command. */
    commandStatus: 200,
    /** Status of the stream request. */
    streamStatus: 200,
    streams: [],

    /** Send one property change to every open stream. */
    push(applianceId, property, value) {
      const frame = `data: ${JSON.stringify({ applianceId, property, value })}\n\n`;
      for (const stream of fake.streams) {
        stream.enqueue(frame);
      }
    },

    closeStreams() {
      for (const stream of fake.streams.splice(0)) {
        stream.close();
      }
    },

    /** Requests to a path (`/api/v1/appliances`, `…/state`…). */
    count(predicate) {
      return fake.requests.filter((request) =>
        typeof predicate === 'string' ? request.path === predicate : predicate(request),
      ).length;
    },

    async fetch(input, init = {}) {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const headers = init.headers ?? {};
      const entry = { method, path: url.pathname, host: url.host };
      if (typeof init.body === 'string') {
        entry.body = JSON.parse(init.body);
      }
      fake.requests.push(entry);

      if (headers['x-api-key'] !== API_KEY) {
        return json(403, { message: 'Invalid API key' });
      }
      if (url.pathname === '/api/v1/token/refresh' && method === 'POST') {
        if (entry.body?.refreshToken !== fake.validRefresh) {
          return json(401, { error: 'invalid_grant', message: 'Refresh token invalid' });
        }
        fake.refreshCount += 1;
        fake.validRefresh = `refresh-${fake.refreshCount}`;
        fake.validAccess = makeJwt(
          Math.floor(Date.now() / 1000) + fake.accessLifetime,
          `access-${fake.refreshCount}`,
        );
        return json(200, {
          accessToken: fake.validAccess,
          refreshToken: fake.validRefresh,
          expiresIn: fake.accessLifetime,
          tokenType: 'Bearer',
        });
      }
      if (headers.Authorization !== `Bearer ${fake.validAccess}`) {
        return json(401, { message: 'Unauthorized' });
      }
      if (url.host === new URL(STREAM_URL).host) {
        return fake.openStream(init);
      }
      if (fake.restStatus === 0) {
        throw new TypeError('fetch failed');
      }
      if (fake.restStatus === 429) {
        return json(429, { message: 'Too many requests' }, { 'Retry-After': '600' });
      }
      if (fake.restStatus !== 200) {
        return json(fake.restStatus, { message: 'Service unavailable' });
      }
      if (url.pathname === '/api/v1/appliances') {
        return json(200, fake.appliances);
      }
      if (url.pathname === '/api/v1/configurations/livestream') {
        return json(200, {
          url: STREAM_URL,
          appliances: fake.appliances.map((a) => ({ applianceId: a.applianceId, properties: [] })),
        });
      }
      const match = /^\/api\/v1\/appliances\/([^/]+)\/(info|state|command)$/.exec(url.pathname);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (!(id in fake.states)) {
          return json(404, { message: 'Appliance not found' });
        }
        if (match[2] === 'info') {
          return json(200, fake.infos[id]);
        }
        if (match[2] === 'state') {
          return json(200, fake.states[id]);
        }
        if (method === 'PUT') {
          fake.commands.push({ id, body: entry.body });
          return fake.commandStatus === 200
            ? json(200, {})
            : json(fake.commandStatus, { message: 'Command not accepted' });
        }
      }
      return json(404, { message: 'Not found' });
    },

    openStream(init) {
      if (fake.streamStatus !== 200) {
        return json(fake.streamStatus, { message: 'Refused' });
      }
      const encoder = new TextEncoder();
      let controller;
      const body = new ReadableStream({
        start(c) {
          controller = c;
        },
      });
      const stream = {
        enqueue: (text) => controller.enqueue(encoder.encode(text)),
        close: () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        },
      };
      init.signal?.addEventListener('abort', () => {
        try {
          controller.error(new Error('aborted'));
        } catch {
          // already closed
        }
      });
      fake.streams.push(stream);
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    },
  };
  fake.fetch = fake.fetch.bind(fake);
  return fake;
}
