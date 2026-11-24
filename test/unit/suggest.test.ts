import { describe, expect, it } from 'vitest';
import type { CodeReport } from '../../src/inspect/code-scan.js';
import type { PageSnapshot, SiteReport } from '../../src/inspect/crawl.js';
import type { ProbePayment, ProbeResult } from '../../src/inspect/probe.js';
import { suggestScenarios } from '../../src/inspect/suggest.js';

function page(kind: PageSnapshot['kind'], path: string, extra: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    path_pattern: path,
    url_path: path,
    kind,
    kind_reasons: [],
    title: '',
    headings: [],
    landmarks: [],
    elements: [],
    forms: [],
    selects: [],
    iframes: [],
    dialogs: [],
    ...extra,
  };
}

const site: SiteReport = {
  pages: [page('home', '/'), page('product', '/p/*'), page('cart', '/cart')],
  api_calls: [],
  blocked_hosts: [],
};

const siteWithLogin: SiteReport = { ...site, pages: [...site.pages, page('login', '/login')] };

function probeWith(payment: Partial<ProbePayment>, extra: Partial<ProbeResult> = {}): ProbeResult {
  return {
    reached: 'payment',
    stopped_reason: 'payment_step_reached',
    steps: [],
    dialogs: [],
    guest_option: true,
    payment: {
      methods: [],
      card_form: true,
      card_iframe_hosts: [],
      card_frames: [],
      card_fields: [],
      test_card_select: null,
      agreement_checkbox: null,
      pay_button: 'Pay now',
      ...payment,
    },
    side_effects: [],
    ...extra,
  };
}

function code(hints: CodeReport['payment_hints'], extra: Partial<CodeReport> = {}): CodeReport {
  return {
    frameworks: [],
    routes: [],
    ui_strings: [],
    test_ids: [],
    payment_hints: hints,
    otp_hints: [],
    stats: { files: 1, skipped: 0, truncated: false },
    warnings: [],
    ...extra,
  };
}

const TR_SELECT = {
  test_card_select: {
    label: 'Test kartı',
    options: [{ text: 'Akbank - Master Card (Credit)' }, { text: '3DS Tamamlama - İşlem onaylanmadı' }],
  },
  agreement_checkbox: 'Ön Bilgilendirme Formu…',
};

describe('suggestScenarios', () => {
  it('makes the baseline set from a probe that reached payment with a site test card select', () => {
    const s = suggestScenarios({
      target: 'k',
      site,
      probe: probeWith(TR_SELECT),
      code: null,
      hasMemberSecrets: false,
    });
    expect(s.filter((x) => x.baseline).map((x) => x.id)).toEqual([
      'k-guest-card',
      'k-card-declined',
      'k-terms-required',
    ]);
    expect(s.find((x) => x.id === 'k-card-declined')?.card_source).toEqual({
      kind: 'site_select',
      option: '3DS Tamamlama - İşlem onaylanmadı',
    });
    expect(s.find((x) => x.id === 'k-guest-card')?.card_source).toEqual({
      kind: 'site_select',
      option: 'Akbank - Master Card (Credit)',
    });
    expect(s.find((x) => x.id === 'k-guest-card')?.evidence).toContain(
      'checkout_probe.payment.test_card_select',
    );
    for (const x of s.filter((y) => y.baseline)) expect(x.missing).toEqual([]);
  });

  it('adds member-card only with member secrets', () => {
    const without = suggestScenarios({
      target: 'k',
      site: siteWithLogin,
      probe: probeWith(TR_SELECT),
      code: null,
      hasMemberSecrets: false,
    });
    const member = without.find((x) => x.id === 'k-member-card');
    expect(member?.baseline).toBe(false);
    expect(member?.missing.join(' ')).toMatch(/member_email/);

    const withSecrets = suggestScenarios({
      target: 'k',
      site: siteWithLogin,
      probe: probeWith(TR_SELECT),
      code: null,
      hasMemberSecrets: true,
    });
    expect(withSecrets.filter((x) => x.baseline).map((x) => x.id)).toContain('k-member-card');
  });

  it('needs a login page for member-card', () => {
    const s = suggestScenarios({
      target: 'k',
      site,
      probe: probeWith(TR_SELECT),
      code: null,
      hasMemberSecrets: true,
    });
    expect(s.find((x) => x.id === 'k-member-card')?.baseline).toBe(false);
  });

  it('uses the registry when code shows a payment package', () => {
    const s = suggestScenarios({
      target: 'k',
      site,
      probe: probeWith({}),
      code: code([{ provider: 'iyzico', package: 'iyzipay', file: 'package.json' }]),
      hasMemberSecrets: false,
    });
    const guest = s.find((x) => x.id === 'k-guest-card');
    expect(guest?.baseline).toBe(true);
    expect(guest?.card_source).toEqual({ kind: 'registry', card_id: 'iyzico/mastercard-credit-success' });
    expect(s.find((x) => x.id === 'k-card-declined')?.card_source).toEqual({
      kind: 'registry',
      card_id: 'iyzico/declined-insufficient-funds',
    });
    expect(guest?.evidence).toContain('code.payment_hints[0] (iyzipay)');
  });

  it('prefers the site select over the registry', () => {
    const s = suggestScenarios({
      target: 'k',
      site,
      probe: probeWith(TR_SELECT),
      code: code([{ provider: 'stripe', package: '@stripe/stripe-js', file: 'package.json' }]),
      hasMemberSecrets: false,
    });
    expect(s.find((x) => x.id === 'k-guest-card')?.card_source?.kind).toBe('site_select');
  });

  it('skips a provider without cards and takes the next one', () => {
    const s = suggestScenarios({
      target: 'k',
      site,
      probe: probeWith({}),
      code: code([
        { provider: 'craftgate', package: '@craftgate/craftgate', file: 'package.json' },
        { provider: 'stripe', package: 'stripe', file: 'package.json' },
      ]),
      hasMemberSecrets: false,
    });
    expect(s.find((x) => x.id === 'k-guest-card')?.card_source).toEqual({
      kind: 'registry',
      card_id: 'stripe/visa-success',
    });
  });

  it('gives no card source for Craftgate alone and says what is missing', () => {
    const s = suggestScenarios({
      target: 'k',
      site,
      probe: probeWith({}),
      code: code([{ provider: 'craftgate', package: '@craftgate/craftgate', file: 'package.json' }]),
      hasMemberSecrets: false,
    });
    const guest = s.find((x) => x.id === 'k-guest-card');
    expect(guest?.card_source).toBeNull();
    expect(guest?.baseline).toBe(false);
    expect(guest?.missing).toContain('no published Craftgate test cards; use the site test card select');
  });

  it('finds the registry provider from the card iframe host', () => {
    const s = suggestScenarios({
      target: 'k',
      site,
      probe: probeWith({ card_iframe_hosts: ['js.stripe.com'] }),
      code: null,
      hasMemberSecrets: false,
    });
    expect(s.find((x) => x.id === 'k-guest-card')?.card_source).toEqual({
      kind: 'registry',
      card_id: 'stripe/visa-success',
    });
  });

  it('has no decline suggestion as baseline when the site select has no decline option', () => {
    const s = suggestScenarios({
      target: 'k',
      site,
      probe: probeWith({ test_card_select: { label: 'Test card', options: [{ text: 'Visa success' }] } }),
      code: null,
      hasMemberSecrets: false,
    });
    expect(s.filter((x) => x.baseline).map((x) => x.id)).toEqual(['k-guest-card']);
    expect(s.find((x) => x.id === 'k-card-declined')?.missing.length).toBeGreaterThan(0);
  });

  it('uses the option value when the option text hides a card number', () => {
    const s = suggestScenarios({
      target: 'k',
      site,
      probe: probeWith({
        test_card_select: {
          label: 'Test card',
          options: [
            { text: '<card> - Success', value: '0' },
            { text: '<card> - Declined', value: '1' },
          ],
        },
      }),
      code: null,
      hasMemberSecrets: false,
    });
    expect(s.find((x) => x.id === 'k-guest-card')?.card_source).toEqual({
      kind: 'site_select',
      option: '<card> - Success',
      value: '0',
    });
    expect(s.find((x) => x.id === 'k-card-declined')?.card_source).toEqual({
      kind: 'site_select',
      option: '<card> - Declined',
      value: '1',
    });
  });

  it('says what is missing when neither the option text nor the value is usable', () => {
    const s = suggestScenarios({
      target: 'k',
      site,
      probe: probeWith({
        test_card_select: {
          label: 'Test card',
          options: [{ text: '<card> - Success' }, { text: '<card> - Declined' }],
        },
      }),
      code: null,
      hasMemberSecrets: false,
    });
    const guest = s.find((x) => x.id === 'k-guest-card');
    expect(guest?.card_source).toBeNull();
    expect(guest?.baseline).toBe(false);
    expect(guest?.missing.join(' ')).toMatch(/card number in its text and no usable value/);
  });

  it('makes no baseline without a probe and says why', () => {
    const s = suggestScenarios({ target: 'k', site, probe: null, code: null, hasMemberSecrets: false });
    expect(s.filter((x) => x.baseline)).toEqual([]);
    expect(s.find((x) => x.id === 'k-guest-card')?.missing.join(' ')).toMatch(/probe_checkout/);
  });

  it('offers gift card, wallet, and OTP login scenarios from the evidence', () => {
    const s = suggestScenarios({
      target: 'k',
      site,
      probe: probeWith({ methods: ['Kredi Kartı', 'Hediye Çeki', 'Apple Pay'] }),
      code: code([], { otp_hints: [{ text: 'sendOtpCode', file: 'app/api/otp/route.ts', line: 3 }] }),
      hasMemberSecrets: false,
    });
    const offers = s.filter((x) => !x.baseline).map((x) => x.id);
    expect(offers).toEqual(expect.arrayContaining(['k-gift-card', 'k-wallet-apple-pay', 'k-otp-login']));
    expect(s.find((x) => x.id === 'k-gift-card')?.missing.length).toBeGreaterThan(0);
  });
});
