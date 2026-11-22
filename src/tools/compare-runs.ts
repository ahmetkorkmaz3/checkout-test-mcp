import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { compareRuns } from '../compare/compare.js';
import { toToolErrorResult } from '../errors/tool-error.js';
import { RunId, Verdict } from '../schemas/common.js';
import type { ServerDeps } from '../server.js';
import { jsonResult } from './result.js';

export const CompareRunsInput = z.object({
  baseline_run_id: RunId,
  candidate_run_id: RunId,
  slowdown_threshold_pct: z
    .number()
    .int()
    .min(10)
    .max(1000)
    .default(50)
    .describe(
      'Report a step as slower when its duration grows by more than this percent and by more than 1000 ms.',
    ),
});

const RunRef = z.object({ run_id: RunId, target: z.string(), verdict: Verdict, finished_at: z.string() });

export const CompareRunsOutput = z.object({
  verdict: z.enum(['regression', 'fixed', 'no_change', 'both_failing', 'inconclusive']),
  summary: z.string(),
  scenario_id: z.string(),
  baseline: RunRef,
  candidate: RunRef,
  regressions: z.array(
    z.object({
      kind: z.enum(['step_failed', 'outcome_failed', 'new_console_error', 'new_network_failure', 'slower']),
      step_id: z.string(),
      description: z.string(),
      baseline_value: z.string().optional(),
      candidate_value: z.string().optional(),
    }),
  ),
  fixes: z.array(z.object({ kind: z.string(), step_id: z.string(), description: z.string() })),
  step_changes: z.array(
    z.object({
      step_id: z.string(),
      baseline_status: z.string(),
      candidate_status: z.string(),
      baseline_ms: z.number().int().nullable(),
      candidate_ms: z.number().int().nullable(),
    }),
  ),
  warnings: z.array(z.string()).describe('For example: params differ, scenario file changed between runs.'),
});

export const COMPARE_RUNS_DESCRIPTION = [
  'Compares two finished runs of the same scenario, for example before and after a deploy, and reports regressions.',
  'baseline_run_id is the known-good or earlier run. candidate_run_id is the new run.',
  'A regression is a step or outcome check that passed in the baseline and failed in the candidate, a new console error, a new network failure, or a step that became much slower.',
  'Both runs must have status "finished". The runs can use different targets, for example staging and a preview environment.',
].join(' ');

export function registerCompareRuns(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'compare_runs',
    {
      title: 'Compare two checkout test runs',
      description: COMPARE_RUNS_DESCRIPTION,
      inputSchema: CompareRunsInput,
      outputSchema: CompareRunsOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const baseline = deps.manager.get(args.baseline_run_id);
        const candidate = deps.manager.get(args.candidate_run_id);
        const result = compareRuns(baseline, candidate, args.slowdown_threshold_pct);
        return jsonResult(result, [], result.summary);
      } catch (err) {
        return toToolErrorResult(err);
      }
    },
  );
}
