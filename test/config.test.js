import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, hasCredentials, normalizeConfig } from '../src/config.js';

test('the configuration is normalized: trimmed secrets, a boolean toggle, French by default', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  const config = normalizeConfig({
    api_key: ' key ',
    refresh_token: ' token\n',
    allow_remote_start: 'true',
    language: 'xx',
  });
  assert.deepEqual(config, {
    api_key: 'key',
    refresh_token: 'token',
    allow_remote_start: true,
    language: 'fr',
  });
  assert.equal(normalizeConfig({ allow_remote_start: 'false' }).allow_remote_start, false);
  assert.equal(hasCredentials(config), true);
  assert.equal(hasCredentials(normalizeConfig({ api_key: 'key' })), false);
});
