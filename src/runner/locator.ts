import type { FrameLocator, Page, Locator as PwLocator } from 'playwright';
import type { Locator, Within } from '../schemas/scenario.js';
import { describeTextMatch, toTextMatcher } from './match.js';

export type Scope = Page | FrameLocator;

type AriaRole = Parameters<Page['getByRole']>[0];

export function toLocator(scope: Scope, spec: Locator): PwLocator {
  if (spec.role !== undefined) {
    return scope.getByRole(spec.role as AriaRole, {
      ...(spec.name !== undefined ? { name: toTextMatcher(spec.name) } : {}),
      ...(spec.level !== undefined ? { level: spec.level } : {}),
      ...(spec.exact !== undefined ? { exact: spec.exact } : {}),
    });
  }
  if (spec.test_id !== undefined) return scope.getByTestId(spec.test_id);
  if (spec.label !== undefined)
    return scope.getByLabel(toTextMatcher(spec.label), { exact: spec.exact ?? false });
  if (spec.placeholder !== undefined)
    return scope.getByPlaceholder(spec.placeholder, { exact: spec.exact ?? false });
  if (spec.text !== undefined)
    return scope.getByText(toTextMatcher(spec.text), { exact: spec.exact ?? false });
  if (spec.css !== undefined) return scope.locator(spec.css);
  throw new Error('Locator has no kind. The scenario schema must prevent this.');
}

export function scopeFor(page: Page, within: Within | undefined): Scope {
  return within ? toLocator(page, within.frame).contentFrame() : page;
}

export function describeLocator(spec: Locator, within?: Within): string {
  let d: string;
  if (spec.role !== undefined) {
    d = `role=${spec.role}`;
    if (spec.name !== undefined) d += ` name=${describeTextMatch(spec.name)}`;
    if (spec.level !== undefined) d += ` level=${spec.level}`;
  } else if (spec.test_id !== undefined) d = `test_id="${spec.test_id}"`;
  else if (spec.label !== undefined) d = `label=${describeTextMatch(spec.label)}`;
  else if (spec.placeholder !== undefined) d = `placeholder="${spec.placeholder}"`;
  else if (spec.text !== undefined) d = `text=${describeTextMatch(spec.text)}`;
  else d = `css="${spec.css}"`;
  return within ? `${d} inside frame ${describeLocator(within.frame)}` : d;
}
