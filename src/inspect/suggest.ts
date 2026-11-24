import type { z } from 'zod';
import { TEST_CARDS } from '../safety/test-cards.js';
import type { ExpectedOutcome } from '../schemas/common.js';
import type { CodeReport } from './code-scan.js';
import type { SiteReport } from './crawl.js';
import type { ProbeResult } from './probe.js';
import { matchesKind } from './words.js';

export type CardSource =
  | { kind: 'site_select'; option: string }
  | { kind: 'registry'; card_id: string }
  | null;

export interface Suggestion {
  id: string;
  title: string;
  expected_outcome: z.infer<typeof ExpectedOutcome>;
  baseline: boolean;
  why: string;
  evidence: string[];
  missing: string[];
  card_source: CardSource;
}

export interface SuggestInput {
  target: string;
  site: SiteReport | null;
  probe: ProbeResult | null;
  code: CodeReport | null;
  hasMemberSecrets: boolean;
}

interface CardSources {
  success: CardSource;
  decline: CardSource;
  evidence: string[];
  /** Why no source has a success or decline card. */
  missing: string[];
}

const GIFT_CARD =
  /gift\s*card|gift\s*voucher|hediye\s*(çeki|kartı|karti)|geschenkkarte|gutschein|carte\s*cadeau|tarjeta\s*regalo|carta\s*regalo|cadeaukaart|cadeaubon/iu;
const WALLETS: readonly [RegExp, string][] = [
  [/apple\s*pay/iu, 'apple-pay'],
  [/google\s*pay/iu, 'google-pay'],
  [/paypal/iu, 'paypal'],
  [/masterpass/iu, 'masterpass'],
  [/bkm\s*express/iu, 'bkm-express'],
];

const PROVIDERS_WITH_CARDS = new Set(TEST_CARDS.map((c) => c.provider));

function registryCards(provider: string): { success?: string; decline?: string } {
  const cards = TEST_CARDS.filter((c) => c.provider === provider);
  return {
    success: cards.find((c) => c.behaviour === 'success')?.id,
    decline: cards.find((c) => c.behaviour.startsWith('declined_'))?.id,
  };
}

function displayName(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * Finds the test card source in this order: the site test card select, a payment package
 * in the source code, a card iframe host. The site select wins, because the scenario
 * then selects an option by its text and never needs a card number.
 */
function findCardSources(probe: ProbeResult | null, code: CodeReport | null): CardSources {
  const select = probe?.payment?.test_card_select;
  if (select && select.options.length > 0) {
    const decline = select.options.find((o) => matchesKind('decline', o));
    const success = select.options.find((o) => !matchesKind('decline', o));
    const missing: string[] = [];
    if (!success) missing.push('a success option in the site test card select');
    if (!decline) missing.push('a decline option in the site test card select');
    return {
      success: success ? { kind: 'site_select', option: success } : null,
      decline: decline ? { kind: 'site_select', option: decline } : null,
      evidence: ['checkout_probe.payment.test_card_select'],
      missing,
    };
  }

  const hints = code?.payment_hints ?? [];
  const hintIndex = hints.findIndex((h) => h.provider !== null && PROVIDERS_WITH_CARDS.has(h.provider));
  let provider: string | undefined;
  let evidence: string[] = [];
  if (hintIndex >= 0) {
    const hint = hints[hintIndex];
    provider = hint?.provider ?? undefined;
    evidence = [`code.payment_hints[${hintIndex}] (${hint?.package})`];
  } else {
    const hosts = probe?.payment?.card_iframe_hosts ?? [];
    for (const [i, host] of hosts.entries()) {
      const p = [...PROVIDERS_WITH_CARDS].find((name) => host.toLowerCase().includes(name));
      if (p) {
        provider = p;
        evidence = [`checkout_probe.payment.card_iframe_hosts[${i}] (${host})`];
        break;
      }
    }
  }
  if (provider) {
    const cards = registryCards(provider);
    const missing: string[] = [];
    if (!cards.success) missing.push(`a ${displayName(provider)} success test card in the registry`);
    if (!cards.decline) missing.push(`a ${displayName(provider)} decline test card in the registry`);
    return {
      success: cards.success ? { kind: 'registry', card_id: cards.success } : null,
      decline: cards.decline ? { kind: 'registry', card_id: cards.decline } : null,
      evidence,
      missing,
    };
  }

  const noCards = [...new Set(hints.map((h) => h.provider).filter((p): p is string => p !== null))];
  const missing =
    noCards.length > 0
      ? noCards.map((p) => `no published ${displayName(p)} test cards; use the site test card select`)
      : ['a test card source: a test card select on the site, or a known payment package in source_dirs'];
  return { success: null, decline: null, evidence: [], missing };
}

function probeMissing(probe: ProbeResult | null): string[] {
  if (!probe) return ['a checkout probe result: set inspect.probe_checkout: true for this target'];
  if (probe.reached !== 'payment') {
    return [`the checkout probe stopped before the payment step (${probe.stopped_reason})`];
  }
  return [];
}

function loginEvidence(site: SiteReport | null, probe: ProbeResult | null): string[] {
  const out: string[] = [];
  for (const [i, p] of (site?.pages ?? []).entries()) {
    if (p.kind === 'login') out.push(`site.pages[${i}] (${p.path_pattern})`);
  }
  if (probe?.stopped_reason === 'login_required') out.push('checkout_probe.stopped_reason (login_required)');
  return out;
}

function otpEvidence(site: SiteReport | null, code: CodeReport | null): string[] {
  const out: string[] = [];
  for (const [i, p] of (site?.pages ?? []).entries()) {
    if (p.forms.some((f) => f.fields.some((fl) => fl.autocomplete === 'one-time-code'))) {
      out.push(`site.pages[${i}] (${p.path_pattern}) has a one-time code field`);
    }
  }
  for (const [i, h] of (code?.otp_hints ?? []).entries())
    out.push(`code.otp_hints[${i}] (${h.file}:${h.line})`);
  return out;
}

/** Rules from the scenario authoring spec, section 7.4. Rules make this list, not a model. */
export function suggestScenarios(input: SuggestInput): Suggestion[] {
  const { target, site, probe, code, hasMemberSecrets } = input;
  const payment = probe?.reached === 'payment' ? probe.payment : null;
  const cards = findCardSources(probe, code);
  const reachMissing = probeMissing(probe);
  const reachEvidence = payment
    ? [`checkout_probe.reached (payment)`, ...(probe?.guest_option ? ['checkout_probe.guest_option'] : [])]
    : [];
  const out: Suggestion[] = [];

  const make = (s: Omit<Suggestion, 'baseline'>, canBeBaseline: boolean): void => {
    out.push({ ...s, baseline: canBeBaseline && s.missing.length === 0 });
  };

  // Guest checkout with a success card.
  make(
    {
      id: `${target}-guest-card`,
      title: 'Guest checkout with a test card that succeeds',
      expected_outcome: 'order_placed',
      why: 'Proves that a guest can place an order with a card. It is the main checkout path.',
      evidence: [...reachEvidence, ...cards.evidence],
      missing: [...reachMissing, ...(cards.success ? [] : cards.missing)],
      card_source: cards.success,
    },
    true,
  );

  // Guest checkout with a decline card.
  make(
    {
      id: `${target}-card-declined`,
      title: 'Guest checkout with a test card that the bank declines',
      expected_outcome: 'payment_declined',
      why: 'Proves that a declined card shows an error and places no order.',
      evidence: [...reachEvidence, ...cards.evidence],
      missing: [...reachMissing, ...(cards.decline ? [] : cards.missing)],
      card_source: cards.decline,
    },
    true,
  );

  // Pay without the agreement checkbox.
  const checkbox = probe?.payment?.agreement_checkbox ?? null;
  make(
    {
      id: `${target}-terms-required`,
      title: 'Pay without the agreement checkbox',
      expected_outcome: 'validation_error',
      why: 'Proves that the site refuses the payment until the user accepts the terms.',
      evidence: checkbox ? ['checkout_probe.payment.agreement_checkbox'] : [],
      missing: checkbox
        ? []
        : probe?.reached === 'payment'
          ? ['an agreement checkbox on the payment step']
          : reachMissing,
      card_source: cards.success,
    },
    true,
  );

  // Member checkout. A member scenario also pays, so it needs a success card too.
  const login = loginEvidence(site, probe);
  make(
    {
      id: `${target}-member-card`,
      title: 'Member login and checkout with a test card that succeeds',
      expected_outcome: 'order_placed',
      why: 'Proves that a logged-in member can place an order with a card.',
      evidence: [...login, ...cards.evidence],
      missing: [
        ...(login.length > 0 ? [] : ['a login page on the site']),
        ...(hasMemberSecrets
          ? []
          : ['member secrets: map member_email and member_password in the target secrets config']),
        ...(cards.success ? [] : cards.missing),
      ],
      card_source: cards.success,
    },
    true,
  );

  // Offers: never baseline, they need input from the user.
  const otp = otpEvidence(site, code);
  if (otp.length > 0) {
    make(
      {
        id: `${target}-otp-login`,
        title: 'Login with a one-time code',
        expected_outcome: 'custom',
        why: 'The site asks for a one-time code. A test can read the code only when a test response shows it.',
        evidence: otp,
        missing: [
          'a way to read the code: a test response that shows it, or a fixed test code from the user',
        ],
        card_source: null,
      },
      false,
    );
  }

  const methods = payment?.methods ?? [];
  const giftIndex = methods.findIndex((m) => GIFT_CARD.test(m));
  if (giftIndex >= 0) {
    make(
      {
        id: `${target}-gift-card`,
        title: 'Pay with a gift card',
        expected_outcome: 'order_placed',
        why: 'The payment step lists a gift card method.',
        evidence: [`checkout_probe.payment.methods[${giftIndex}] (${methods[giftIndex]})`],
        missing: ['a gift card test number from the user'],
        card_source: null,
      },
      false,
    );
  }
  const seen = new Set<string>();
  for (const [i, m] of methods.entries()) {
    const slug = WALLETS.find(([re]) => re.test(m))?.[1];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    make(
      {
        id: `${target}-wallet-${slug}`,
        title: `Pay with ${m}`,
        expected_outcome: 'order_placed',
        why: `The payment step lists ${m}.`,
        evidence: [`checkout_probe.payment.methods[${i}] (${m})`],
        missing: [`a ${m} test account from the user`],
        card_source: null,
      },
      false,
    );
  }

  return out;
}
