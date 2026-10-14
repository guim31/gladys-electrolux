// -----------------------------------------------------------------------------
// Integration configuration: the defaults (mirroring the manifest
// `config_schema`) and the normalization of what Gladys sends.
//
// The refresh token configured here is only the starting point: it rotates
// at each refresh, and the current one lives in /data
// (src/electrolux/token-store.js).
// -----------------------------------------------------------------------------

import { LANGUAGES, pickLanguage } from './i18n.js';

export { LANGUAGES };

// Must match the `default` values of the manifest (test/manifest.test.js).
export const DEFAULT_CONFIG = {
  api_key: '',
  refresh_token: '',
  allow_remote_start: false,
  language: 'fr',
};

/** Gladys stores the values as text: a toggle may arrive as "true". */
function toBoolean(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

/**
 * @param {Record<string, unknown>} [raw] config as Gladys sends it
 */
export function normalizeConfig(raw = {}) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  return {
    api_key: text(raw.api_key),
    refresh_token: text(raw.refresh_token),
    allow_remote_start: toBoolean(raw.allow_remote_start ?? DEFAULT_CONFIG.allow_remote_start),
    language: pickLanguage(raw.language ?? DEFAULT_CONFIG.language),
  };
}

/** Whether the API key and the refresh token are filled in. */
export function hasCredentials(config) {
  return config.api_key !== '' && config.refresh_token !== '';
}
