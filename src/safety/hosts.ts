import type { ResolvedConfig, TargetConfig } from '../schemas/config.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const TEST_LABEL = /^(staging|stage|stg|test|qa|dev|sandbox|preview|uat)(-|\d|$)/;

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

export function isLocalHost(host: string): boolean {
  const h = normalizeHost(host);
  return LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || h.endsWith('.test');
}

export function hasTestLabel(host: string): boolean {
  return normalizeHost(host)
    .split('.')
    .some((label) => TEST_LABEL.test(label));
}

/** True when `host` matches `pattern`. A pattern "*.shop.test" matches "a.shop.test", not "shop.test". */
export function hostMatches(host: string, pattern: string): boolean {
  const h = normalizeHost(host);
  const p = normalizeHost(pattern);
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return h === p;
}

export function matchesAny(host: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => hostMatches(host, p));
}

export type HostCheck = { ok: true } | { ok: false; reason: 'production' | 'unlabeled' };

/**
 * Production check for a host the target owns (base_url host and allowed_hosts).
 * Third-party payment hosts are not checked for labels, only against production_hosts.
 */
export function checkTargetHost(
  host: string,
  target: TargetConfig,
  config: Pick<ResolvedConfig, 'production_hosts'>,
): HostCheck {
  const pattern = host.startsWith('*.') ? host.slice(2) : host;
  if (matchesAny(pattern, config.production_hosts)) return { ok: false, reason: 'production' };
  if (isLocalHost(pattern) || hasTestLabel(pattern)) return { ok: true };
  if (target.allow_unlabeled_host && config.production_hosts.length > 0) return { ok: true };
  return { ok: false, reason: 'unlabeled' };
}

export function hostOf(url: string): string {
  return normalizeHost(new URL(url).hostname);
}

/** Request guard used by the browser: is this URL allowed for the target? */
export function isUrlAllowed(
  url: string,
  target: TargetConfig,
  config: Pick<ResolvedConfig, 'production_hosts'>,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:') return true;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = normalizeHost(parsed.hostname);
  if (matchesAny(host, config.production_hosts)) return false;
  return matchesAny(host, target.allowed_hosts) || matchesAny(host, target.third_party_hosts);
}
