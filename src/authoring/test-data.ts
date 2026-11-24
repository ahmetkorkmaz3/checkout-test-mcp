import { findCardLikeNumbers } from '../safety/cards.js';
import type { RuleIssue } from './rules.js';

const RESERVED_DOMAINS = ['example.test', 'example.com', 'example.org', 'example.net'];
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

export function isReservedEmailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (d.endsWith('.invalid') || d.endsWith('.test')) return true;
  return RESERVED_DOMAINS.some((r) => d === r || d.endsWith(`.${r}`));
}

/**
 * Checks the text of a test data file before the server writes it.
 * Messages never repeat the email or the number. They name the line only.
 */
export function checkTestData(text: string): RuleIssue[] {
  const issues: RuleIssue[] = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const path = `line ${idx + 1}`;
    for (const m of line.matchAll(EMAIL)) {
      if (isReservedEmailDomain(m[1] as string)) continue;
      issues.push({
        rule: 'test-data-email-domain',
        severity: 'error',
        path,
        message: `${path} has an email with a domain that is not reserved for tests.`,
        fix: 'Change the domain to example.test, example.com, example.org, example.net, or a domain that ends in .invalid or .test.',
      });
    }
    if (findCardLikeNumbers(line).length > 0) {
      issues.push({
        rule: 'test-data-card',
        severity: 'error',
        path,
        message: `${path} has a number that looks like a card number. Test data files must not hold card numbers.`,
        fix: 'Remove the number. Use a test_card param in the scenario. The server picks the card from its test card registry.',
      });
    }
  });
  return issues;
}
