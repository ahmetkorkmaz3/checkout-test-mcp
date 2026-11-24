/**
 * Words that name a secret. The house rules use the same list for param, arg, and "with" names,
 * so a name that the secret pattern refuses is also a name that must not hold a literal.
 */
export const SECRET_KEYWORDS = /password|passwd|pwd|secret|api[_-]?key|token|şifre|sifre|parola/i;

/**
 * Strong secret words for free text, such as a param description or a visible label.
 * "token" and "secret" alone are too common there ("Discount token", "Secret Santa offer").
 */
export const STRONG_SECRET_WORDS =
  /(?<![\p{L}\p{N}_])(password|passwd|şifre|sifre|parola|api[ _-]?key|secret[ _-]?key)(?![\p{L}\p{N}_])/iu;

// "ş" is not an ASCII word character, so \b fails before "şifre". Unicode lookarounds keep the old
// ASCII boundaries: a letter, digit, or "_" before or after the keyword makes it part of another word.
const SECRET_ASSIGNMENT = new RegExp(
  `(?<![\\p{L}\\p{N}_])(${SECRET_KEYWORDS.source})(?![\\p{L}\\p{N}_])\\s*[=:]\\s*\\S+`,
  'iu',
);

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(sk|rk)_live_[A-Za-z0-9]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}/i,
  SECRET_ASSIGNMENT,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecret(text: string): boolean {
  // The Turkish lower case folds "İ" to "i". Without it, "ŞİFRE" does not match "şifre".
  const lower = text.toLocaleLowerCase('tr-TR');
  return SECRET_PATTERNS.some((re) => re.test(text) || re.test(lower));
}

export const REDACTED = '[REDACTED]';

/** Replaces registered values in strings. Register every secret and card value before a run starts. */
export class Redactor {
  private readonly values = new Set<string>();
  /** Card numbers and expiry forms. They match also when a page formats them. */
  private readonly patterns = new Map<string, RegExp>();
  /** CVC values. They are short, so they are redacted only in failure fields, unless a live card is in the run. */
  private readonly cvcs = new Map<string, RegExp>();
  private cvcEverywhere = false;

  /** True when a live CVC is registered. Then the whole run output loses a standalone CVC. */
  get redactsCvcEverywhere(): boolean {
    return this.cvcEverywhere;
  }

  register(value: string | undefined): void {
    if (value && value.length >= 4) this.values.add(value);
  }

  /**
   * Registers a card number. It matches with a single space or dash between any two digits,
   * the separators that findCardSpans accepts.
   */
  registerCardNumber(digits: string | undefined): void {
    if (!digits || !/^\d{4,}$/.test(digits)) return;
    this.patterns.set(`card:${digits}`, new RegExp(digits.split('').join('[ -]?'), 'g'));
  }

  /**
   * Registers an expiry in its common forms: MM/YY, MM / YY, MM-YY, MMYY, MM/YYYY, MM / YYYY.
   * Only for live cards. A test card registers its exact expiry with register(), because the short
   * forms also match order numbers and dates.
   */
  registerExpiry(expiry: string | undefined): void {
    if (!expiry) return;
    this.register(expiry);
    const m = /^\s*(\d{1,2})\s*[/ -]?\s*(\d{4}|\d{2})\s*$/.exec(expiry);
    if (!m) return;
    const mm = (m[1] as string).padStart(2, '0');
    const year = m[2] as string;
    const yy = year.slice(-2);
    const yyyy = year.length === 4 ? year : `20${year}`;
    for (const form of [
      `${mm}/${yy}`,
      `${mm} / ${yy}`,
      `${mm}-${yy}`,
      `${mm}${yy}`,
      `${mm}/${yyyy}`,
      `${mm} / ${yyyy}`,
    ]) {
      // Digit boundaries: "1234" must not cut into a longer number such as an order id.
      this.patterns.set(`exp:${form}`, new RegExp(`(?<!\\d)${escapeRegExp(form)}(?!\\d)`, 'g'));
    }
  }

  /** `everywhere` is for a live CVC: redactExecuteOutput then removes it from the whole output. */
  registerCvc(cvc: string | undefined, opts: { everywhere?: boolean } = {}): void {
    if (!cvc || !/^\d{3,4}$/.test(cvc)) return;
    this.cvcs.set(cvc, new RegExp(`(?<!\\d)${cvc}(?!\\d)`, 'g'));
    if (opts.everywhere) this.cvcEverywhere = true;
  }

  redact(text: string): string {
    let out = text;
    for (const re of this.patterns.values()) out = out.replace(re, REDACTED);
    for (const v of this.values) out = out.split(v).join(REDACTED);
    return out;
  }

  /** For failure.expected and failure.actual. Also removes a CVC that stands alone. */
  redactFailureText(text: string): string {
    let out = this.redact(text);
    for (const re of this.cvcs.values()) out = out.replace(re, REDACTED);
    return out;
  }

  redactDeep<T>(value: T, text: (s: string) => string = (s) => this.redact(s)): T {
    if (typeof value === 'string') return text(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v, text)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactDeep(v, text);
      return out as T;
    }
    return value;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes query string values from a URL: "?a=1&b=2" -> "?a=REDACTED&b=REDACTED". */
export function redactQuery(url: string): string {
  try {
    const u = new URL(url);
    if (!u.search && !u.username && !u.password) return url;
    // A user name and password in the URL are credentials.
    u.username = '';
    u.password = '';
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, 'REDACTED');
    return u.toString();
  } catch {
    return url.replace(/\/\/[^/?#]*@/, '//').replace(/\?.*$/, '?REDACTED');
  }
}
