import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { redactText } from '../../src/safety/redact-text.js';
import { looksLikeSecret, Redactor, redactQuery } from '../../src/safety/secrets.js';
import { providerForPackage, TEST_CARDS } from '../../src/safety/test-cards.js';
import type { TargetConfig } from '../../src/schemas/config.js';
import { resolveInside, YAML_PATH } from '../../src/util/paths.js';

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

  it('has a success and a decline card for iyzico, each with a source', () => {
    const cards = TEST_CARDS.filter((c) => c.provider === 'iyzico');
    expect(cards.some((c) => c.behaviour === 'success')).toBe(true);
    expect(cards.some((c) => c.behaviour.startsWith('declined'))).toBe(true);
    for (const c of cards) expect(c.source_url).toMatch(/^https:\/\/docs\.iyzico\.com\//);
  });

  it('maps payment packages to providers', () => {
    expect(providerForPackage('@stripe/stripe-js')).toBe('stripe');
    expect(providerForPackage('iyzipay')).toBe('iyzico');
    expect(providerForPackage('@craftgate/craftgate')).toBe('craftgate');
    expect(providerForPackage('left-pad')).toBeUndefined();
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

describe('resolveInside', () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'ctm-root-'));
    outside = mkdtempSync(path.join(os.tmpdir(), 'ctm-out-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it.each(['../x.yaml', '/etc/x.yaml', 'a/../../x.yaml', 'a\\b.yaml', 'Upper.yaml', 'x.yml.txt'])(
    'refuses %s',
    (rel) => {
      expect(() => resolveInside(root, rel, { pattern: YAML_PATH })).toThrow(
        expect.objectContaining({ code: 'PATH_REFUSED' }),
      );
    },
  );

  it('refuses a symlinked folder that leaves the root', () => {
    symlinkSync(outside, path.join(root, 'out'));
    expect(() => resolveInside(root, 'out/x.yaml', { pattern: YAML_PATH })).toThrow(
      expect.objectContaining({ code: 'PATH_REFUSED' }),
    );
  });

  it('refuses a symlinked folder when the target file does not exist yet in a deeper folder', () => {
    symlinkSync(outside, path.join(root, 'out'));
    expect(() => resolveInside(root, 'out/new/x.yaml', { pattern: YAML_PATH })).toThrow(
      expect.objectContaining({ code: 'PATH_REFUSED' }),
    );
  });

  it('refuses a leaf symlink that leaves the root', () => {
    writeFileSync(path.join(outside, 'evil.yaml'), 'x');
    symlinkSync(path.join(outside, 'evil.yaml'), path.join(root, 'x.yaml'));
    expect(() => resolveInside(root, 'x.yaml', { pattern: YAML_PATH })).toThrow(
      expect.objectContaining({ code: 'PATH_REFUSED' }),
    );
  });

  it('refuses a dangling symlink folder', () => {
    symlinkSync(path.join(outside, 'missing'), path.join(root, 'dang'));
    expect(() => resolveInside(root, 'dang/x.yaml', { pattern: YAML_PATH })).toThrow(
      expect.objectContaining({ code: 'PATH_REFUSED' }),
    );
  });

  it('refuses a root that does not exist, with a next action', () => {
    try {
      resolveInside(path.join(root, 'nope'), 'a.yaml', { pattern: YAML_PATH });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'PATH_REFUSED' });
      expect((err as { nextActions: unknown[] }).nextActions.length).toBeGreaterThan(0);
    }
  });

  it('returns the absolute path for a new file in a new folder', () => {
    expect(resolveInside(root, 'shop/new-one.yaml', { pattern: YAML_PATH })).toBe(
      path.join(root, 'shop/new-one.yaml'),
    );
  });

  it('accepts an existing folder inside the root', () => {
    mkdirSync(path.join(root, 'shop'));
    expect(resolveInside(root, 'shop/a.yaml', { pattern: YAML_PATH })).toBe(path.join(root, 'shop/a.yaml'));
  });

  it('accepts a root that is itself a symlink', () => {
    const link = path.join(outside, 'link');
    symlinkSync(realpathSync(root), link);
    expect(resolveInside(link, 'shop/a.yaml', { pattern: YAML_PATH })).toBe(path.join(link, 'shop/a.yaml'));
  });

  it('gives the error a next action', () => {
    try {
      resolveInside(root, '../x.yaml', { pattern: YAML_PATH });
      expect.unreachable();
    } catch (err) {
      expect((err as { nextActions: unknown[] }).nextActions.length).toBeGreaterThan(0);
    }
  });
});

describe('unregistered card guard with a registered card next to other digits', () => {
  it.each(['81578 4242 4242 4242 4242 831484804511', '135643 4242 4242 4242 4242 03246822939421'])(
    'blocks %s',
    (text) => {
      expect(containsUnregisteredCardNumber(text)).toBe(true);
      expect(redactText(text)).not.toMatch(/4242 4242 4242 4242/);
    },
  );
  it('allows a plain registered test card', () => {
    expect(containsUnregisteredCardNumber('4242 4242 4242 4242')).toBe(false);
  });
});

describe('card guard keeps every shape', () => {
  it.each([
    '41111111 11111111',
    '42424242 42424242',
    '3056 930902 5904',
    '4242 4242 4242 4242',
    '4242-4242-4242-4242',
    '4242424242424242',
    'card 4242 4242 4242 4242 2026',
    'Order 1 4242 4242 4242 4242',
  ])('flags %s', (text) => {
    expect(containsCardNumber(text)).toBe(true);
    expect(findCardLikeNumbers(text).length).toBeGreaterThan(0);
  });
  it.each(['20261124123045123456789', '123456789012345678901234'])('accepts the long id %s', (text) => {
    expect(containsCardNumber(text)).toBe(false);
  });
});

describe('redactText', () => {
  it.each(['41111111 11111111', '42424242 42424242', '3056 930902 5904'])('redacts card shape %s', (text) => {
    expect(redactText(text)).toBe('<card>');
  });
  it('redacts personal data and tokens but keeps product text', () => {
    expect(redactText('Mail ayse@shop.com, tel 0555 000 00 00, Tabak 19 cm')).toBe(
      'Mail <email>, tel <phone>, Tabak 19 cm',
    );
    expect(redactText('card 4242 4242 4242 4242')).toBe('card <card>');
  });
  it('redacts card numbers with dashes and not as a phone', () => {
    expect(redactText('4242-4242-4242-4242')).toBe('<card>');
    expect(redactText('4242424242424242')).toBe('<card>');
  });
  it('redacts phones with plus and brackets', () => {
    expect(redactText('+90 (555) 000 00 00')).toBe('<phone>');
    expect(redactText('+905550000000')).toBe('<phone>');
  });
  it('redacts JWT, base64, and hex tokens', () => {
    expect(redactText('t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefSIG end')).toBe('t <token> end');
    expect(redactText('k 0123456789abcdef0123456789abcdef')).toBe('k <token>');
    expect(redactText('k QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg=')).toBe('k <token>');
  });
  it.each([
    ['card 4242 4242 4242 4242 2026', 'card <card> 2026'],
    ['Order 1 4242 4242 4242 4242', 'Order 1 <card>'],
    ['Tel 0212 000 00 00 34000 Istanbul', 'Tel <phone> 34000 Istanbul'],
  ])('redacts next to other digits: %s', (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });
  it('redacts two phones in a row', () => {
    expect(redactText('0555 000 00 00 0555 111 11 11')).toBe('<phone> <phone>');
  });
  it('redacts a card inside a longer digit run', () => {
    const out = redactText('4242424242424242424242');
    expect(out).toContain('<card>');
    expect(out).not.toContain('4242424242424242');
  });
  it('redacts phones with dashes and dots', () => {
    expect(redactText('0555-000-00-00')).toBe('<phone>');
    expect(redactText('0555.000.00.00')).toBe('<phone>');
  });
  it.each([
    'data-testid="checkout-payment-card-number-input"',
    'https://shop.test/products/acme-tabak-seti-porselen-19-cm',
    'product-card__image-wrapper--large-variant',
  ])('keeps ordinary identifiers and urls: %s', (text) => {
    expect(redactText(text)).toBe(text);
  });
  it('keeps ordinary short numbers and text', () => {
    const text = 'Tabak 19 cm, 200 TL, posta kodu 34000, 2026-11-24';
    expect(redactText(text)).toBe(text);
  });
  it('does not report a 16-digit number that fails Luhn as a card', () => {
    const out = redactText('1234 5678 9012 3456');
    expect(out).not.toContain('<card>');
    expect(out).not.toContain('1234 5678');
  });
});
