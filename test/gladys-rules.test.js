// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from the real
// answers of the Electrolux API (test/fixtures/electrolux/: washing machine,
// washer-dryer, dryer, dishwasher, oven, double oven, hob, hood, fridge, two
// air conditioners, two purifiers, dehumidifier, robot vacuum), in every
// feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FIXTURE_NAMES } from './helpers/fake-electrolux.js';
import { CONFIG, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

for (const language of ['fr', 'en', 'de', 'es']) {
  test(`every discovered device follows the Gladys rules (${language})`, async () => {
    const world = await createWorld({ config: { ...CONFIG, language }, addAll: false });
    try {
      const devices = world.gladys.fake.discoveredDevices;
      assert.equal(devices.length, FIXTURE_NAMES.length, 'one device per fixture appliance');
      const deviceIds = new Set();

      for (const device of devices) {
        const where = device.name;
        assert.ok(!deviceIds.has(device.external_id), `${where}: duplicate device external_id`);
        deviceIds.add(device.external_id);

        // should_poll: true if and only if poll_frequency is provided, in ms.
        if (device.poll_frequency === undefined) {
          assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
        } else {
          assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
          assert.ok(
            table.poll_frequencies_ms.includes(device.poll_frequency),
            `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
          );
        }

        assert.ok(device.features.length > 0, `${where}: no feature`);
        const externalIds = new Set();
        const names = new Set();
        for (const feature of device.features) {
          const at = `${where} / ${feature.name}`;
          const pair = table.pairs[`${feature.category}/${feature.type}`];
          assert.ok(
            pair,
            `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`,
          );
          assert.ok(
            pair.label_en && pair.label_fr && pair.icon,
            `${at}: couple without label or icon`,
          );

          assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
          assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
          assert.ok(
            Number.isFinite(feature.min) && Number.isFinite(feature.max),
            `${at}: finite min/max`,
          );
          assert.ok(feature.min <= feature.max, `${at}: min > max`);
          assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
          assert.equal(
            typeof feature.has_feedback,
            'boolean',
            `${at}: has_feedback must be a boolean`,
          );
          if (feature.unit !== undefined) {
            assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
            // The core constant nests some lists (PM2.5, PM10): the table keeps it as is.
            const allowed = table.units_by_category[feature.category]?.flat();
            if (allowed) {
              assert.ok(
                allowed.includes(feature.unit),
                `${at}: unit ${feature.unit} not for ${feature.category}`,
              );
            }
          }
          if (feature.supported_options !== undefined) {
            const values = feature.supported_options.map((option) => String(option.value));
            assert.equal(new Set(values).size, values.length, `${at}: duplicate option values`);
            for (const option of feature.supported_options) {
              assert.ok(
                typeof option.label === 'string' && option.label.trim() !== '',
                `${at}: option without label`,
              );
              if (feature.type !== 'select') {
                assert.ok(Number.isInteger(option.value), `${at}: option values are integers`);
                assert.ok(
                  option.value >= feature.min && option.value <= feature.max,
                  `${at}: option ${option.value} outside min/max`,
                );
              }
            }
          }

          assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
          externalIds.add(feature.external_id);
          assert.ok(
            feature.external_id.startsWith(`${device.external_id}:`),
            `${at}: feature of another device`,
          );
          assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
          names.add(feature.name);
        }
      }
    } finally {
      await world.close();
    }
  });
}

test('the states published for every device are accepted by the core rules', async () => {
  // The fake Gladys of the SDK refuses (400) a state the core would refuse:
  // a text state must be a non-empty string, a number must be finite.
  const world = await createWorld();
  try {
    const refused = world.gladys.fake.requests.filter((request) => request.status !== 200);
    assert.deepEqual(refused, []);
    assert.ok(world.gladys.fake.states.length > 50);
    for (const state of world.gladys.fake.states) {
      if ('text' in state) {
        assert.ok(
          typeof state.text === 'string' && state.text.trim() !== '',
          JSON.stringify(state),
        );
      } else {
        assert.ok(Number.isFinite(state.state), JSON.stringify(state));
      }
    }
  } finally {
    await world.close();
  }
});
