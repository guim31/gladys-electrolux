// -----------------------------------------------------------------------------
// The live stream on its own: frames split anywhere, keep-alive comments,
// reconnection with a backoff, the watchdog of a silent connection.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame, startLiveStream } from '../src/electrolux/livestream.js';
import { waitFor } from './helpers/world.js';

function sseResponse() {
  const encoder = new TextEncoder();
  let controller;
  const body = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    send: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

test('a frame carries one property change; comments and junk are skipped', () => {
  assert.deepEqual(parseFrame('data: {"applianceId":"a","property":"timeToEnd","value":120}'), {
    applianceId: 'a',
    property: 'timeToEnd',
    value: 120,
  });
  assert.equal(parseFrame(': keep-alive'), null);
  assert.equal(parseFrame('data: not json'), null);
  assert.deepEqual(parseFrame('event: update\r\ndata: {"a":\r\ndata: 1}'), { a: 1 });
});

test('events split across chunks are put back together', async () => {
  const opened = [];
  const events = [];
  const stream = startLiveStream({
    open: async () => {
      const connection = sseResponse();
      opened.push(connection);
      return connection.response;
    },
    onEvent: (data) => events.push(data),
    timing: { baseDelayMs: 5 },
  });
  try {
    await waitFor(() => opened.length === 1);
    opened[0].send('data: {"applianceId":"a","prop');
    opened[0].send('erty":"doorState","value":"OPEN"}\n');
    opened[0].send('\n: ping\n\ndata: {"applianceId":"b","property":"x","value":1}\n\n');
    await waitFor(() => events.length === 2);
    assert.deepEqual(
      events.map((e) => e.applianceId),
      ['a', 'b'],
    );
  } finally {
    stream.stop();
  }
});

test('a closed or failed connection is reopened, a silent one dropped', async () => {
  const opened = [];
  const statuses = [];
  let fail = true;
  const stream = startLiveStream({
    open: async () => {
      if (fail) {
        fail = false;
        throw new Error('network');
      }
      const connection = sseResponse();
      opened.push(connection);
      return connection.response;
    },
    onEvent: () => {},
    onStatus: (state) => statuses.push(state),
    timing: { baseDelayMs: 5, idleTimeoutMs: 40 },
  });
  try {
    await waitFor(() => opened.length === 1, { label: 'reopened after a failure' });
    opened[0].close();
    await waitFor(() => opened.length === 2, { label: 'reopened after a close' });
    // No byte for 40 ms: the watchdog drops it, a third connection opens.
    await waitFor(() => opened.length === 3, { label: 'watchdog' });
    assert.deepEqual(statuses.slice(0, 4), ['failed', 'connected', 'closed', 'connected']);
  } finally {
    stream.stop();
  }
});

test('a refused stream waits the delay asked for', async () => {
  let attempts = 0;
  const stream = startLiveStream({
    open: async () => {
      attempts += 1;
      throw new Error('forbidden');
    },
    onEvent: () => {},
    retryDelay: () => 60_000,
    timing: { baseDelayMs: 1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  stream.stop();
  await stream.done;
  assert.equal(attempts, 1);
});
