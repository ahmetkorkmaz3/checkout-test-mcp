import { isRegisteredTestCardNumber } from './test-cards.js';

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A run of digits. Single spaces or dashes may sit between digits. */
export const CARD_CANDIDATE = /\d(?:[ -]?\d)*/g;

export interface DigitRun {
  digits: string;
  /** Index in the source text of each digit. */
  pos: number[];
  /** True when the digit at this index starts a digit group. */
  groupStart: boolean[];
}

export function splitDigitRun(run: string, base = 0): DigitRun {
  const digits: string[] = [];
  const pos: number[] = [];
  const groupStart: boolean[] = [];
  for (let i = 0; i < run.length; i++) {
    const ch = run[i] as string;
    if (ch < '0' || ch > '9') continue;
    digits.push(ch);
    pos.push(base + i);
    groupStart.push(i === 0 || !((run[i - 1] as string) >= '0' && (run[i - 1] as string) <= '9'));
  }
  return { digits: digits.join(''), pos, groupStart };
}

export interface CardSpan {
  start: number;
  end: number;
  digits: string;
}

// Length 16 first: it is the most common card length, so it wins over a window that eats a neighbour digit.
const LENGTH_ORDER = [16, 15, 19, 18, 17, 14, 13];

export interface CardSearchOptions {
  /**
   * Also try offset windows inside unbroken digit runs longer than 19 digits.
   * Use it for text that only gets redacted. Do not use it for guards: it flags ordinary long ids.
   */
  longRuns?: boolean;
  /**
   * Drop spans that overlap an earlier one. A redactor needs this to cut the text safely.
   * A guard must not use it: a dropped span could be the one that is not a registered test card.
   */
  dedupe?: boolean;
}

// The pre-window rule: the first 13 to 19 digits of a run. Kept so the guards never catch less than before.
const WHOLE_CANDIDATE = /\d(?:[ -]?\d){12,18}/g;

/**
 * Finds Luhn-valid 13 to 19 digit card numbers in text. Digits next to a card cannot hide it.
 * It tries windows on group boundaries (card shapes first, then any shape), then the old whole-candidate rule,
 * then offset windows inside one unbroken digit run.
 */
export function findCardSpans(text: string, opts: CardSearchOptions = {}): CardSpan[] {
  const spans: CardSpan[] = [];
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    const run = splitDigitRun(m[0], m.index);
    const n = run.digits.length;
    const starts = run.groupStart.flatMap((g, idx) => (g ? [idx] : []));
    const offsetOk = starts.length === 1 && (n <= 19 || opts.longRuns === true);
    let i = 0;
    while (n - i >= 13) {
      let found: [number, number] | undefined;
      for (const pass of ['shaped', 'aligned', 'offset'] as const) {
        if (pass === 'offset' && !offsetOk) continue;
        for (const len of LENGTH_ORDER) {
          for (let s = i; s + len <= n && !found; s++) {
            const aligned = run.groupStart[s] === true && (s + len === n || run.groupStart[s + len] === true);
            if (pass !== 'offset' && !aligned) continue;
            if (pass === 'shaped' && !hasCardShape(starts, s, s + len, n)) continue;
            if (luhnValid(run.digits.slice(s, s + len))) found = [s, len];
          }
          if (found) break;
        }
        if (found) break;
      }
      if (!found) break;
      const [s, len] = found;
      spans.push({
        start: run.pos[s] as number,
        end: (run.pos[s + len - 1] as number) + 1,
        digits: run.digits.slice(s, s + len),
      });
      i = s + len;
    }
  }
  for (const m of text.matchAll(WHOLE_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (luhnValid(digits)) spans.push({ start: m.index, end: m.index + m[0].length, digits });
  }
  spans.sort((x, y) => x.start - y.start || y.end - x.end);
  if (!opts.dedupe) return spans;
  const kept: CardSpan[] = [];
  for (const span of spans) {
    const last = kept[kept.length - 1];
    if (!last || span.start >= last.end) kept.push(span);
  }
  return kept;
}

/** Card numbers print as one group, 4-4-4-4 (last group 1 to 4 digits), or 4-6-5 (Amex). */
function hasCardShape(starts: number[], from: number, to: number, n: number): boolean {
  const sizes: number[] = [];
  for (let k = 0; k < starts.length; k++) {
    const st = starts[k] as number;
    if (st < from || st >= to) continue;
    sizes.push(((starts[k + 1] as number | undefined) ?? n) - st);
  }
  if (sizes.length === 1) return true;
  if (sizes.length === 3 && sizes[0] === 4 && sizes[1] === 6 && sizes[2] === 5) return true;
  const last = sizes[sizes.length - 1] as number;
  return sizes.slice(0, -1).every((x) => x === 4) && last >= 1 && last <= 4;
}

/** Finds Luhn-valid 13 to 19 digit card numbers, also when other digits sit next to them. */
export function findCardLikeNumbers(text: string): string[] {
  return [...new Set(findCardSpans(text).map((span) => span.digits))];
}

/**
 * True when the text contains a card-like number that is not a registered test card.
 * Numbers in "allowed" also pass. A run puts the live card numbers of its production target there.
 */
export function containsUnregisteredCardNumber(
  text: string,
  allowed: ReadonlySet<string> = new Set(),
): boolean {
  return findCardLikeNumbers(text).some(
    (digits) => !isRegisteredTestCardNumber(digits) && !allowed.has(digits),
  );
}

/** True when the text contains any card-like number, registered or not. Used for tool arguments. */
export function containsCardNumber(text: string): boolean {
  return findCardLikeNumbers(text).length > 0;
}
