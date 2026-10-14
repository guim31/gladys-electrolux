// -----------------------------------------------------------------------------
// The Electrolux live stream (Server-Sent Events).
//
// GET /api/v1/configurations/livestream gives the URL of one long-lived
// request that carries the changes of every appliance of the account, one
// property at a time:
//
//   data: {"applianceId": "…", "property": "timeToEnd", "value": 120}
//   data: {"applianceId": "…", "property": "fridge/doorState", "value": "OPEN"}
//   data: {"applianceId": "…", "property": "connectivityState", "value": "disconnected"}
//
// The stream is preferred to reading the states: a cycle that ends is known
// within seconds, at the cost of one call per connection instead of one per
// appliance per read. It is reopened with a backoff that starts at 30 s (each
// connection is a call of the daily quota), and a watchdog drops a connection
// silent for 15 minutes (a dead socket that looks alive). The periodic read of
// src/hub.js covers what a reconnection may have missed.
//
// Written on `fetch` and its ReadableStream body: Node has no EventSource,
// and the stream needs the Authorization and x-api-key headers anyway.
// -----------------------------------------------------------------------------

/** No byte for this long: the connection is dead. */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const RECONNECT_BASE_DELAY_MS = 30_000;
export const RECONNECT_MAX_DELAY_MS = 15 * 60 * 1000;
/** A connection that lived this long resets the backoff. */
export const STABLE_AFTER_MS = 5 * 60 * 1000;

/**
 * One raw frame (lines up to the blank line) to its JSON data, or null
 * (comment, keep-alive, unreadable).
 * @param {string} frame
 */
export function parseFrame(frame) {
  const dataLines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  try {
    return JSON.parse(dataLines.join('\n'));
  } catch {
    return null;
  }
}

function findSeparator(buffer) {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

/**
 * Keep the stream open for life.
 *
 * @param {object} options
 * @param {(signal: AbortSignal) => Promise<Response>} options.open opens one connection
 * @param {(data: object) => void} options.onEvent
 * @param {(state: 'connected'|'closed'|'failed', error?: Error) => void} [options.onStatus]
 * @param {(error: Error) => number|null} [options.retryDelay] a delay for this
 *   error (ms), or null for the usual backoff
 * @param {object} [options.timing] overrides for the tests
 * @param {() => number} [options.now]
 * @returns {{ stop: () => void, done: Promise<void> }}
 */
export function startLiveStream({
  open,
  onEvent,
  onStatus = () => {},
  retryDelay = () => null,
  timing = {},
  now = () => Date.now(),
}) {
  const idleTimeoutMs = timing.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const baseDelayMs = timing.baseDelayMs ?? RECONNECT_BASE_DELAY_MS;
  const maxDelayMs = timing.maxDelayMs ?? RECONNECT_MAX_DELAY_MS;
  const stableAfterMs = timing.stableAfterMs ?? STABLE_AFTER_MS;

  let stopped = false;
  let controller = null;
  let retryTimer = null;
  let wakeUp = null;
  let reader = null;
  let failures = 0;

  const sleep = (ms) =>
    new Promise((resolve) => {
      wakeUp = resolve;
      retryTimer = setTimeout(resolve, ms);
      retryTimer.unref?.();
    });

  async function consume(response) {
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let watchdog = null;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => reader?.cancel().catch(() => {}), idleTimeoutMs);
      watchdog.unref?.();
    };
    try {
      arm();
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) {
          break;
        }
        arm();
        buffer += decoder.decode(value, { stream: true });
        let separator = findSeparator(buffer);
        while (separator) {
          const data = parseFrame(buffer.slice(0, separator.index));
          buffer = buffer.slice(separator.index + separator.length);
          if (data && typeof data === 'object') {
            onEvent(data);
          }
          separator = findSeparator(buffer);
        }
      }
    } finally {
      clearTimeout(watchdog);
      reader?.cancel().catch(() => {});
      reader = null;
    }
  }

  async function run() {
    while (!stopped) {
      controller = new AbortController();
      let delay;
      try {
        const response = await open(controller.signal);
        if (stopped) {
          break;
        }
        const openedAt = now();
        onStatus('connected');
        await consume(response);
        if (stopped) {
          break;
        }
        // Closed by Electrolux or by the watchdog: reopen, sooner when it lived long.
        failures = now() - openedAt >= stableAfterMs ? 0 : failures + 1;
        onStatus('closed');
        delay = Math.min(baseDelayMs * 2 ** Math.max(0, failures - 1), maxDelayMs);
      } catch (err) {
        if (stopped) {
          break;
        }
        failures += 1;
        onStatus('failed', err);
        delay = retryDelay(err) ?? Math.min(baseDelayMs * 2 ** (failures - 1), maxDelayMs);
      }
      await sleep(delay);
    }
  }

  const done = run();

  return {
    done,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      wakeUp?.();
      controller?.abort();
      reader?.cancel().catch(() => {});
    },
  };
}
