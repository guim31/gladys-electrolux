// -----------------------------------------------------------------------------
// The "Electrolux appliances" widget: the running cycles first, with their
// time left, in the language of the request, within the core's budget.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from '../src/hub.js';
import { formatMinutes } from '../src/widgets.js';
import { idOf } from './helpers/fake-electrolux.js';
import { createWorld } from './helpers/world.js';

async function content(world, language = 'fr') {
  const ack = await world.gladys.fake.widgetGet(WIDGET_KEY, { settings: {}, language });
  assert.equal(ack.success, true);
  assert.deepEqual(validateWidgetContent(ack.data.content), []);
  return ack.data.content;
}

test('the cycles under way are listed, the running one first, with its time left', async () => {
  const world = await createWorld();
  try {
    const r = world.electrolux.states[idOf('wm')].properties.reported;
    r.applianceState = 'RUNNING';
    r.cyclePhase = 'RINSE';
    r.timeToEnd = 4500;
    r.stopTime = -1;
    await world.app.hub.refresh();
    const widget = await content(world);
    assert.deepEqual(widget.components[0], {
      type: 'text',
      variant: 'heading',
      text: '2 en marche',
    });
    const [first, ...others] = widget.components[1].items;
    assert.equal(first.title, 'Lave-linge');
    assert.deepEqual(first.badge, { text: '1 h 15', color: 'primary' });
    assert.match(first.subtitle, /^Synthetics · Rinçage · fin à \d\d:\d\d$/);
    // The double oven runs too; the washer-dryer waits for its delayed start.
    const titles = others.map((item) => item.title);
    assert.ok(titles.includes('Double four') && titles.includes('Lavante-séchante'));
    const delayed = others.find((item) => item.title === 'Lavante-séchante');
    assert.match(delayed.subtitle, /départ dans 1 h 00/);
    // Never the fridge, the robot or the air conditioner: not cycles.
    assert.ok(!titles.includes('Réfrigérateur') && !titles.includes('Robot'));
  } finally {
    await world.close();
  }
});

test('the widget speaks the language of the request', async () => {
  const world = await createWorld();
  try {
    const widget = await content(world, 'es');
    const items = widget.components.at(-1).items;
    assert.ok(items.some((item) => /empieza en/.test(item.subtitle)));
  } finally {
    await world.close();
  }
});

test('nothing added, nothing running: one line says so', async () => {
  const world = await createWorld({ addAll: false });
  try {
    assert.match((await content(world)).components[0].text, /onglet Découverte/);
    await world.gladys.fake.deviceCreated(world.device('cr'));
    assert.equal(
      (await content(world, 'en')).components[0].text,
      'No appliance running right now.',
    );
  } finally {
    await world.close();
  }
});

test('durations read naturally', () => {
  assert.equal(formatMinutes(42), '42 min');
  assert.equal(formatMinutes(65), '1 h 05');
  assert.equal(formatMinutes(-3), '0 min');
});
