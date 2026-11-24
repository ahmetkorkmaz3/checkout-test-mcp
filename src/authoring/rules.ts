import { parseDocument } from 'yaml';
import type { Fragment, Scenario, Step } from '../schemas/scenario.js';
import { checkTestData } from './test-data.js';

export interface RuleIssue {
  rule: string;
  severity: 'error' | 'warning';
  /** Dotted YAML path, for example "steps.3.fill" or "params.email.default". Test data issues use "line N". */
  path: string;
  message: string;
  fix: string;
}

export { checkTestData };

const SCHEMA_LINE = /^#\s*yaml-language-server:\s*\$schema=/m;

/**
 * Adds the schema comment line and schema_version. Text edits keep comments and key order.
 * The yaml parser only decides whether the text is a map that lacks schema_version.
 */
export function applyFixes(
  text: string,
  _kind: 'scenario' | 'fragment',
  schemaPath: string,
): { text: string; fixes: string[] } {
  const fixes: string[] = [];
  let out = text;
  const doc = parseDocument(text);
  if (doc.errors.length === 0 && doc.contents !== null && doc.has('schema_version') === false) {
    const lines = out.split('\n');
    let at = lines.findIndex((l) => !/^\s*(#.*)?$/.test(l) && !/^---\s*$/.test(l));
    if (at === -1) at = lines.length;
    lines.splice(at, 0, 'schema_version: 1');
    out = lines.join('\n');
    fixes.push('Added "schema_version: 1".');
  }
  if (!SCHEMA_LINE.test(out)) {
    out = `# yaml-language-server: $schema=${schemaPath}\n${out}`;
    fixes.push(`Added the schema line "# yaml-language-server: $schema=${schemaPath}".`);
  }
  return { text: out, fixes };
}

type HouseInput =
  | { kind: 'scenario'; raw: Scenario; expanded: Scenario }
  | { kind: 'fragment'; raw: Fragment };

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Two underscores in a row are reserved: expansion joins include id and step id with "__".
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

const EMAIL_LIKE = /@.*\./;
const PHONE_LIKE = /^\+?[\d\s\-.()[\]]+$/;
const SECRET_WORDS = /password|şifre|sifre|parola/i;
// A small local list. The shared word list of the inspect module replaces it.
const PAY_WORDS =
  /(?<![\p{L}])(pay|place order|complete order|öde|güvenli öde|siparişi tamamla)(?![\p{L}])/iu;

const isLiteral = (v: string): boolean => v.trim() !== '' && !v.includes('{{');

function isPhoneLike(v: string): boolean {
  if (!PHONE_LIKE.test(v.trim())) return false;
  const n = v.replace(/\D/g, '').length;
  return n >= 10 && n <= 13;
}

function personalKind(v: string): 'email' | 'phone' | undefined {
  if (!isLiteral(v)) return undefined;
  if (EMAIL_LIKE.test(v)) return 'email';
  if (isPhoneLike(v)) return 'phone';
  return undefined;
}

const TEMPLATE_HINT =
  'Use a template instead: {{secrets.<name>}} for a secret, {{data.<name>.<field>}} for a test data file, or {{params.<name>}} for a param.';

function personalIssue(kind: 'email' | 'phone' | 'password', path: string, where: string): RuleIssue {
  return {
    rule: 'no-literal-personal-data',
    severity: 'error',
    path,
    message: `${where} holds a literal ${kind}. A scenario file must not hold personal data or passwords.`,
    fix:
      kind === 'password'
        ? `Replace the value with {{secrets.<name>}} and map the secret in the target config. ${TEMPLATE_HINT}`
        : `Replace the value with a template. ${TEMPLATE_HINT}`,
  };
}

function walk(value: unknown, path: string, visit: (key: string, v: unknown, path: string) => void): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walk(v, `${path}.${i}`, visit);
    });
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v, `${path}.${k}`);
      walk(v, `${path}.${k}`, visit);
    }
  }
}

type Rec = Record<string, unknown>;

function textOf(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (v && typeof v === 'object' && typeof (v as Rec).matches === 'string')
    return [(v as Rec).matches as string];
  return [];
}

/** Strings a locator uses to find its element. */
function locatorStrings(loc: unknown): string[] {
  if (!loc || typeof loc !== 'object') return [];
  const l = loc as Rec;
  return ['name', 'label', 'text', 'placeholder', 'test_id'].flatMap((k) => textOf(l[k]));
}

const LOCATOR_ACTIONS = ['click', 'fill', 'select', 'check', 'uncheck', 'press'] as const;

function actionLocatorStrings(action: Rec): string[] {
  return LOCATOR_ACTIONS.flatMap((k) => locatorStrings(action[k]));
}

function checkFillValues(action: Rec, path: string, issues: RuleIssue[]): void {
  if (action.fill !== undefined && (typeof action.value === 'string' || typeof action.value === 'number')) {
    const value = String(action.value);
    const kind = personalKind(value);
    const secret = isLiteral(value) && locatorStrings(action.fill).some((s) => SECRET_WORDS.test(s));
    if (kind) issues.push(personalIssue(kind, `${path}.fill`, `The "fill" action at ${path}`));
    else if (secret) issues.push(personalIssue('password', `${path}.fill`, `The "fill" action at ${path}`));
  }
  if (Array.isArray(action.fill_form)) {
    action.fill_form.forEach((f, i) => {
      const field = f as Rec;
      if (typeof field.value !== 'string') return;
      const p = `${path}.fill_form.${i}.value`;
      const kind = personalKind(field.value);
      const secret = isLiteral(field.value) && locatorStrings(field.field).some((s) => SECRET_WORDS.test(s));
      if (kind) issues.push(personalIssue(kind, p, `The "fill_form" value at ${p}`));
      else if (secret) issues.push(personalIssue('password', p, `The "fill_form" value at ${p}`));
    });
  }
}

function checkStepActions(step: Step, path: string, issues: RuleIssue[]): void {
  checkFillValues(step as Rec, path, issues);
  step.then?.forEach((a, i) => {
    checkFillValues(a as Rec, `${path}.then.${i}`, issues);
  });
}

function checkWith(step: Step, path: string, issues: RuleIssue[]): number {
  const before = issues.length;
  for (const [name, v] of Object.entries(step.with ?? {})) {
    const p = `${path}.with.${name}`;
    const value = String(v);
    const kind = personalKind(value);
    if (kind) issues.push(personalIssue(kind, p, `The "with" value at ${p}`));
    else if (isLiteral(value) && SECRET_WORDS.test(name)) {
      issues.push(personalIssue('password', p, `The "with" value at ${p}`));
    }
  }
  return issues.length - before;
}

function checkStepIds(steps: Step[], issues: RuleIssue[]): void {
  steps.forEach((s, i) => {
    if (SNAKE.test(s.id)) return;
    issues.push({
      rule: 'id-format',
      severity: 'error',
      path: `steps.${i}.id`,
      message: `Step id "${s.id}" is not snake_case. Use lowercase words with single underscores. Two underscores in a row are reserved.`,
      fix: `Rename the step id, for example "${
        s.id
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^[^a-z]+|_+$/g, '') || 'step'
      }".`,
    });
  });
}

function checkLocatorsAndUrls(root: unknown, path: string, issues: RuleIssue[]): void {
  walk(root, path, (key, v, p) => {
    if (key === 'css' && typeof v === 'string') {
      issues.push({
        rule: 'prefer-semantic-locator',
        severity: 'warning',
        path: p,
        message: `A CSS locator at ${p} breaks when the page markup changes.`,
        fix: 'Use a role, test_id, label, placeholder, or text locator. Keep css only when no semantic locator works.',
      });
    }
    if (key === 'url' && v && typeof v === 'object') {
      const glob = (v as Rec).matches;
      if (typeof glob === 'string' && glob.endsWith('**')) {
        issues.push({
          rule: 'url-glob-query',
          severity: 'warning',
          path: `${p}.matches`,
          message: `The glob "${glob}" ends with "**". It also matches a query string. For a path such as /sepet, the URL of another page with "?return=/sepet" matches too.`,
          fix: 'Use "regex" with "^https?://[^/]+/path/?(\\?.*)?$". Replace "path" with the page path.',
        });
      }
    }
  });
}

function checkPayHint(step: Step, path: string, issues: RuleIssue[]): void {
  // An include step cannot have on_failure. The expanded fragment steps carry their own hints.
  if (step.include !== undefined || step.on_failure?.hint) return;
  const strings = [
    step.title,
    ...actionLocatorStrings(step as Rec),
    ...(step.then ?? []).flatMap((a) => actionLocatorStrings(a as Rec)),
  ];
  if (!strings.some((s) => PAY_WORDS.test(s))) return;
  issues.push({
    rule: 'payment-step-hint',
    severity: 'warning',
    path,
    message: `Step "${step.id}" looks like a payment step but has no on_failure.hint. A failed payment step is hard to diagnose without one.`,
    fix: 'Add "on_failure: { hint: ... }" that says what usually breaks here, for example a missing 3D Secure frame or a declined card.',
  });
}

function checkOutcome(s: Scenario, issues: RuleIssue[]): void {
  const counted = s.outcome.filter((c) => c.when === undefined);
  const has = (...kinds: string[]) => counted.some((c) => kinds.some((k) => (c as Rec)[k] !== undefined));
  if (s.expected_outcome === 'order_placed') {
    if (!has('response', 'url')) {
      issues.push({
        rule: 'outcome-proves-order',
        severity: 'error',
        path: 'outcome',
        message:
          'expected_outcome is order_placed, but no outcome check of kind "response" or "url" counts. A check with "when" does not count.',
        fix: 'Add an outcome check without "when" that waits for the order response ("response") or the confirmation page URL ("url").',
      });
    }
    if (!has('visible', 'text')) {
      issues.push({
        rule: 'outcome-proves-order',
        severity: 'error',
        path: 'outcome',
        message:
          'expected_outcome is order_placed, but no outcome check of kind "visible" or "text" counts. A check with "when" does not count.',
        fix: 'Add an outcome check without "when" that shows the confirmation on the page ("visible" or "text").',
      });
    }
  }
  if (
    (s.expected_outcome === 'payment_declined' || s.expected_outcome === 'validation_error') &&
    !has('hidden', 'no_response')
  ) {
    issues.push({
      rule: 'outcome-proves-no-success',
      severity: 'error',
      path: 'outcome',
      message: `expected_outcome is ${s.expected_outcome}, but no outcome check proves that the order did not succeed. A check with "when" does not count.`,
      fix: 'Add an outcome check without "when" of kind "hidden" (the confirmation element is absent) or "no_response" (no order response arrives).',
    });
  }
}

function checkParams(s: Scenario, issues: RuleIssue[]): void {
  for (const [name, p] of Object.entries(s.params)) {
    const base = `params.${name}`;
    if (!p.description || p.description.trim() === '') {
      issues.push({
        rule: 'param-described',
        severity: 'error',
        path: `${base}.description`,
        message: `Param "${name}" has no description. The agent that runs the scenario reads it to fill the param.`,
        fix: 'Add a "description" that says what the value means and which values are valid.',
      });
    }
    if (p.default === undefined && !p.required) {
      issues.push({
        rule: 'param-described',
        severity: 'error',
        path: `${base}.default`,
        message: `Param "${name}" has no default and is not required.`,
        fix: 'Add a "default", or set "required: true".',
      });
    }
    if (typeof p.default === 'string') {
      const kind = personalKind(p.default);
      if (kind) issues.push(personalIssue(kind, `${base}.default`, `The default of param "${name}"`));
      else if (isLiteral(p.default) && (SECRET_WORDS.test(name) || SECRET_WORDS.test(p.description ?? ''))) {
        issues.push(personalIssue('password', `${base}.default`, `The default of param "${name}"`));
      }
    }
  }
}

function checkFragmentArgs(f: Fragment, issues: RuleIssue[]): void {
  for (const [name, a] of Object.entries(f.args)) {
    if (!a.description || a.description.trim() === '') {
      issues.push({
        rule: 'param-described',
        severity: 'error',
        path: `args.${name}.description`,
        message: `Fragment arg "${name}" has no description.`,
        fix: 'Add a "description" that says what the value means.',
      });
    }
  }
}

function checkIdFormat(id: string, issues: RuleIssue[]): void {
  if (KEBAB.test(id)) return;
  issues.push({
    rule: 'id-format',
    severity: 'error',
    path: 'id',
    message: `Id "${id}" is not kebab-case. Use lowercase words with single dashes.`,
    fix: `Rename the id, for example "${
      id
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'my-scenario'
    }".`,
  });
}

/** Runs the house rules. The caller refuses a save on any issue with severity "error". */
export function checkHouseRules(input: HouseInput): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const { raw } = input;
  checkIdFormat(raw.id, issues);
  checkStepIds(raw.steps, issues);
  const withIssueIdx = new Set<number>();
  raw.steps.forEach((step, i) => {
    const path = `steps.${i}`;
    if (checkWith(step, path, issues) > 0) withIssueIdx.add(i);
    checkStepActions(step, path, issues);
    checkLocatorsAndUrls(step, path, issues);
    checkPayHint(step, path, issues);
  });
  if (input.kind === 'fragment') {
    checkFragmentArgs(input.raw, issues);
    return issues;
  }
  checkParams(input.raw, issues);
  checkOutcome(input.raw, issues);
  checkLocatorsAndUrls(input.raw.outcome, 'outcome', issues);
  checkExpandedFragmentSteps(input.raw, input.expanded, withIssueIdx, issues);
  return issues;
}

/**
 * Steps from fragments exist only in the expanded scenario. Their issues point at the include step
 * of the scenario file, because the agent edits that file or the fragment file.
 */
function checkExpandedFragmentSteps(
  raw: Scenario,
  expanded: Scenario,
  withIssueIdx: Set<number>,
  issues: RuleIssue[],
): void {
  const seen = new Set<string>();
  for (const step of expanded.steps) {
    const sep = step.id.indexOf('__');
    if (sep === -1) continue;
    const includeIdx = raw.steps.findIndex((s) => s.id === step.id.slice(0, sep));
    if (includeIdx === -1) continue;
    const path = `steps.${includeIdx}.include`;
    const local: RuleIssue[] = [];
    if (!withIssueIdx.has(includeIdx)) checkStepActions(step, path, local);
    checkLocatorsAndUrls(step, path, local);
    checkPayHint(step, path, local);
    for (const issue of local) {
      const key = `${issue.rule}|${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        ...issue,
        path,
        message: `Fragment step "${step.id}" (fragment of include step "${step.id.slice(0, sep)}"): ${issue.message}`,
      });
    }
  }
}
