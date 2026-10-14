# Electrolux API fixtures

Real answers of the Electrolux Group Developer API (`GET /appliances/{id}/info`
as `*_details.json`, `GET /appliances/{id}/state` as `*_state.json`), taken from
the tests of the official SDK
[`electrolux-oss/electrolux-group-developer-sdk`](https://github.com/electrolux-oss/electrolux-group-developer-sdk)
(Apache-2.0, Copyright Electrolux Group).

Changes made here:

- anonymized: appliance ids, serial numbers, PNCs, MAC addresses and the Wi-Fi
  name are replaced by invented values, the time zone of one purifier by
  `Europe/Paris`;
- `appliances.json` (the answer of `GET /appliances`) is written for these
  appliances, with invented names;
- `purea9_details.json` holds the PUREA9 purifier capabilities published by
  [`albaintor/homeassistant_electrolux_status`](https://github.com/albaintor/homeassistant_electrolux_status)
  (MIT); `purea9_state.json` is a plausible state written for it, not a recorded
  answer.
