import { z } from 'zod';
import { CardBehaviour, ExpectedOutcome } from './common.js';

const TextMatch = z.union([z.string(), z.object({ matches: z.string() }).strict()]);
export type TextMatch = z.infer<typeof TextMatch>;

const LOCATOR_KINDS = ['role', 'test_id', 'label', 'placeholder', 'text', 'css'] as const;

const LocatorFields = {
  role: z.string().optional(),
  name: TextMatch.optional(),
  level: z.number().int().min(1).max(6).optional(),
  exact: z.boolean().optional(),
  test_id: z.string().optional(),
  label: TextMatch.optional(),
  placeholder: z.string().optional(),
  text: TextMatch.optional(),
  css: z.string().optional(),
};

function exactlyOneKind(v: Record<string, unknown>): boolean {
  return LOCATOR_KINDS.filter((k) => v[k] !== undefined).length === 1;
}
const ONE_KIND_MSG = `A locator needs exactly one of: ${LOCATOR_KINDS.join(', ')}.`;

export const Locator = z.object(LocatorFields).strict().refine(exactlyOneKind, ONE_KIND_MSG);
export type Locator = z.infer<typeof Locator>;

export const Within = z.object({ frame: Locator }).strict();
export type Within = z.infer<typeof Within>;

/** A locator, or a locator inside an iframe. */
const Target = z.union([Locator, z.object({ within: Within, locator: Locator }).strict()]);
export type Target = z.infer<typeof Target>;

const StatusMatch = z.union([z.number().int().min(100).max(599), z.enum(['2xx', '3xx', '4xx', '5xx'])]);
export type StatusMatch = z.infer<typeof StatusMatch>;

const ResponseMatch = z
  .object({
    method: z.string().optional(),
    url: z.string().describe('URL glob. "*" matches inside one path segment, "**" matches across segments.'),
    status: StatusMatch.optional(),
  })
  .strict();
export type ResponseMatch = z.infer<typeof ResponseMatch>;

const TextExpectation = z
  .object({
    ...LocatorFields,
    within: Within.optional(),
    equals: z.string().optional(),
    contains: z.string().optional(),
    matches: z.string().optional(),
  })
  .strict()
  .refine(exactlyOneKind, ONE_KIND_MSG)
  .refine(
    (v) => [v.equals, v.contains, v.matches].filter((x) => x !== undefined).length === 1,
    'A text expectation needs exactly one of: equals, contains, matches.',
  );

const UrlExpectation = z
  .object({ matches: z.string().optional(), regex: z.string().optional(), equals: z.string().optional() })
  .strict()
  .refine(
    (v) => [v.matches, v.regex, v.equals].filter((x) => x !== undefined).length === 1,
    'A url expectation needs exactly one of: matches (glob), regex, equals.',
  );

const EXPECTATION_KINDS = ['visible', 'hidden', 'text', 'url', 'response', 'no_response'] as const;

const ExpectationFields = {
  visible: Target.optional(),
  hidden: Target.optional(),
  text: TextExpectation.optional(),
  url: UrlExpectation.optional(),
  response: ResponseMatch.optional(),
  no_response: ResponseMatch.optional(),
  timeout_ms: z.number().int().positive().optional(),
};

function exactlyOneExpectation(v: Record<string, unknown>): boolean {
  return EXPECTATION_KINDS.filter((k) => v[k] !== undefined).length === 1;
}
const ONE_EXPECTATION_MSG = `An expectation needs exactly one of: ${EXPECTATION_KINDS.join(', ')}.`;

export const Expectation = z
  .object(ExpectationFields)
  .strict()
  .refine(exactlyOneExpectation, ONE_EXPECTATION_MSG);
export type Expectation = z.infer<typeof Expectation>;

const FormField = z.union([
  z.object({ field: Locator, value: z.string() }).strict(),
  z.object({ field: Locator, select: z.string() }).strict(),
]);
export type FormField = z.infer<typeof FormField>;

const ACTION_KINDS = [
  'goto',
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'press',
  'fill_form',
  'wait_for',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

const ActionFields = {
  goto: z.string().optional(),
  click: Locator.optional(),
  fill: Locator.optional(),
  value: z.union([z.string(), z.number()]).optional(),
  select: Locator.optional(),
  option: z.string().optional(),
  check: Locator.optional(),
  uncheck: Locator.optional(),
  press: Locator.optional(),
  key: z.string().optional(),
  fill_form: z.array(FormField).min(1).optional(),
  wait_for: Expectation.optional(),
  within: Within.optional(),
};

function checkAction(v: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const kinds = ACTION_KINDS.filter((k) => v[k] !== undefined);
  if (kinds.length !== 1) {
    ctx.addIssue({ code: 'custom', message: `A step needs exactly one action: ${ACTION_KINDS.join(', ')}.` });
    return;
  }
  const kind = kinds[0];
  if (kind === 'fill' && v.value === undefined)
    ctx.addIssue({ code: 'custom', message: '"fill" needs "value".' });
  if (kind === 'select' && v.option === undefined)
    ctx.addIssue({ code: 'custom', message: '"select" needs "option".' });
  if (kind === 'press' && v.key === undefined)
    ctx.addIssue({ code: 'custom', message: '"press" needs "key".' });
}

export const Action = z.object(ActionFields).strict().superRefine(checkAction);
export type Action = z.infer<typeof Action>;

export const Step = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    title: z.string().min(1),
    ...ActionFields,
    // biome-ignore lint/suspicious/noThenProperty: "then" is a scenario YAML key. Step objects are never awaited.
    then: z.array(Action).optional(),
    expect: z.array(Expectation).optional(),
    timeout_ms: z.number().int().positive().optional(),
    on_failure: z.object({ hint: z.string() }).strict().optional(),
  })
  .strict()
  .superRefine(checkAction);
export type Step = z.infer<typeof Step>;

export const OutcomeCheck = z
  .object({ id: z.string().regex(/^[a-z][a-z0-9_]*$/), ...ExpectationFields })
  .strict()
  .refine(exactlyOneExpectation, ONE_EXPECTATION_MSG);
export type OutcomeCheck = z.infer<typeof OutcomeCheck>;

const ParamBase = {
  description: z.string().min(1),
  required: z.boolean().optional(),
};

export const ParamDef = z.discriminatedUnion('type', [
  z.object({ type: z.literal('string'), ...ParamBase, default: z.string().optional() }).strict(),
  z
    .object({
      type: z.literal('integer'),
      ...ParamBase,
      default: z.number().int().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('number'),
      ...ParamBase,
      default: z.number().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
    })
    .strict(),
  z.object({ type: z.literal('boolean'), ...ParamBase, default: z.boolean().optional() }).strict(),
  z
    .object({
      type: z.literal('enum'),
      ...ParamBase,
      values: z.array(z.string()).min(1),
      default: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('test_card'),
      ...ParamBase,
      default: z.string().optional(),
      constraints: z.object({ behaviour: CardBehaviour.optional() }).strict().optional(),
    })
    .strict(),
]);
export type ParamDef = z.infer<typeof ParamDef>;

export const Scenario = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    summary: z.string().min(1),
    tags: z.array(z.string()).default([]),
    compatible_profiles: z.array(z.string()).min(1),
    expected_outcome: ExpectedOutcome,
    params: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), ParamDef).default({}),
    data: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string()).default({}),
    timeouts: z
      .object({
        step_ms: z.number().int().positive().default(15_000),
        run_ms: z.number().int().positive().default(180_000),
      })
      .strict()
      .default({ step_ms: 15_000, run_ms: 180_000 }),
    ignore: z
      .object({
        console: z.array(z.object({ pattern: z.string() }).strict()).default([]),
        network: z.array(z.object({ url: z.string() }).strict()).default([]),
      })
      .strict()
      .default({ console: [], network: [] }),
    steps: z.array(Step).min(1),
    outcome: z.array(OutcomeCheck).default([]),
  })
  .strict()
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    for (const id of [...s.steps.map((x) => x.id), ...s.outcome.map((x) => x.id)]) {
      if (ids.has(id)) ctx.addIssue({ code: 'custom', message: `Duplicate step or outcome id "${id}".` });
      ids.add(id);
    }
    for (const [name, p] of Object.entries(s.params)) {
      if (p.default === undefined && !p.required) {
        ctx.addIssue({ code: 'custom', message: `Param "${name}" needs a default or required: true.` });
      }
    }
  });
export type Scenario = z.infer<typeof Scenario>;
