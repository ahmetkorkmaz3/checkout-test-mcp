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

/** Finds digit runs of 13 to 19 digits (spaces and dashes allowed between digits) that pass Luhn. */
export function findCardLikeNumbers(text: string): string[] {
  const found: string[] = [];
  const candidates = text.match(/\d(?:[ -]?\d){12,18}/g) ?? [];
  for (const raw of candidates) {
    const digits = raw.replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) found.push(digits);
  }
  return found;
}

/** True when the text contains a card-like number that is not a registered test card. */
export function containsUnregisteredCardNumber(text: string): boolean {
  return findCardLikeNumbers(text).some((digits) => !isRegisteredTestCardNumber(digits));
}

/** True when the text contains any card-like number, registered or not. Used for tool arguments. */
export function containsCardNumber(text: string): boolean {
  return findCardLikeNumbers(text).length > 0;
}
