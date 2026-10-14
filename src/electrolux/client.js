// -----------------------------------------------------------------------------
// Electrolux Group Developer API client: tokens, REST calls, the quota.
//
// Authentication: every call carries the API key (`x-api-key`) and a bearer
// access token. The access token lives 12 hours; it is refreshed from the
// refresh token (POST /api/v1/token/refresh), which rotates: the new pair goes
// to /data at once (src/electrolux/token-store.js). A refresh token Electrolux
// refuses means the user must create a new one on the portal.
//
// Quota: 5000 calls a day per API key, 10 a second, 5 at once. Calls go one
// at a time, spaced out; every call is counted over a sliding 24 hours, and
// past a ceiling the reads are refused locally (commands keep a margin). A
// 429 stops every read until Electrolux says (Retry-After) or 15 minutes.
//
// `fetch` is injectable: the tests run the whole client against a fake
// Electrolux serving the real answers of the API (test/fixtures/electrolux/).
// -----------------------------------------------------------------------------

import { API_BASE_URL, PATHS, QUOTA } from './constants.js';

/** Budget of one request. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Refresh the access token this long before it expires. */
export const REFRESH_MARGIN_MS = 10 * 60 * 1000;
/** Lifetime of an access token whose expiry cannot be read (12 h documented). */
export const DEFAULT_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** Gap between two calls: 10 a second is the limit, stay well under. */
export const MIN_GAP_MS = 150;
/** Reads stop past this many calls in 24 h; commands may go up to the next. */
export const READ_CEILING = Math.floor(QUOTA.PER_DAY * 0.8);
export const COMMAND_CEILING = QUOTA.PER_DAY - 100;
/** Pause after a 429 without Retry-After, doubled while they go on (2 h at most). */
export const RATE_LIMIT_PAUSE_MS = 15 * 60 * 1000;
export const RATE_LIMIT_MAX_PAUSE_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The user must create new tokens on the portal (missing, or refused). */
export class ReauthorizationRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReauthorizationRequiredError';
  }
}

/** The API answered with an error status. */
export class ElectroluxApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ElectroluxApiError';
    this.status = status;
  }
}

/** The call was not made: the daily quota is (nearly) spent, or Electrolux said 429. */
export class QuotaError extends Error {
  constructor(message, until) {
    super(message);
    this.name = 'QuotaError';
    this.until = until;
  }
}

/** Expiry of a JWT access token (ms), or null when it cannot be read. */
export function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The DAM appliances (id `1:…`, the newer portable air conditioners) take
 * their commands wrapped in a list, like the official SDK sends them.
 * @param {string} applianceId
 * @param {object} body
 */
export function commandBody(applianceId, body) {
  return String(applianceId).startsWith('1:') ? { commands: [body] } : body;
}

/**
 * @param {object} options
 * @param {() => { api_key: string, refresh_token: string }} options.getConfig
 * @param {ReturnType<import('./token-store.js').createTokenStore>} options.store
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now]
 * @param {number} [options.minGapMs]
 */
export function createElectroluxClient({
  getConfig,
  store,
  fetch = globalThis.fetch,
  now = () => Date.now(),
  minGapMs = MIN_GAP_MS,
}) {
  /** Start times of the calls of the last 24 hours. */
  const calls = [];
  let blockedUntil = 0;
  let rateLimitPause = RATE_LIMIT_PAUSE_MS;
  let queue = Promise.resolve();
  let lastStart = 0;
  let refreshing = null;
  /** Tokens in memory: the file may be unwritable, the pair stays usable. */
  let tokens = null;

  function prune() {
    const limit = now() - DAY_MS;
    while (calls.length > 0 && calls[0] <= limit) {
      calls.shift();
    }
  }

  /** Refuse a call the quota cannot afford, before it leaves. */
  function checkBudget(kind) {
    prune();
    if (now() < blockedUntil) {
      throw new QuotaError('Electrolux rate limit: waiting before the next call', blockedUntil);
    }
    const ceiling = kind === 'command' ? COMMAND_CEILING : READ_CEILING;
    if (calls.length >= ceiling) {
      throw new QuotaError(
        `Daily quota nearly spent (${calls.length} calls in 24 h): calls paused`,
        calls[0] + DAY_MS,
      );
    }
  }

  /** One call at a time, spaced out. */
  function enqueue(task) {
    const run = queue.then(async () => {
      const wait = lastStart + minGapMs - now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      lastStart = now();
      calls.push(lastStart);
      return task();
    });
    queue = run.catch(() => {});
    return run;
  }

  function noteRateLimit(response) {
    const retryAfter = Number(response.headers?.get?.('retry-after'));
    const pause =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : rateLimitPause;
    blockedUntil = now() + pause;
    rateLimitPause = Math.min(rateLimitPause * 2, RATE_LIMIT_MAX_PAUSE_MS);
  }

  async function loadTokens() {
    const config = getConfig();
    if (!config.api_key || !config.refresh_token) {
      throw new ReauthorizationRequiredError('No API key or refresh token in the configuration');
    }
    if (!tokens || tokens.configured !== config.refresh_token) {
      tokens = { configured: config.refresh_token, ...(await store.current(config.refresh_token)) };
    }
    return tokens;
  }

  async function refresh() {
    const config = getConfig();
    const current = await loadTokens();
    checkBudget('command');
    const response = await enqueue(() =>
      fetch(`${API_BASE_URL}${PATHS.TOKEN_REFRESH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-key': config.api_key,
        },
        body: JSON.stringify({ refreshToken: current.refresh_token }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    );
    const payload = await readJson(response);
    if (response.status === 429) {
      noteRateLimit(response);
      throw new QuotaError('Electrolux rate limit on the token refresh', blockedUntil);
    }
    if (!response.ok) {
      // Never the body as such: it could echo a token. The status is enough.
      const message = `Electrolux refused the refresh token (HTTP ${response.status})`;
      if ([400, 401, 403, 404].includes(response.status)) {
        throw new ReauthorizationRequiredError(message);
      }
      throw new ElectroluxApiError(response.status, message);
    }
    if (typeof payload?.accessToken !== 'string' || payload.accessToken === '') {
      throw new ElectroluxApiError(response.status, 'Electrolux sent no access token');
    }
    const expiresIn = Number(payload.expiresIn);
    const fresh = {
      access_token: payload.accessToken,
      // A refresh that returns no new refresh token keeps the old one valid.
      refresh_token:
        typeof payload.refreshToken === 'string' && payload.refreshToken !== ''
          ? payload.refreshToken
          : current.refresh_token,
      expires_at:
        jwtExpiry(payload.accessToken) ??
        now() +
          (Number.isFinite(expiresIn) && expiresIn > 0
            ? expiresIn * 1000
            : DEFAULT_TOKEN_LIFETIME_MS),
    };
    tokens = { configured: current.configured, ...fresh };
    await store.save(current.configured, fresh);
    return fresh;
  }

  /** One refresh at a time: a second one would spend a token already rotated. */
  function refreshOnce() {
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function getAccessToken({ force = false } = {}) {
    const current = await loadTokens();
    if (force || !current.access_token || current.expires_at - now() < REFRESH_MARGIN_MS) {
      return (await refreshOnce()).access_token;
    }
    return current.access_token;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: object, kind?: 'read'|'command' }} [options]
   */
  async function request(method, path, { body, kind = 'read' } = {}) {
    const send = async (token) => {
      checkBudget(kind);
      return enqueue(() =>
        fetch(`${API_BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'x-api-key': getConfig().api_key,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
      );
    };
    let response = await send(await getAccessToken());
    if (response.status === 401 || response.status === 403) {
      // Expired or revoked early (Electrolux answers 403 too): one refresh, one retry.
      response = await send(await getAccessToken({ force: true }));
    }
    if (response.status === 429) {
      noteRateLimit(response);
      throw new QuotaError(`Electrolux rate limit (HTTP 429) on ${method} ${path}`, blockedUntil);
    }
    rateLimitPause = RATE_LIMIT_PAUSE_MS;
    if (!response.ok) {
      const payload = await readJson(response);
      const text = [payload?.message, payload?.detail, payload?.error].find(
        (part) => typeof part === 'string' && part !== '',
      );
      throw new ElectroluxApiError(
        response.status,
        `Electrolux API ${method} ${path.replace(/appliances\/[^/]+/, 'appliances/…')}: HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`,
      );
    }
    if (response.status === 204) {
      return null;
    }
    return readJson(response);
  }

  return {
    /** Calls made over the last 24 hours. */
    callsToday() {
      prune();
      return calls.length;
    },

    /** Until when the reads wait after a 429 (ms since epoch, 0 when not). */
    get blockedUntil() {
      return blockedUntil;
    },

    /** Forget the tokens in memory (a new refresh token was configured). */
    reset() {
      tokens = null;
    },

    getAccessToken,

    /** Every appliance of the account: `[{ applianceId, applianceName, applianceType }]`. */
    getAppliances() {
      return request('GET', PATHS.APPLIANCES);
    },

    /** Identity and capabilities of an appliance. */
    getInfo(applianceId) {
      return request('GET', PATHS.INFO(applianceId));
    },

    /** Current state of an appliance. */
    getState(applianceId) {
      return request('GET', PATHS.STATE(applianceId));
    },

    /** Send a command (PUT /appliances/{id}/command). */
    sendCommand(applianceId, body) {
      return request('PUT', PATHS.COMMAND(applianceId), {
        body: commandBody(applianceId, body),
        kind: 'command',
      });
    },

    /** Where the live stream of state changes is served. */
    getLivestreamConfig() {
      return request('GET', PATHS.LIVESTREAM);
    },

    /**
     * Open the live stream (Server-Sent Events). The caller reads the body.
     * @param {string} url from the livestream configuration
     * @param {AbortSignal} signal
     */
    async openStream(url, signal) {
      const target = new URL(url);
      if (target.protocol !== 'https:') {
        throw new ElectroluxApiError(0, 'Electrolux live stream: not an https URL');
      }
      checkBudget('read');
      const token = await getAccessToken();
      calls.push(now());
      const response = await fetch(target, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-api-key': getConfig().api_key,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        signal,
      });
      if (response.status === 401 || response.status === 403) {
        // The next attempt starts from a fresh token.
        await getAccessToken({ force: true }).catch(() => {});
      }
      if (response.status === 429) {
        noteRateLimit(response);
      }
      if (!response.ok || !response.body) {
        throw new ElectroluxApiError(
          response.status,
          `Electrolux live stream: HTTP ${response.status}`,
        );
      }
      return response;
    },
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
