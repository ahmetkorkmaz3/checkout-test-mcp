import { findCardLikeNumbers } from './cards.js';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
// 32+ characters of one token alphabet. Product text rarely has a word this long.
const LONG_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_-])/g;
const CARD_CANDIDATE = /\d(?:[ -]?\d){12,18}/g;
const PHONE_CANDIDATE = /(?<![\w+])\+?[ ]?\(?\d[\d ()]{7,}\d/g;

/**
 * Replaces personal data and tokens in text from a page or a source file.
 * Order matters: card numbers go before phone numbers, so a card is never reported as a phone.
 */
export function redactText(s: string): string {
  let out = s.replace(EMAIL, '<email>');
  out = out.replace(JWT, '<token>');
  out = out.replace(LONG_TOKEN, '<token>');
  out = out.replace(CARD_CANDIDATE, (raw) => {
    const digits = raw.replace(/[ -]/g, '');
    return findCardLikeNumbers(digits).length > 0 ? '<card>' : raw;
  });
  out = out.replace(PHONE_CANDIDATE, (raw) => {
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 13 ? '<phone>' : raw;
  });
  return out;
}
