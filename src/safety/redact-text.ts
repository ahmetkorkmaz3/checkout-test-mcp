import { findCardSpans, splitDigitRun } from './cards.js';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const HEX_TOKEN = /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g;
const BASE64_TOKEN = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_-])/g;
const PHONE_RUN = /(?<![A-Za-z0-9])\+?\(?\d[\d ().-]*\d/g;

/** Base64 text needs a digit, an upper letter, and a lower letter. This keeps ids like "checkout-card-input". */
function looksLikeBase64Secret(s: string): boolean {
  return /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

function redactCards(text: string): string {
  const spans = findCardSpans(text, { longRuns: true, dedupe: true });
  let out = '';
  let at = 0;
  for (const span of spans) {
    out += `${text.slice(at, span.start)}<card>`;
    at = span.end;
  }
  return out + text.slice(at);
}

function redactPhones(text: string): string {
  return text.replace(PHONE_RUN, (run) => {
    const { digits, pos, groupStart } = splitDigitRun(run, 0);
    const n = digits.length;
    let out = '';
    let at = 0;
    let i = 0;
    // Leftmost, longest window of 10 to 13 digits on group boundaries. Fail closed on long runs.
    while (n - i >= 10) {
      let found: [number, number] | undefined;
      for (let s = i; s + 10 <= n && !found; s++) {
        if (!groupStart[s]) continue;
        for (let len = 13; len >= 10; len--) {
          if (s + len <= n && (s + len === n || groupStart[s + len])) {
            found = [s, len];
            break;
          }
        }
      }
      if (!found) break;
      const [s, len] = found;
      const start = s === 0 ? 0 : (pos[s] as number);
      const end = (pos[s + len - 1] as number) + 1;
      out += `${run.slice(at, start)}<phone>`;
      at = end;
      i = s + len;
    }
    return out + run.slice(at);
  });
}

/**
 * Replaces personal data and tokens in text from a page or a source file.
 * Order matters: card numbers go before phone numbers, so a card is never reported as a phone.
 */
export function redactText(s: string): string {
  let out = s.replace(EMAIL, '<email>');
  out = out.replace(JWT, '<token>');
  out = out.replace(HEX_TOKEN, '<token>');
  out = out.replace(BASE64_TOKEN, (m) => (looksLikeBase64Secret(m) ? '<token>' : m));
  out = redactCards(out);
  return redactPhones(out);
}
