# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.1] - 2026-10-14

### Added

- Electrolux group appliances (Electrolux, AEG, Zanussi, Frigidaire) in Gladys
  through the official Electrolux Group Developer API, with an API key and a
  refresh token created on the developer portal. The rotating refresh token is
  kept in the integration's `/data` volume.
- One device per appliance, built from the capabilities it declares: washing
  machines, washer-dryers, dryers and dishwashers (state, program, phase, time
  left, expected end, delayed start, door, remote start armed, alerts), ovens
  (temperature, setpoint, food probe, time left, door, light), fridges
  (setpoint, door and fast mode per compartment, humidity, filters), air
  conditioners, air purifiers (air quality), dehumidifiers, robot vacuums.
- Real time through the Electrolux live stream, with a full read every 30
  minutes, and a reading pace fitted to the 5000 calls a day quota while the
  stream is down. No reliance on Gladys polling.
- Safe commands: fridge setpoints and fast mode, air conditioners, purifiers,
  dehumidifiers, oven light; pause, resume and stop of a cycle. Nothing that
  heats is started remotely; a washing machine starts only with the "Allow
  remote start" toggle (off by default) and remote start armed on it.
- Scene triggers "Electrolux cycle finished" and "Electrolux appliance alert";
  scene action "Control an Electrolux cycle" (start, pause, resume, stop).
- Dashboard widget "Electrolux appliances": the cycles under way and their time
  left.
- "Test the connection" button, with the API calls of the last 24 hours.
- English, French, German and Spanish everywhere, including the
  documentation.

[Unreleased]: https://github.com/guim31/gladys-electrolux/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-electrolux/releases/tag/v1.0.1
