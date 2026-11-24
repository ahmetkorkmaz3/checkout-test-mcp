import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ToolError, toToolErrorResult } from '../errors/tool-error.js';
import {
  InspectionReport,
  InspectionScope,
  ReportSection,
  ReportSlice,
  sliceForResult,
  trimForResult,
} from '../inspect/report.js';
import { NextAction } from '../schemas/common.js';
import type { ServerDeps } from '../server.js';

export const InspectTargetInput = z.object({
  target: z
    .string()
    .min(1)
    .describe('Target name from list_scenarios.targets, for example "my-staging". Never a URL.'),
  idempotency_key: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{8,128}$/)
    .describe(
      '8 to 128 characters: letters, digits, ".", "_", ":", "-". Same key = same inspection, for example "setup-my-staging-01".',
    ),
  scope: InspectionScope.default('both').describe(
    '"site" reads the site only. "code" reads the source folders only. "both" (default) reads both.',
  ),
  wait_s: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(20)
    .describe('Seconds to wait for the inspection to finish before the call returns. 0 to 20.'),
  section: ReportSection.optional().describe(
    'Only to read a list that the result cut: "pages", "api_calls", "ui_strings", "test_ids", "routes", "otp_hints", or "probe_steps". Needs a key that already has an inspection. The result then holds only that list.',
  ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('With section: the first item to return. Start with 0, then send next_offset.'),
});

export const InspectTargetOutput = InspectionReport.extend({
  reused_existing_inspection: z
    .boolean()
    .describe('True when this idempotency_key already had an inspection. No new inspection started.'),
  slice: ReportSlice.nullable().describe(
    'null without section. With section: one page of that list. site, checkout_probe, and code are then null.',
  ),
  next: NextAction,
});

export const INSPECT_TARGET_DESCRIPTION = [
  'Inspects a configured test target and suggests checkout test scenarios with the evidence for each.',
  'It reads the site pages and API calls through the host guard, and it reads the shop source code when the target config has inspect.source_dirs.',
  'Only when the target config has inspect.probe_checkout: true, a checkout probe goes up to the payment step with fictional test data. It never pays and never sends a phone number for a code.',
  'Side effects of the probe on the test site: a cart item, a guest account with an example.test email, an address, and possibly an unpaid order draft. The report lists them in side_effects.',
  'The call starts a background job and waits up to wait_s seconds. While status is not "finished", call inspect_target again with the same target, idempotency_key, and scope. The same key never starts a second inspection, also after a restart.',
  'Read warnings and suggested_scenarios[].missing to know what to ask the user. Then write the baseline scenarios and save each with save_scenario.',
  'When a warning says that the result is cut, call inspect_target again with the same target, key, and scope, plus section and offset, to read the cut list in pages. section and offset only read: they never start an inspection.',
].join(' ');

export function registerInspectTarget(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'inspect_target',
    {
      title: 'Inspect a test target',
      description: INSPECT_TARGET_DESCRIPTION,
      inputSchema: InspectTargetInput,
      outputSchema: InspectTargetOutput,
      // The probe can make a cart, a guest account, and an address on the test site.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        if (args.section && !(await deps.inspections.hasKey(args.idempotency_key))) {
          throw new ToolError({
            code: 'INVALID_PARAMS',
            message: `section needs an idempotency_key that already has an inspection, but "${args.idempotency_key}" has none.`,
            likelyCause:
              'section reads a list of an inspection that exists. It does not start an inspection.',
            nextActions: [
              {
                kind: 'change_argument',
                description:
                  'Call inspect_target without section to start the inspection, then read the list.',
                tool: 'inspect_target',
                arguments: { target: args.target, idempotency_key: args.idempotency_key, scope: args.scope },
              },
            ],
          });
        }
        const { report, reused } = await deps.inspections.start({
          target: args.target,
          idempotency_key: args.idempotency_key,
          scope: args.scope,
        });
        const final = await deps.inspections.wait(report.inspection_id, args.wait_s);
        const next: NextAction =
          final.status !== 'finished'
            ? {
                kind: 'call_tool',
                description:
                  'The inspection is not finished. Call inspect_target again with the same arguments.',
                tool: 'inspect_target',
                arguments: {
                  target: args.target,
                  idempotency_key: args.idempotency_key,
                  scope: args.scope,
                  wait_s: 20,
                },
              }
            : final.suggested_scenarios.some((s) => s.baseline)
              ? {
                  kind: 'call_tool',
                  description:
                    'Write each baseline scenario in suggested_scenarios, then save it with save_scenario and validate_on on this target.',
                  tool: 'save_scenario',
                }
              : {
                  kind: 'ask_human',
                  description:
                    'No baseline scenario has all its evidence. Ask the user for the inputs in warnings and suggested_scenarios[].missing.',
                };
        let output: z.infer<typeof InspectTargetOutput>;
        if (args.section && final.status === 'finished') {
          const section = args.section;
          const sliceNext = (slice: ReportSlice): NextAction =>
            slice.next_offset === null
              ? next
              : {
                  kind: 'call_tool',
                  description: `Read the next items of "${section}".`,
                  tool: 'inspect_target',
                  arguments: {
                    target: args.target,
                    idempotency_key: args.idempotency_key,
                    scope: args.scope,
                    section,
                    offset: slice.next_offset,
                  },
                };
          const wrapSlice = (r: InspectionReport, slice: ReportSlice) => ({
            ...r,
            reused_existing_inspection: reused,
            slice,
            next: sliceNext(slice),
          });
          const cut = sliceForResult(final, section, args.offset, wrapSlice);
          output = wrapSlice(cut.report, cut.slice);
        } else {
          const wrap = (r: InspectionReport) => ({
            ...r,
            reused_existing_inspection: reused,
            slice: null,
            next,
          });
          output = wrap(trimForResult(final, wrap));
        }
        // Compact JSON: the text copy must fit the same 40000 character limit as the structured content.
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (err) {
        return toToolErrorResult(err);
      }
    },
  );
}
