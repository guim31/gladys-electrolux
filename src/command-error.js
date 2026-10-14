// A refused command, with its message in the four languages: the ack carries
// the user's language (`message`), the scene log the multi-language object.

import { pickLanguage } from './i18n.js';

export class CommandError extends Error {
  /**
   * @param {Record<string, string>} texts multi-language message
   * @param {string} language the language of `message` (logs, acks)
   */
  constructor(texts, language) {
    super(texts[pickLanguage(language)]);
    this.name = 'CommandError';
    this.texts = texts;
  }
}
