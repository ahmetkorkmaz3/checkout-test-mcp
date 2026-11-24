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

  register(value: string | undefined): void {
    if (value && value.length >= 4) this.values.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const v of this.values) out = out.split(v).join(REDACTED);
    return out;
  }

  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactDeep(v);
      return out as T;
    }
    return value;
  }
}

/** Removes query string values from a URL: "?a=1&b=2" -> "?a=REDACTED&b=REDACTED". */
export function redactQuery(url: string): string {
  try {
    const u = new URL(url);
    if (!u.search) return url;
    for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, 'REDACTED');
    return u.toString();
  } catch {
    return url.replace(/\?.*$/, '?REDACTED');
  }
}
