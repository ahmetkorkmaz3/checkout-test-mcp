import type { Locator, Page } from 'playwright';
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

/** True when any frame of the page has a card number or CVC field. */
export async function hasCardFields(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const n = await frame
      .locator('[autocomplete*="cc-number" i], [autocomplete*="cc-csc" i]')
      .count()
      .catch(() => 0);
    if (n > 0) return true;
  }
  return false;
}

export interface ClickFacts {
  texts: string[];
  otpOnPage: boolean;
  passwordInForm: boolean;
}

async function clickFacts(loc: Locator): Promise<ClickFacts | null> {
  return loc
    .evaluate(
      (e) => {
        const input = e as HTMLInputElement;
        const isButtonInput = e.tagName === 'INPUT' && /^(submit|button|reset|image)$/i.test(input.type);
        const labelledBy = (e.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        const labels = Array.from(input.labels ?? []).map((l) => l.textContent ?? '');
        const form = e.closest('form');
        return {
          texts: [
            e.textContent ?? '',
            e.getAttribute('aria-label') ?? '',
            e.getAttribute('title') ?? '',
            isButtonInput ? input.value : '',
            labelledBy,
            ...labels,
          ].filter((t) => t.trim() !== ''),
          otpOnPage: document.querySelector('input[autocomplete="one-time-code" i]') !== null,
          passwordInForm: form?.querySelector('input[type="password" i]') != null,
        };
      },
      undefined,
      { timeout: READ_TIMEOUT_MS },
    )
    .catch(() => null);
}

/** Returns the reason the click is not safe, or null when it is safe. */
export function clickRefusal(facts: ClickFacts, words: Words): string | null {
  for (const t of facts.texts) {
    if (matchesKind('pay', t, words)) return 'it can be a pay button';
    if (matchesKind('cookie_accept', t, words)) return 'it accepts cookies';
    if (SEND_CODE.test(t.normalize('NFC'))) return 'it can send or check a code';
  }
  if (facts.otpOnPage) return 'the page asks for a one-time code';
  if (facts.passwordInForm) return 'it submits a password form';
  return null;
}

/**
 * Clicks one element after the safety rules pass. It never clicks a pay button, a cookie accept
 * button, or a send-code button, never clicks on a page with card fields, never clicks on a page
 * with a one-time code field, and never submits a form with a password field.
 */
export async function guardedClick(
  page: Page,
  loc: Locator,
  opts: { purpose: string; words: Words; log: ActionLog },
): Promise<ActionResult> {
  const facts = await clickFacts(loc);
  const name = clean(facts?.texts[0]);
  const action = `${opts.purpose}${name ? `: "${name}"` : ''}`;
  if (!facts) {
    opts.log(action, 'failed');
    return 'failed';
  }
  const refusal =
    clickRefusal(facts, opts.words) ?? ((await hasCardFields(page)) ? 'the page has card fields' : null);
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
