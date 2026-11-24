import { z } from 'zod';
import { ExpectedOutcome } from '../schemas/common.js';

export const INSPECTION_ID_PATTERN = /^insp_[A-Za-z0-9_-]{16}$/;
/** The tool result stays under this many characters of JSON. The file on disk has the rest. */
export const RESULT_CHAR_LIMIT = 40_000;

export const InspectionId = z
  .string()
  .regex(INSPECTION_ID_PATTERN)
  .describe('Inspection id, for example "insp_Q2x8LmN4pR7sTv0a".');

const PageKind = z.enum(['home', 'listing', 'product', 'cart', 'login', 'checkout', 'result', 'other']);

export const PageSnapshotSchema = z.object({
  path_pattern: z.string().describe('URL path with ids and slugs as "*". No query.'),
  url_path: z.string(),
  kind: PageKind,
  kind_reasons: z.array(z.string()),
  title: z.string(),
  headings: z.array(z.string()),
  landmarks: z.array(z.string()),
  elements: z.array(
    z.object({
      role: z.string(),
      name: z.string(),
      label: z.string().optional(),
      test_id: z.string().optional(),
      visible: z.boolean(),
    }),
  ),
  forms: z.array(
    z.object({
      fields: z.array(
        z.object({
          label: z.string(),
          type: z.string(),
          autocomplete: z.string().optional(),
          required: z.boolean(),
        }),
      ),
    }),
  ),
  selects: z.array(z.object({ label: z.string(), options: z.array(z.string()) })),
  iframes: z.array(z.object({ host: z.string(), title: z.string().optional() })),
  dialogs: z.array(z.string()),
});

export const SiteReportSchema = z.object({
  pages: z.array(PageSnapshotSchema),
  api_calls: z.array(
    z.object({
      method: z.string(),
      path_pattern: z.string(),
      status: z.number(),
      content_type: z.string(),
      page_kind: PageKind,
    }),
  ),
  blocked_hosts: z
    .array(z.object({ host: z.string(), count: z.number().int() }))
    .describe('Hosts that the guard blocked. Ask the user before you add one to third_party_hosts.'),
});

export const ProbeResultSchema = z.object({
  reached: z.enum(['none', 'product', 'cart', 'checkout', 'payment']),
  stopped_reason: z.enum([
    'payment_step_reached',
    'login_required',
    'no_product',
    'no_add_to_cart',
    'no_checkout_button',
    'form_not_understood',
    'timeout',
    'blocked_by_safety',
    'verification_required',
  ]),
  steps: z.array(
    z.object({
      action: z.string(),
      page_kind: PageKind,
      url_path: z.string(),
      result: z.enum(['done', 'skipped']),
    }),
  ),
  dialogs: z.array(z.string()).describe('Dialogs that opened during the probe, by name or first line.'),
  guest_option: z.boolean(),
  payment: z
    .object({
      methods: z.array(z.string()),
      card_form: z.boolean(),
      card_iframe_hosts: z.array(z.string()),
      test_card_select: z.object({ label: z.string(), options: z.array(z.string()) }).nullable(),
      agreement_checkbox: z.string().nullable(),
      pay_button: z.string().nullable(),
    })
    .nullable(),
  side_effects: z.array(z.string()),
});

const Evidence = z.object({ name: z.string(), reason: z.string(), file: z.string() });

export const CodeReportSchema = z.object({
  frameworks: z.array(Evidence),
  routes: z.array(z.object({ path: z.string(), file: z.string() })),
  ui_strings: z.array(z.object({ key: z.string(), text: z.string(), file: z.string(), line: z.number() })),
  test_ids: z.array(z.object({ value: z.string(), file: z.string(), line: z.number() })),
  payment_hints: z.array(
    z.object({ provider: z.string().nullable(), package: z.string(), file: z.string() }),
  ),
  otp_hints: z.array(z.object({ text: z.string(), file: z.string(), line: z.number() })),
  stats: z.object({ files: z.number(), skipped: z.number(), truncated: z.boolean() }),
  warnings: z.array(z.string()),
});

export const SuggestionSchema = z.object({
  id: z.string().describe('Scenario id to use, for example "my-staging-guest-card".'),
  title: z.string(),
  expected_outcome: ExpectedOutcome,
  baseline: z
    .boolean()
    .describe('True: write and run this scenario in the first setup with no question to the user.'),
  why: z.string(),
  evidence: z.array(z.string()).describe('Report paths that this suggestion rests on.'),
  missing: z.array(z.string()).describe('Inputs that are missing. Ask the user for them.'),
  card_source: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('site_select'), option: z.string() }),
      z.object({ kind: z.literal('registry'), card_id: z.string() }),
    ])
    .nullable()
    .describe(
      'site_select: select this option text in the site test card select. registry: use this test card id in a test_card param.',
    ),
});

export const InspectionStatus = z.enum(['queued', 'running', 'finished']);

export const InspectionReport = z.object({
  inspection_id: InspectionId,
  target: z.string(),
  status: InspectionStatus,
  interrupted: z
    .boolean()
    .describe('True when the server stopped during the inspection. It was not repeated.'),
  progress: z.string(),
  site: SiteReportSchema.nullable().describe('null when scope is "code" or the crawl did not run.'),
  checkout_probe: ProbeResultSchema.nullable().describe(
    'null when the config does not allow the probe, or scope is "code".',
  ),
  code: CodeReportSchema.nullable().describe('null without source_dirs, or when scope is "site".'),
  suggested_scenarios: z.array(SuggestionSchema),
  warnings: z.array(z.string()),
  side_effects: z.array(z.string()).describe('What the inspection made on the test site.'),
  report_path: z.string().describe('The full report on disk. The tool result can be shorter.'),
});
export type InspectionReport = z.infer<typeof InspectionReport>;

export const InspectionScope = z.enum(['site', 'code', 'both']);
export type InspectionScope = z.infer<typeof InspectionScope>;

/** The file on disk: the report plus the fields that make a key give the same inspection. */
export const InspectionRecord = InspectionReport.extend({
  idempotency_key: z.string(),
  request_hash: z.string(),
  scope: InspectionScope,
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type InspectionRecord = z.infer<typeof InspectionRecord>;

const size = (r: InspectionReport): number => JSON.stringify(r).length;

/**
 * Keeps the report JSON under RESULT_CHAR_LIMIT characters for the tool result.
 * It cuts the largest and least needed lists first: page elements, then UI strings,
 * then API calls. Only if that is not enough, it cuts test ids, routes, OTP hints, and pages.
 */
export function trimForResult(report: InspectionReport): InspectionReport {
  if (size(report) <= RESULT_CHAR_LIMIT) return report;
  const r = structuredClone(report);
  const cut: string[] = [];
  const steps: [string, () => boolean][] = [
    [
      'site.pages[].elements',
      () => {
        if (!r.site?.pages.some((p) => p.elements.length > 0)) return false;
        for (const p of r.site.pages) p.elements = [];
        return true;
      },
    ],
    [
      'code.ui_strings',
      () => {
        if (!r.code?.ui_strings.length) return false;
        r.code.ui_strings = [];
        return true;
      },
    ],
    [
      'site.api_calls',
      () => {
        if (!r.site?.api_calls.length) return false;
        r.site.api_calls = [];
        return true;
      },
    ],
    [
      'code.test_ids',
      () => {
        if (!r.code?.test_ids.length) return false;
        r.code.test_ids = [];
        return true;
      },
    ],
    [
      'code.routes',
      () => {
        if (!r.code?.routes.length) return false;
        r.code.routes = [];
        return true;
      },
    ],
    [
      'code.otp_hints',
      () => {
        if (!r.code?.otp_hints.length) return false;
        r.code.otp_hints = [];
        return true;
      },
    ],
  ];
  // The warning goes in first, so its length counts in each size check.
  r.warnings.push('');
  const warn = () => {
    r.warnings[r.warnings.length - 1] =
      `The tool result is shorter than the report. Cut: ${cut.join(', ')}. Read the full report in ${r.report_path}.`;
  };
  for (const [name, apply] of steps) {
    if (size(r) <= RESULT_CHAR_LIMIT) break;
    if (apply()) cut.push(name);
    warn();
  }
  if (r.site && size(r) > RESULT_CHAR_LIMIT) {
    const total = r.site.pages.length;
    while (r.site.pages.length > 0 && size(r) > RESULT_CHAR_LIMIT) r.site.pages.pop();
    cut.push(`site.pages after the first ${r.site.pages.length} of ${total}`);
    warn();
  }
  return r;
}
