import type { Frame, Locator, Page } from 'playwright';
import { CARD_INPUT_HINT_RE, cardInputs } from '../safety/card-inputs.js';
import { redactText } from '../safety/redact-text.js';
import { STRONG_SECRET_WORDS } from '../safety/secrets.js';
import { matchesKind, type WordKind } from './words.js';

/**
 * The only place where the inspection clicks, fills, or selects on a page.
 * Every rule that keeps the probe from paying or sending a code is here, so a reviewer checks one file.
 */

export type ActionResult = 'done' | 'refused' | 'failed';
/** Receives each action and its result. The action text holds labels only, never a typed value. */
export type ActionLog = (action: string, result: ActionResult) => void;
type Words = Partial<Record<WordKind, string[]>>;

const ACTION_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 2_000;

/** Labels of buttons that send or check a one-time code. The probe never clicks them. */
export const SEND_CODE =
  /(?<![\p{L}\p{N}])(send code|send the code|send sms|send a code|get code|get a code|request code|resend|verify|verification|otp|sms|kod gönder|kodu gönder|şifre gönder|doğrula|doğrulama|tekrar gönder|code senden|code anfordern|envoyer le code|renvoyer|vérifier|enviar código|reenviar|verificar|invia codice|verifica|code versturen|verstuur code|verifiëren)(?![\p{L}\p{N}])/iu;

const clean = (s: string | null | undefined): string =>
  redactText((s ?? '').replace(/\s+/g, ' ').trim()).slice(0, 120);

/** True when any frame of the page has a card input. The rule is isCardInput in src/safety/card-inputs.ts. */
export async function hasCardFields(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const n = await cardInputs(frame)
      .count()
      .catch(() => 0);
    if (n > 0) return true;
  }
  return false;
}

/**
 * Labels of a button that saves a step and goes on. A form submit button is clicked only when its
 * name matches this list or GO_TO_PAYMENT.
 */
export const CONTINUE =
  /(?<![\p{L}\p{N}])(continue|save and continue|next|use this address|devam|devam et|kaydet ve devam et|bu adresi kullan|weiter|suivant|continuar|avanti|volgende)(?![\p{L}\p{N}])/iu;

/**
 * Explicit phrases that open the payment step. The checkout word list is not allowed here: on some
 * shops a checkout phrase such as "Passer la commande" places the order.
 */
export const GO_TO_PAYMENT =
  /(?<![\p{L}\p{N}])(continue to payment|ödemeye geç|ödeme adımına geç|weiter zur zahlung|continuer vers le paiement|continuar al pago|prosegui al pagamento|doorgaan naar betalen)(?![\p{L}\p{N}])/iu;

/** True when a name can save a form step and go on. The guard still refuses a pay name. */
export function isContinueName(name: string): boolean {
  const n = name.normalize('NFC');
  return CONTINUE.test(n) || GO_TO_PAYMENT.test(n);
}

/**
 * What the probe expects to click in the current step. The element name must match it.
 * `list` is a custom select (role combobox), and `list_option` is one of its options (role option).
 */
export type ClickKind =
  | 'add_to_cart'
  | 'cart'
  | 'checkout'
  | 'guest'
  | 'cookie_reject'
  | 'continue'
  | 'list'
  | 'list_option';

// Host words: these match at the start of a host label, so "payments" and "cards" count.
const HOST_PREFIX_WORDS = [
  'pay',
  'card',
  'checkout',
  '3ds',
  'odeme',
  'kart',
  'zahlung',
  'paiement',
  'pago',
  'pagamento',
  'betaal',
];
// "secure" counts only as a whole host label: "securepubads" is an ad host.
const HOST_EXACT_WORDS = ['secure', 'payment'];
// Provider names count anywhere in the host, for example "sandbox-api.iyzipay.com".
const HOST_PROVIDERS = ['craftgate', 'iyzi', 'stripe', 'adyen', 'masterpass', 'braintree'];
/** Payment words in a frame title or in the text around the frame. They match at a word start. */
const PAYMENT_TEXT =
  /(?<![\p{L}\p{N}])(pay|payment|card|3ds|3d secure|secure payment|checkout|craftgate|iyzi|stripe|adyen|masterpass|braintree|ödeme|kart|kredi kartı|zahlung|kreditkarte|paiement|carte bancaire|pago|tarjeta|pagamento|carta di credito|betaal)/iu;

/**
 * True when a blocked frame looks like a payment frame: its host or title has a payment word, or
 * the text around it does. Tag manager, ad, and chat frames that the guard blocked do not count.
 */
export function isPaymentFrame(frame: { src: string; title: string; context: string }): boolean {
  let host = '';
  try {
    host = new URL(frame.src).hostname.toLowerCase();
  } catch {
    host = '';
  }
  const labels = host.split(/[.\-_]/).filter(Boolean);
  if (labels.some((l) => HOST_PREFIX_WORDS.some((w) => l.startsWith(w)))) return true;
  if (labels.some((l) => HOST_EXACT_WORDS.includes(l))) return true;
  if (frame.src.toLowerCase().includes('checkout.com')) return true;
  if (HOST_PROVIDERS.some((w) => host.includes(w))) return true;
  return PAYMENT_TEXT.test(frame.title.normalize('NFC')) || PAYMENT_TEXT.test(frame.context.normalize('NFC'));
}

/** Frame loads that the host guard blocked: by URL, and by the Playwright frame with its blocked URL. */
export interface BlockedFrames {
  urls: ReadonlySet<string>;
  /** A same-host frame that redirects to a blocked host has a src that is not the blocked URL. */
  frames?: ReadonlyMap<Frame, string>;
}

/** The blocked URL of an iframe, by its src or by its frame, or null when the guard did not block it. */
export function blockedUrlOf(blocked: BlockedFrames, src: string, frame: Frame | null): string | null {
  if (blocked.urls.has(src)) return src;
  return (frame && blocked.frames?.get(frame)) ?? null;
}

/**
 * True when an iframe on the page has a load that the host guard blocked, and the frame looks
 * like a payment frame. Such a frame can be a card form on a provider host that the target does not list.
 * It fails closed: when the page cannot be read and a frame was blocked, it returns true.
 */
export async function hasBlockedFrame(page: Page, blocked: BlockedFrames): Promise<boolean> {
  if (blocked.urls.size === 0 && (blocked.frames?.size ?? 0) === 0) return false;
  let handles: Awaited<ReturnType<Locator['elementHandles']>>;
  try {
    handles = await page.locator('iframe').elementHandles();
  } catch {
    return true;
  }
  for (const handle of handles) {
    let facts: { src: string; title: string; context: string };
    let frame: Frame | null;
    try {
      facts = await handle.evaluate((e) => {
        const frame = e as HTMLIFrameElement;
        // The text of the nearest container, up to 5 levels. A form or landmark ends the walk.
        let context = '';
        let el = frame.parentElement;
        for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
          if (/^(FORM|MAIN|NAV|ASIDE|HEADER|FOOTER|BODY|HTML)$/.test(el.tagName)) break;
          if (
            /^(form|main|navigation|complementary|contentinfo|search|banner)$/.test(
              el.getAttribute('role') ?? '',
            )
          )
            break;
          // biome-ignore lint/performance/useDomNodeTextContent: only visible text counts.
          const text = el.innerText ?? '';
          if (text.trim() !== '') {
            context = text.slice(0, 2000);
            break;
          }
        }
        return { src: frame.src, title: frame.getAttribute('title') ?? '', context };
      });
      frame = await handle.contentFrame();
    } catch {
      return true;
    }
    const url = blockedUrlOf(blocked, facts.src, frame);
    if (url !== null && isPaymentFrame({ ...facts, src: url })) return true;
  }
  return false;
}

export interface ClickFacts {
  /** The accessible name: aria-label, aria-labelledby, alt, value, text, title, or label. */
  name: string;
  /** Every text source of the element. The pay, cookie accept, and send-code checks read all of them. */
  texts: string[];
  role: string;
  otpOnPage: boolean;
  passwordInForm: boolean;
}

async function clickFacts(loc: Locator): Promise<ClickFacts | null> {
  return loc
    .evaluate(
      (e) => {
        const input = e as HTMLInputElement;
        const isInput = e.tagName === 'INPUT';
        const type = isInput ? input.type.toLowerCase() : '';
        const labelledBy = (e.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        const alt = isInput && type === 'image' ? (e.getAttribute('alt') ?? '') : '';
        const value = isInput && /^(submit|button|reset)$/.test(type) ? input.value : '';
        const imgAlts = Array.from(e.querySelectorAll('img[alt]'))
          .map((i) => i.getAttribute('alt') ?? '')
          .join(' ');
        const text = `${e.textContent ?? ''} ${imgAlts}`;
        const labels = Array.from(input.labels ?? [])
          .map((l) => l.textContent ?? '')
          .join(' ');
        const sources = [
          e.getAttribute('aria-label') ?? '',
          labelledBy,
          alt,
          value,
          text,
          e.getAttribute('title') ?? '',
          labels,
        ].map((t) => t.replace(/\s+/g, ' ').trim());
        const tag = e.tagName;
        const role =
          e.getAttribute('role') ||
          (tag === 'BUTTON' || (isInput && /^(submit|button|reset|image)$/.test(type))
            ? 'button'
            : tag === 'A' && e.hasAttribute('href')
              ? 'link'
              : tag === 'OPTION'
                ? 'option'
                : tag === 'SELECT'
                  ? 'combobox'
                  : '');
        const form = e.closest('form');
        return {
          name: sources.find((t) => t !== '') ?? '',
          texts: sources.filter((t) => t !== ''),
          role,
          otpOnPage: document.querySelector('input[autocomplete="one-time-code" i]') !== null,
          passwordInForm: form?.querySelector('input[type="password" i]') != null,
        };
      },
      undefined,
      { timeout: READ_TIMEOUT_MS },
    )
    .catch(() => null);
}

/** True when the element is what the step expects: a name of the kind, or the role of a list. */
export function matchesClickKind(
  kind: ClickKind,
  facts: Pick<ClickFacts, 'name' | 'role'>,
  words: Words,
): boolean {
  const name = facts.name.normalize('NFC');
  switch (kind) {
    case 'continue':
      return isContinueName(name);
    case 'list':
      return facts.role === 'combobox';
    case 'list_option':
      return facts.role === 'option';
    case 'cart':
      return matchesKind('cart', name, words) && !matchesKind('add_to_cart', name, words);
    default:
      return matchesKind(kind, name, words);
  }
}

/** Returns the reason the click is not safe, or null when it is safe. */
export function clickRefusal(facts: ClickFacts, allow: ClickKind, words: Words): string | null {
  if (facts.name === '') return 'it has no name';
  for (const t of facts.texts) {
    if (matchesKind('pay', t, words)) return 'it can be a pay button';
    if (matchesKind('cookie_accept', t, words)) return 'it accepts cookies';
    if (SEND_CODE.test(t.normalize('NFC'))) return 'it can send or check a code';
  }
  if (!matchesClickKind(allow, facts, words)) return `its name does not match the step "${allow}"`;
  if (facts.otpOnPage) return 'the page asks for a one-time code';
  if (facts.passwordInForm) return 'it submits a password form';
  return null;
}

/**
 * Clicks one element after the safety rules pass. The element needs a name of the expected kind.
 * It never clicks a pay button or link, a cookie accept button, or a send-code button, never clicks
 * on a page with card fields, a blocked frame, or a one-time code field, and never submits a form
 * with a password field.
 */
export async function guardedClick(
  page: Page,
  loc: Locator,
  opts: {
    purpose: string;
    allow: ClickKind;
    words: Words;
    log: ActionLog;
    /** Frame loads that the host guard blocked on this page. */
    blockedFrames?: BlockedFrames;
  },
): Promise<ActionResult> {
  const facts = await clickFacts(loc);
  const name = clean(facts?.name);
  const action = `${opts.purpose}${name ? `: "${name}"` : ''}`;
  if (!facts) {
    opts.log(action, 'failed');
    return 'failed';
  }
  const refusal =
    clickRefusal(facts, opts.allow, opts.words) ??
    ((await hasCardFields(page)) ? 'the page has card fields' : null) ??
    ((await hasBlockedFrame(page, opts.blockedFrames ?? { urls: new Set() }))
      ? 'the page has a frame that the guard blocked'
      : null);
  if (refusal) {
    opts.log(`${action} (not clicked: ${refusal})`, 'refused');
    return 'refused';
  }
  try {
    await loc.click({ timeout: ACTION_TIMEOUT_MS });
  } catch {
    opts.log(action, 'failed');
    return 'failed';
  }
  opts.log(action, 'done');
  return 'done';
}

/** Presses a key on the page. Only Escape is allowed: it closes a list or a dialog and submits nothing. */
export async function guardedKey(
  page: Page,
  key: string,
  opts: { purpose: string; log: ActionLog },
): Promise<ActionResult> {
  const action = `${opts.purpose}: press ${clean(key)}`;
  if (key !== 'Escape') {
    opts.log(`${action} (not pressed: only Escape is allowed)`, 'refused');
    return 'refused';
  }
  try {
    await page.keyboard.press('Escape');
  } catch {
    opts.log(action, 'failed');
    return 'failed';
  }
  opts.log(action, 'done');
  return 'done';
}

export interface FieldFacts {
  type: string;
  autocomplete: string;
  texts: string[];
}

async function fieldFacts(loc: Locator): Promise<FieldFacts | null> {
  return loc
    .evaluate(
      (e) => {
        const input = e as HTMLInputElement;
        const labels = Array.from(input.labels ?? []).map((l) => l.textContent ?? '');
        return {
          type: e.tagName === 'INPUT' ? input.type.toLowerCase() : e.tagName.toLowerCase(),
          autocomplete: (e.getAttribute('autocomplete') ?? '').toLowerCase(),
          texts: [
            ...labels,
            e.getAttribute('aria-label') ?? '',
            e.getAttribute('name') ?? '',
            e.getAttribute('id') ?? '',
            e.getAttribute('placeholder') ?? '',
            e.getAttribute('autocomplete') ?? '',
          ].filter((t) => t.trim() !== ''),
        };
      },
      undefined,
      { timeout: READ_TIMEOUT_MS },
    )
    .catch(() => null);
}

/** Returns the reason the field must stay empty, or null when the probe can type in it. */
export function fieldRefusal(facts: FieldFacts): string | null {
  if (facts.type === 'password') return 'it is a password field';
  if (/^(hidden|file)$/.test(facts.type)) return 'it is not a text field';
  const ac = facts.autocomplete.split(/\s+/);
  if (ac.some((t) => t.startsWith('cc-'))) return 'it is a card field';
  if (facts.texts.some((t) => CARD_INPUT_HINT_RE.test(t.normalize('NFC')))) return 'it is a card field';
  if (ac.includes('one-time-code')) return 'it is a one-time code field';
  if (ac.some((t) => t.endsWith('-password'))) return 'it is a password field';
  // Names such as "user_password" join words with "_" or "-", which the word boundaries do not split.
  if (
    facts.texts.some((t) => STRONG_SECRET_WORDS.test(t) || STRONG_SECRET_WORDS.test(t.replace(/[_-]+/g, ' ')))
  )
    return 'its label names a secret';
  return null;
}

async function fieldGate(
  page: Page,
  loc: Locator,
  action: string,
  log: ActionLog,
): Promise<{ ok: true } | { ok: false; result: ActionResult }> {
  const facts = await fieldFacts(loc);
  if (!facts) {
    log(action, 'failed');
    return { ok: false, result: 'failed' };
  }
  const refusal = fieldRefusal(facts) ?? ((await hasCardFields(page)) ? 'the page has card fields' : null);
  if (refusal) {
    log(`${action} (not filled: ${refusal})`, 'refused');
    return { ok: false, result: 'refused' };
  }
  return { ok: true };
}

/**
 * Types a value into a field after the safety rules pass. It never types into a password, card,
 * or one-time code field, or into a field whose label names a secret.
 * The log gets the label only. The value never goes to the log.
 */
export async function guardedFill(
  page: Page,
  loc: Locator,
  value: string,
  opts: { purpose: string; log: ActionLog },
): Promise<ActionResult> {
  const gate = await fieldGate(page, loc, opts.purpose, opts.log);
  if (!gate.ok) return gate.result;
  try {
    await loc.fill(value, { timeout: ACTION_TIMEOUT_MS });
  } catch {
    opts.log(opts.purpose, 'failed');
    return 'failed';
  }
  opts.log(opts.purpose, 'done');
  return 'done';
}

/** Chooses one option of a native select by its index, after the same rules as guardedFill. */
export async function guardedSelect(
  page: Page,
  loc: Locator,
  index: number,
  opts: { purpose: string; log: ActionLog },
): Promise<ActionResult> {
  const gate = await fieldGate(page, loc, opts.purpose, opts.log);
  if (!gate.ok) return gate.result;
  try {
    await loc.selectOption({ index }, { timeout: ACTION_TIMEOUT_MS });
  } catch {
    opts.log(opts.purpose, 'failed');
    return 'failed';
  }
  opts.log(opts.purpose, 'done');
  return 'done';
}
