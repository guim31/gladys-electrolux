// -----------------------------------------------------------------------------
// Every text Gladys shows exists in the four languages of its interface
// (English, French, German, Spanish): the manifest, the text tables of the
// code, and the four documentation files, which share the same sections.
// German says "du", never the polite "Sie"; Spanish says "usted".
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/config.js';
import {
  ALERT_TEXT,
  COMMAND_TEXT,
  CONNECTION_TEXT,
  FILTER_TEXT,
  NAMES,
  OPTION_TEXT,
  PHASE_TEXT,
  STATUS_TEXT,
  TEST_TEXT,
  TYPE_NAMES,
  WIDGET_TEXT,
  ZONE_NAMES,
} from '../src/i18n.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const LANGS = ['en', 'fr', 'de', 'es'];
const POLITE_GERMAN = /(?<!\p{L})(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?!\p{L})/u;
// Informal Spanish ("tú") forms that would break the "usted" choice.
const INFORMAL_SPANISH =
  /(?<!\p{L})(tu|tus|tú|puedes|debes|tienes|abre|introduce|haz clic)(?!\p{L})/iu;

// Upper bounds, in characters: what the Gladys interface shows without cutting.
const MAX = {
  catalog: 100,
  widgetLabel: 30,
  label: 60,
  placeholder: 60,
  description: 1000,
  message: 200,
  short: 40,
  featureName: 40,
};

const sorted = (keys) => [...keys].sort();

/** Checks one multi-language object; returns its problems. */
function problems(value, path, max) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} must be a multi-language object`];
  }
  const found = [];
  if (JSON.stringify(sorted(Object.keys(value))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${path} has [${Object.keys(value)}], expected exactly [${LANGS}]`);
  }
  for (const [lang, text] of Object.entries(value)) {
    found.push(...textProblems(text, `${path}.${lang}`, lang, max));
  }
  return found;
}

function textProblems(text, path, lang, max) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [`${path} is empty`];
  }
  const found = [];
  if (text.length > max) {
    found.push(`${path} has ${text.length} characters (${max} at most)`);
  }
  if (lang === 'de' && POLITE_GERMAN.test(text)) {
    found.push(`${path} uses the polite form: "${text}"`);
  }
  if (lang === 'es' && INFORMAL_SPANISH.test(text)) {
    found.push(`${path} uses the informal form: "${text}"`);
  }
  return found;
}

/** Every multi-language object of the manifest, with its length limit. */
function manifestTexts(root) {
  const texts = [];
  const walk = (value, path, key) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, key));
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const isText =
      ['label', 'description', 'placeholder'].includes(key) ||
      Object.keys(value).some((child) => LANGS.includes(child));
    if (isText) {
      const max =
        path === 'manifest.description' || /^manifest\.widgets\[\d+\]\.description$/.test(path)
          ? MAX.catalog
          : /^manifest\.widgets\[\d+\]\.label$/.test(path)
            ? MAX.widgetLabel
            : (MAX[key] ?? MAX.label);
      texts.push({ path, value, max });
      return;
    }
    for (const [child, item] of Object.entries(value)) {
      walk(item, `${path}.${child}`, child);
    }
  };
  walk(root, 'manifest', null);
  return texts;
}

// Tables written one language at a time: same keys everywhere, no empty text.
function tableProblems(table, name, max) {
  const found = [];
  if (JSON.stringify(sorted(Object.keys(table))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${name} has [${Object.keys(table)}], expected exactly [${LANGS}]`);
  }
  for (const lang of LANGS) {
    const entries = table[lang] ?? {};
    if (
      JSON.stringify(sorted(Object.keys(entries))) !== JSON.stringify(sorted(Object.keys(table.en)))
    ) {
      found.push(`${name}.${lang} does not have the keys of ${name}.en`);
    }
    for (const [key, value] of Object.entries(entries)) {
      found.push(...textProblems(value, `${name}.${lang}.${key}`, lang, max));
    }
  }
  return found;
}

test('the configuration offers the four languages, French by default', () => {
  assert.deepEqual(LANGUAGES, LANGS);
  const field = manifest.config_schema.find((f) => f.key === 'language');
  assert.equal(field.default, 'fr');
  assert.deepEqual(sorted(field.options.map((o) => o.value)), sorted(LANGS));
});

test('every text of the manifest is in English, French, German and Spanish', () => {
  const texts = manifestTexts(manifest);
  assert.ok(texts.length >= 35, `only ${texts.length} texts found in the manifest`);
  const found = texts.flatMap(({ path, value, max }) => problems(value, path, max));
  assert.deepEqual(found, []);
});

test('the name is the brand, the same in every language', () => {
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
});

test('the tables of the code have the four languages', () => {
  assert.deepEqual(tableProblems(NAMES, 'NAMES', MAX.featureName), []);
  assert.deepEqual(tableProblems(STATUS_TEXT, 'STATUS_TEXT', MAX.short), []);
  assert.deepEqual(tableProblems(TYPE_NAMES, 'TYPE_NAMES', MAX.short), []);
  assert.deepEqual(tableProblems(WIDGET_TEXT, 'WIDGET_TEXT', MAX.message), []);
  assert.deepEqual(tableProblems(ZONE_NAMES, 'ZONE_NAMES', MAX.short), []);
  assert.deepEqual(tableProblems(PHASE_TEXT, 'PHASE_TEXT', MAX.short), []);
  assert.deepEqual(tableProblems(FILTER_TEXT, 'FILTER_TEXT', MAX.short), []);
  assert.deepEqual(tableProblems(ALERT_TEXT, 'ALERT_TEXT', MAX.short), []);
  assert.deepEqual(tableProblems(OPTION_TEXT, 'OPTION_TEXT', MAX.short), []);
});

test('the messages of the code have the four languages', () => {
  const found = [
    ...Object.entries(CONNECTION_TEXT).flatMap(([k, v]) =>
      problems(v, `CONNECTION_TEXT.${k}`, MAX.message),
    ),
    ...Object.entries(COMMAND_TEXT).flatMap(([k, v]) =>
      problems(v, `COMMAND_TEXT.${k}`, MAX.message),
    ),
    ...Object.entries(TEST_TEXT).flatMap(([k, v]) => problems(v, `TEST_TEXT.${k}`, MAX.message)),
  ];
  assert.deepEqual(found, []);
});

test('the widget badges fit (16 characters)', () => {
  for (const lang of LANGS) {
    for (const key of ['finished', 'paused', 'alarm']) {
      assert.ok(WIDGET_TEXT[lang][key].length <= 16, `${lang}.${key}`);
    }
    for (const key of ['READY_TO_START', 'DELAYED_START', 'RUNNING', 'IDLE', 'OFF']) {
      assert.ok(STATUS_TEXT[lang][key].length <= 16, `${lang}.${key}: ${STATUS_TEXT[lang][key]}`);
    }
  }
});

test('every feature name, compartments included, fits the Gladys interface', () => {
  for (const lang of LANGS) {
    for (const [key, name] of Object.entries(NAMES[lang])) {
      for (const zone of Object.values(ZONE_NAMES[lang])) {
        const filled = name.replace('{zone}', zone);
        assert.ok(filled.length <= MAX.featureName, `${lang}.${key}: "${filled}"`);
      }
    }
  }
});

/** Level 2 headings of a documentation file. */
async function sections(lang) {
  const text = await readFile(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8');
  return text.split('\n').filter((line) => /^## /.test(line));
}

test('the four documentation files have the same sections, in the same order', async () => {
  const counts = {};
  for (const lang of LANGS) {
    counts[lang] = (await sections(lang)).length;
  }
  assert.ok(counts.en >= 8, `docs/en.md has ${counts.en} sections`);
  assert.deepEqual(counts, { en: counts.en, fr: counts.en, de: counts.en, es: counts.en });
  for (const lang of LANGS) {
    const text = await readFile(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8');
    assert.ok(text.length >= 3000, `docs/${lang}.md is short (${text.length})`);
    if (lang === 'de') {
      const polite = text.split('\n').filter((line) => POLITE_GERMAN.test(line));
      assert.deepEqual(polite, [], 'docs/de.md uses "du"');
    }
  }
});

test('the guard catches a missing language, an empty text and the wrong forms', () => {
  assert.equal(problems({ en: 'Light', fr: 'Éclairage', de: 'Licht' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'Light', fr: 'Éclairage', de: '', es: 'Luz' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a', es: 'a', it: 'a' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a'.repeat(61), es: 'a' }, 'x', 60).length, 1);
  for (const polite of ['Wählen Sie', 'Ihr Gerät', 'Ihre IP', 'mit Ihrem']) {
    assert.equal(problems({ en: 'a', fr: 'a', de: polite, es: 'a' }, 'x', 60).length, 1, polite);
  }
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a', es: 'Abre tu cuenta' }, 'x', 60).length, 1);
  assert.deepEqual(
    problems({ en: 'a', fr: 'a', de: 'Siebenschläfer, ihre', es: 'Abra su cuenta' }, 'x', 60),
    [],
  );
  const forgotten = structuredClone(manifest);
  delete forgotten.scene_actions[0].fields[1].label.de;
  const found = manifestTexts(forgotten).flatMap(({ path, value, max }) =>
    problems(value, path, max),
  );
  assert.deepEqual(found, [
    'manifest.scene_actions[0].fields[1].label has [en,fr,es], expected exactly [en,fr,de,es]',
  ]);
});
