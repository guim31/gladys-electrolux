# Electrolux / AEG for Gladys Assistant

Follow — and, where it is safe, control — your connected **Electrolux group**
appliances (Electrolux, AEG, Zanussi, Frigidaire) in
[Gladys Assistant](https://gladysassistant.com), through the official
**Electrolux Group Developer API**: washing machines, washer-dryers, tumble
dryers, dishwashers, ovens, fridges, portable and window air conditioners, air
purifiers, dehumidifiers and Pure i9 robot vacuums.

> **Developed without the hardware: feedback welcome.** Neither an Electrolux
> appliance nor an Electrolux account was available while writing it: the code is
> tested against the real API answers published with Electrolux's official SDK.
> Please report what works and what does not.
>
> Community project, **not affiliated with Electrolux Group**. Electrolux, AEG,
> Zanussi and Frigidaire are trademarks of their owners.

## Features

- **One Gladys device per appliance, built from its capabilities** (what the
  appliance declares to Electrolux), not from a list of models:
  - laundry and dishwashers: state, program, cycle phase, time left, expected
    end, delayed start, door, "remote start armed", alerts;
  - ovens (one or two cavities): state, program, temperature, setpoint, food
    probe, time left, expected end, door, light;
  - fridges: setpoint, door and fast mode of each compartment, humidity,
    filters, alerts;
  - air conditioners (classic and "DAM" portable models): on/off, mode,
    setpoint, fan speed, room temperature;
  - air purifiers: on/off, mode, fan speed, PM2.5, PM10, VOC, CO2, humidity,
    temperature, filter life; dehumidifiers; robot vacuums (state, battery).
- **Real time** through the Electrolux live stream (Server-Sent Events), with a
  full read every 30 minutes as a safety net, and a pace fitted to the **5000
  calls a day** quota while the stream is down.
- **Safe commands only**: fridge setpoints and fast mode, air conditioners,
  purifiers, dehumidifiers, oven light; pause, resume and stop of a cycle.
  **Nothing that heats is started remotely** (ovens, hobs, dryers,
  washer-dryers). Starting a washing machine needs a toggle of the integration
  (off by default) **and** remote start armed on the machine.
- **Scene triggers**: "Electrolux cycle finished" and "Electrolux appliance
  alert". **Scene action**: "Control an Electrolux cycle".
- **Dashboard widget** "Electrolux appliances": the cycles under way, time left,
  expected end.
- English, French, German and Spanish.

## Requirements

- Gladys Assistant **5.1.0** or later. Gladys Plus is **not** needed.
- Appliances paired in the Electrolux or AEG app, and a password on that
  account.
- A free **API key** and a **token pair** created on the
  [Electrolux developer portal](https://developer.electrolux.one/dashboard).
- Internet access: Electrolux has no local API.

## Installation

1. In Gladys: **Integrations → Install from GitHub**, address
   `https://github.com/guim31/gladys-electrolux` (or install it from the store
   once published).
2. On the **Configuration** screen, paste the API key and the **refresh token**,
   save, then click **Test the connection**.
3. In the **Discover** tab, click **Add to Gladys** on the appliances to follow.

The full guide, in four languages, is in [`docs/`](docs/en.md) (also shown by
Gladys from the integration page).

## How it works

- **Authentication**: every call carries the API key (`x-api-key`) and a bearer
  access token (12 hours). The refresh token is single use: each refresh returns
  a new one, kept in the container's `/data` volume (`electrolux-auth.json`, mode 600) and preferred to the configured one until the user pastes another. Never
  in the logs.
- **Refresh**: the live stream (`/api/v1/configurations/livestream`) plus the
  container's own timer; the core's polling is only a fallback (Gladys#3198 makes
  it unreliable). Only changed states are sent to Gladys, with a 6-hour
  heartbeat.
- **Quota**: 5000 calls a day per API key, 10 per second, 5 at once. Calls go one
  at a time; the periodic reads spend at most 2000 calls a day; reads stop at
  80 % of the quota and after a 429 (Retry-After honoured). Capabilities are read
  once per appliance, again only when their hash changes.
- **Logs**: quiet at info level (start, account connected, appliances found,
  stream lost and back, one line per user command). `LOG_LEVEL=debug` shows the
  rest.

## Limitations

- No remote program choice: a cycle is prepared on the appliance; the
  integration pauses, resumes, stops, and starts a washing machine only.
- Program names come from Electrolux, in English.
- Air conditioner modes without a Gladys equivalent (Eco…) are not offered.
- Robot vacuums are read only; hoods and hobs show their state and alerts.
- The quota figures are those the developer portal publishes, as reported by
  other projects (the portal cannot be reached from the development sandbox).
- Cloud only: no update while Electrolux or the Internet connection is down.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

The tests run the whole integration on the SDK's fake Gladys and a fake
Electrolux serving real API answers (`test/fixtures/electrolux/`, anonymized);
they never touch the network. `scripts/probe.mjs` checks the real API, read
only, from a machine with network access (see the comments at its top: without
credentials it expects a clean refusal).

Project rules: [`CLAUDE.md`](CLAUDE.md). Changes: [`CHANGELOG.md`](CHANGELOG.md).
Security: [`SECURITY.md`](SECURITY.md).

## Credits

- [`electrolux-oss/electrolux-group-developer-sdk`](https://github.com/electrolux-oss/electrolux-group-developer-sdk),
  the official Python SDK (Apache-2.0): endpoints, token refresh, live stream,
  appliance types and command shapes; the API answers of its tests are reused,
  anonymized, as fixtures in `test/fixtures/electrolux/`.
- [`albaintor/homeassistant_electrolux_status`](https://github.com/albaintor/homeassistant_electrolux_status)
  (MIT): the capability mapping per appliance type; its PUREA9 purifier
  capabilities are reused in a fixture.
- [`kirbo/electrolux-to-mqtt`](https://gitlab.com/kirbo/electrolux-to-mqtt) by
  Kimmo Saari (MIT): the quota figures and the token lifetime of the developer
  API.
- [`guim31/gladys-miele`](https://github.com/guim31/gladys-miele): the same family
  of appliances, the same safety choices.
- [Gladys Assistant](https://github.com/GladysAssistant/Gladys) and its
  [integration SDK](https://github.com/GladysAssistant/integration-sdk-js).

## Disclaimer

This integration is not affiliated with, endorsed by or supported by Electrolux
Group. Use it at your own risk; your use of the Electrolux API is subject to
Electrolux's terms.

## License

[Apache-2.0](LICENSE).
