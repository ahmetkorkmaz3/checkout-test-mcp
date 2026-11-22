import { describe, expect, it } from 'vitest';
import {
  containsCardNumber,
  containsUnregisteredCardNumber,
  findCardLikeNumbers,
  luhnValid,
} from '../../src/safety/cards.js';
import {
  checkTargetHost,
  hasTestLabel,
  hostMatches,
  isLocalHost,
  isUrlAllowed,
} from '../../src/safety/hosts.js';
import { looksLikeSecret, Redactor, redactQuery } from '../../src/safety/secrets.js';
import { TEST_CARDS } from '../../src/safety/test-cards.js';
import type { TargetConfig } from '../../src/schemas/config.js';

const target = (over: Partial<TargetConfig> = {}): TargetConfig => ({
  description: '',
  profile: 'p',
  base_url: 'https://staging.shop.test',
  allowed_hosts: ['staging.shop.test'],
  third_party_hosts: ['sandbox-api.iyzipay.com'],
  allow_unlabeled_host: false,
  test_id_attribute: 'data-testid',
  secrets: {},
  ...over,
});

describe('test card registry', () => {
  it('has only Luhn-valid numbers with a source URL', () => {
    for (const c of TEST_CARDS) {
      expect(luhnValid(c.number), c.id).toBe(true);
      expect(c.source_url).toMatch(/^https:\/\//);
    }
  });

  it('has unique ids', () => {
    expect(new Set(TEST_CARDS.map((c) => c.id)).size).toBe(TEST_CARDS.length);
  });
});

describe('card guard', () => {
  it('finds card numbers with spaces and dashes', () => {
    expect(findCardLikeNumbers('pay with 4242 4242 4242 4242 now')).toEqual(['4242424242424242']);
    expect(findCardLikeNumbers('4000-0000-0000-3220')).toEqual(['4000000000003220']);
  });

  it('ignores numbers that fail Luhn or have the wrong length', () => {
    expect(findCardLikeNumbers('order 1234567890123')).toEqual([]);
    expect(findCardLikeNumbers('+90 555 000 00 00')).toEqual([]);
  });

  it('refuses an unregistered card number but accepts a registered test card at fill time', () => {
    expect(containsUnregisteredCardNumber('4242424242424242')).toBe(false);
    expect(containsUnregisteredCardNumber('4111111111111111')).toBe(true);
  });

  it('refuses any card number in tool arguments', () => {
    expect(containsCardNumber(JSON.stringify({ note: '4242424242424242' }))).toBe(true);
    expect(containsCardNumber(JSON.stringify({ card: 'stripe/visa-success' }))).toBe(false);
  });
});

describe('host checks', () => {
  it('knows local hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', 'shop.localhost', 'shop.test'])
      expect(isLocalHost(h), h).toBe(true);
    expect(isLocalHost('shop.com')).toBe(false);
  });

  it('knows test labels', () => {
    for (const h of ['staging.shop.com', 'qa2.shop.com', 'preview-123.shop.com', 'api.uat.shop.com']) {
      expect(hasTestLabel(h), h).toBe(true);
    }
    for (const h of ['www.shop.com', 'shop.com', 'testimonials.shop.com', 'devices.shop.com']) {
      expect(hasTestLabel(h), h).toBe(false);
    }
  });

  it('matches wildcard patterns only on subdomains', () => {
    expect(hostMatches('a.shop.test', '*.shop.test')).toBe(true);
    expect(hostMatches('shop.test', '*.shop.test')).toBe(false);
    expect(hostMatches('evilshop.test', '*.shop.test')).toBe(false);
  });

  it('refuses production hosts even with allow_unlabeled_host', () => {
    const t = target({ allow_unlabeled_host: true });
    expect(checkTargetHost('www.shop.com', t, { production_hosts: ['www.shop.com'] })).toEqual({
      ok: false,
      reason: 'production',
    });
  });

  it('refuses unlabeled hosts unless allow_unlabeled_host is set with production_hosts', () => {
    expect(checkTargetHost('checkout.shop.com', target(), { production_hosts: [] })).toEqual({
      ok: false,
      reason: 'unlabeled',
    });
    expect(
      checkTargetHost('checkout.shop.com', target({ allow_unlabeled_host: true }), { production_hosts: [] }),
    ).toEqual({
      ok: false,
      reason: 'unlabeled',
    });
    expect(
      checkTargetHost('checkout.shop.com', target({ allow_unlabeled_host: true }), {
        production_hosts: ['www.shop.com'],
      }),
    ).toEqual({ ok: true });
  });

  it('allows only target and third-party hosts in the browser', () => {
    const cfg = { production_hosts: ['www.shop.com'] };
    expect(isUrlAllowed('https://staging.shop.test/cart', target(), cfg)).toBe(true);
    expect(isUrlAllowed('https://sandbox-api.iyzipay.com/x', target(), cfg)).toBe(true);
    expect(isUrlAllowed('https://www.google-analytics.com/collect', target(), cfg)).toBe(false);
    expect(isUrlAllowed('data:image/png;base64,AA', target(), cfg)).toBe(true);
    expect(isUrlAllowed('file:///etc/passwd', target(), cfg)).toBe(false);
    expect(isUrlAllowed('https://www.shop.com/', target({ allowed_hosts: ['www.shop.com'] }), cfg)).toBe(
      false,
    );
  });
});

describe('secrets', () => {
  it('detects secret-like values', () => {
    expect(looksLikeSecret('sk_live_abcdefgh12345')).toBe(true);
    expect(looksLikeSecret('Bearer abcdefghijklmnop')).toBe(true);
    expect(looksLikeSecret('password=hunter2')).toBe(true);
    expect(looksLikeSecret('pr-4812-3ds-fail')).toBe(false);
  });

  it('redacts registered values deeply', () => {
    const r = new Redactor();
    r.register('s3cr3t-value');
    expect(r.redactDeep({ a: ['x s3cr3t-value y'], b: 1 })).toEqual({ a: ['x [REDACTED] y'], b: 1 });
  });

  it('redacts query string values', () => {
    expect(redactQuery('https://a.test/p?token=abc&x=1')).toBe('https://a.test/p?token=REDACTED&x=REDACTED');
    expect(redactQuery('https://a.test/p')).toBe('https://a.test/p');
  });
});
