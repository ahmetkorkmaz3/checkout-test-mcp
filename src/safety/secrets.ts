/**
 * Words that name a secret. The house rules use the same list for param, arg, and "with" names,
 * so a name that the secret pattern refuses is also a name that must not hold a literal.
 */
export const SECRET_KEYWORDS = /password|passwd|pwd|secret|api[_-]?key|token|şifre|sifre|parola/i;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(sk|rk)_live_[A-Za-z0-9]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}/i,
  new RegExp(`\\b(${SECRET_KEYWORDS.source})\\s*[=:]\\s*\\S+`, 'i'),
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
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
