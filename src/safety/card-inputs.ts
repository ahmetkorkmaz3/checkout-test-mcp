import type { Frame, Locator, Page } from 'playwright';

/**
 * The one rule that decides whether an input is a card input. The probe, the crawl, the guarded
 * actions, and the run screenshot mask all use it, so they cannot disagree about a card field.
 * A shop can leave out autocomplete, so names, ids, placeholders, and labels count too.
 */

/** Lowercase parts of a name, id, placeholder, or label of a card input. They match anywhere in the text. */
export const CARD_INPUT_HINTS: readonly string[] = [
  'cardnumber',
  'card-number',
  'card_number',
  'card number',
  'ccnumber',
  'cc-number',
  'cc_number',
  'cvc',
  'cvv',
  'expir',
  'kart numaras',
  'kartnumaras',
  'kart_numaras',
  'son kullanma',
  'güvenlik kodu',
  'security code',
  'kartennummer',
  'numéro de carte',
  'número de tarjeta',
  'numero di carta',
  'kaartnummer',
];

const HINT_ATTRIBUTES = ['name', 'id', 'placeholder', 'aria-label'] as const;

const cssString = (s: string): string => `"${s.replace(/["\\]/g, '\\$&')}"`;

/** A CSS selector for card inputs by autocomplete and by attribute hints. Labels need cardInputs(). */
export const CARD_INPUT_CSS = [
  'input[autocomplete^="cc-" i]',
  'input[autocomplete*=" cc-" i]',
  ...HINT_ATTRIBUTES.flatMap((attr) => CARD_INPUT_HINTS.map((h) => `input[${attr}*=${cssString(h)} i]`)),
].join(', ');

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The hints as one case-insensitive pattern. It matches a part of a word, like the CSS selector. */
export const CARD_INPUT_HINT_RE = new RegExp(CARD_INPUT_HINTS.map(escapeRe).join('|'), 'iu');

export interface CardInputFacts {
  autocomplete: string;
  name: string;
  id: string;
  placeholder: string;
  label: string;
}

/** True when the input is a card number, expiry, or security code input, or has a cc-* autocomplete. */
export function isCardInput(f: CardInputFacts): boolean {
  if (
    f.autocomplete
      .toLowerCase()
      .split(/\s+/)
      .some((t) => t.startsWith('cc-'))
  )
    return true;
  return [f.name, f.id, f.placeholder, f.label].some((t) => CARD_INPUT_HINT_RE.test(t.normalize('NFC')));
}

/** All card inputs in one frame: the CSS rule plus inputs whose label has a card hint. */
export function cardInputs(scope: Frame | Page): Locator {
  return scope.locator(CARD_INPUT_CSS).or(scope.getByLabel(CARD_INPUT_HINT_RE).and(scope.locator('input')));
}
