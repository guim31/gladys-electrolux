#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Probe the real Electrolux Group Developer API with the integration's own
// client, read only, from a machine that has the network. Prints what the
// integration would make of the account, never a key, a token or a full
// appliance id.
//
// 1. Without credentials: an authenticated call with a fake key and a fake
//    refresh token. Expected: a clean refusal (HTTP 401/403), no crash.
//      node scripts/probe.mjs
// 2. With real credentials (read only: no command is ever sent):
//      ELECTROLUX_API_KEY=… ELECTROLUX_REFRESH_TOKEN=… node scripts/probe.mjs
//    lists the appliances, builds their Gladys devices and listens to the
//    live stream for 60 s.
//
// WARNING: the refresh token is single use. The probe spends the one given
// and keeps the new pair in ./probe-data/electrolux-auth.json (mode 600).
// Use a token pair made for the probe, not the one pasted in Gladys — or
// paste a new one in Gladys afterwards. DATA_DIR overrides ./probe-data.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { buildDevice, parseAppliance, stateValues } from '../src/appliances.js';
import { createElectroluxClient } from '../src/electrolux/client.js';
import { startLiveStream } from '../src/electrolux/livestream.js';
import { createTokenStore } from '../src/electrolux/token-store.js';

const real = Boolean(process.env.ELECTROLUX_API_KEY && process.env.ELECTROLUX_REFRESH_TOKEN);
const config = {
  api_key: process.env.ELECTROLUX_API_KEY ?? 'probe-fake-api-key',
  refresh_token: process.env.ELECTROLUX_REFRESH_TOKEN ?? 'probe-fake-refresh-token',
  language: process.env.ELECTROLUX_LANGUAGE ?? 'fr',
};
const store = createTokenStore({ dir: process.env.DATA_DIR ?? './probe-data' });
const client = createElectroluxClient({ getConfig: () => config, store });
const mask = (id) => `${String(id).slice(0, 4)}…${String(id).slice(-3)}`;

if (!real) {
  console.log('No credentials: one authenticated call with a fake key and a fake token.');
  try {
    await client.getAppliances();
    console.log('UNEXPECTED: the fake credentials were accepted.');
    process.exit(1);
  } catch (err) {
    if (err instanceof TypeError) {
      // Not an answer of Electrolux: the network (DNS, proxy, firewall).
      console.log(`Electrolux not reached from this machine: ${err.message}`);
      process.exit(2);
    }
    console.log(`Refused as expected: ${err.name}: ${err.message}`);
    process.exit(0);
  }
}

const gladys = createFakeGladys();
const entries = await client.getAppliances();
console.log(`GET /appliances: ${entries.length} appliance(s)`);
for (const entry of entries) {
  const [info, state] = await Promise.all([
    client.getInfo(entry.applianceId).catch((err) => {
      console.log(`  info of ${mask(entry.applianceId)}: ${err.message}`);
      return null;
    }),
    client.getState(entry.applianceId).catch((err) => {
      console.log(`  state of ${mask(entry.applianceId)}: ${err.message}`);
      return null;
    }),
  ]);
  const appliance = parseAppliance(entry, info, state);
  const device = buildDevice(gladys, appliance, config.language);
  console.log(
    `\n${mask(appliance.id)} type ${appliance.type} (${appliance.family}, ${appliance.brand} ${appliance.model}) → "${device.name}"`,
  );
  console.log(`  capabilities: ${Object.keys(appliance.capabilities).length}`);
  console.log(
    `  features: ${device.features.map((f) => `${f.external_id.split(':').pop()}${f.read_only ? '' : '*'}`).join(', ')}`,
  );
  console.log(
    `  states: ${JSON.stringify(stateValues(appliance, { language: config.language, now: Date.now() }))}`,
  );
  console.log(`  reported keys: ${Object.keys(appliance.reported).sort().join(', ')}`);
}

console.log('\nLive stream, 60 s:');
let streamUrl = null;
const counts = {};
const stream = startLiveStream({
  open: async (signal) => {
    streamUrl ??= (await client.getLivestreamConfig()).url;
    return client.openStream(streamUrl, signal);
  },
  onEvent: (data) => {
    counts[data.property] = (counts[data.property] ?? 0) + 1;
    console.log(`  ${new Date().toISOString()} ${mask(data.applianceId)} ${data.property}`);
  },
  onStatus: (state, err) => console.log(`  stream ${state}${err ? ` (${err.message})` : ''}`),
});
await new Promise((resolve) => setTimeout(resolve, 60_000));
stream.stop();
console.log(`Properties received: ${JSON.stringify(counts)}`);
console.log(`API calls made: ${client.callsToday()}. New tokens kept in ${store.file}.`);
process.exit(0);
