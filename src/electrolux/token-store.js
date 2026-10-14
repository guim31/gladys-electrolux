// -----------------------------------------------------------------------------
// The Electrolux tokens, kept in /data/electrolux-auth.json (mode 600).
//
// The refresh token the user pastes in the configuration is single use: each
// refresh returns a new one and the old one stops working. The new pair must
// survive a restart, so it lives here, the only writable volume, and wins over
// the configuration... until the user pastes another refresh token: the file
// remembers a fingerprint (SHA-256) of the token it started from, and a
// different token in the configuration replaces everything.
//
// Nothing here ever reaches a log line or the Gladys configuration.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DEFAULT_DATA_DIR = '/data';
const FILE_NAME = 'electrolux-auth.json';

/** Fingerprint of a token: enough to tell two apart, useless to anyone else. */
export function fingerprint(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * @param {object} [options]
 * @param {string} [options.dir] where the file lives (tests use a temp dir)
 */
export function createTokenStore({ dir = process.env.DATA_DIR || DEFAULT_DATA_DIR } = {}) {
  const file = join(dir, FILE_NAME);
  let cache = null;

  async function load() {
    if (cache) {
      return cache;
    }
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // Missing (first start) or unreadable: start again from the configuration.
      cache = {};
    }
    return cache;
  }

  async function save(next) {
    cache = next;
    await mkdir(dirname(file), { recursive: true });
    // Write then rename: a crash in between never leaves half a file, and
    // never loses the refresh token that is now the only valid one.
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, file);
  }

  return {
    file,

    /**
     * The tokens to use with this configured refresh token: the stored ones
     * when they descend from it, else the configured one alone.
     * @param {string} configuredRefreshToken
     * @returns {Promise<{ refresh_token: string, access_token: string|null, expires_at: number }>}
     */
    async current(configuredRefreshToken) {
      const data = await load();
      const seed = fingerprint(configuredRefreshToken);
      if (data.seed === seed && typeof data.refresh_token === 'string' && data.refresh_token) {
        return {
          refresh_token: data.refresh_token,
          access_token: typeof data.access_token === 'string' ? data.access_token : null,
          expires_at: Number(data.expires_at) || 0,
        };
      }
      return { refresh_token: configuredRefreshToken, access_token: null, expires_at: 0 };
    },

    /**
     * Keep a fresh pair, descending from the configured refresh token.
     * @param {string} configuredRefreshToken
     * @param {{ refresh_token: string, access_token: string, expires_at: number }} tokens
     */
    async save(configuredRefreshToken, tokens) {
      await save({ seed: fingerprint(configuredRefreshToken), ...tokens });
    },

    async clear() {
      await save({});
    },
  };
}
