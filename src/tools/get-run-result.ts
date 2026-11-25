import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type ToolResultShape, toToolErrorResult } from '../errors/tool-error.js';
import { RunId, RunStatus, Verdict } from '../schemas/common.js';
import {
  Artifacts,
  BlockedRequest,
  BrowserInfo,
  ConsoleError,
  Failure,
  NetworkFailure,
  OutcomeCheckResult,
  type RunRecord,
  StepResult,
} from '../schemas/run.js';
import type { ServerDeps } from '../server.js';
import { jsonResult } from './result.js';

export const GetRunResultInput = z.object({
  run_id: RunId,
  wait_s: z
    .number()
    .int()
    .min(0)
    .max(20)
    .default(0)
    .describe('Seconds to wait for completion or progress. 0 returns at once.'),
  detail: z.enum(['summary', 'full']).default('summary'),
});

export const GetRunResultOutput = z.object({
  run_id: RunId,
  status: RunStatus,
  verdict: Verdict.nullable().describe('null until status is "finished".'),
  summary: z.string().describe('Two to four sentences: what ran, what happened, what to do.'),
  scenario_id: z.string(),
  target: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  progress: z.object({
    completed_steps: z.number().int(),
    total_steps: z.number().int(),
    current_step_id: z.string().nullable(),
  }),
  failure: Failure.nullable(),
  outcome_checks: z.array(OutcomeCheckResult),
  steps: z.array(StepResult).describe('summary: only failed and flaky steps. full: all steps.'),
  console_errors: z.array(ConsoleError).describe('summary: only relevant items, max 10.'),
  network_failures: z
    .array(NetworkFailure)
    .describe('HTTP >= 400, aborted, and failed requests. summary: only relevant items, max 10.'),
  blocked_requests: z
    .array(BlockedRequest)
    .describe('Requests the host guard stopped. Often a missing third_party_hosts entry.'),
  artifacts: Artifacts,
  browser: BrowserInfo.nullable().describe('The browser of the run. null until the browser starts.'),
});
type Output = z.infer<typeof GetRunResultOutput>;

export const GET_RUN_RESULT_DESCRIPTION = [
  'Returns the status of a run started with run_scenario, and the verdict when it is finished.',
  'Set wait_s (max 20) to wait for the run to finish or make progress before the call returns. While status is "queued" or "running", call again with wait_s 20.',
  'verdict "failed" means the site did not behave as the scenario expects: read failure.category, failure.likely_causes, and failure.next_actions.',
  'verdict "error" or "blocked" means the run could not test the site: read failure.next_actions before you retry.',
  'detail "summary" (default) returns the failing step, relevant console errors, and relevant network failures. Use detail "full" only when you need every step, console line, and request.',
].join(' ');

const SUMMARY_LIMIT = 10;

export function toRunView(r: RunRecord, detail: 'summary' | 'full'): Output {
  const full = detail === 'full';
  return {
    run_id: r.run_id,
    status: r.status,
    verdict: r.verdict,
    summary: r.summary,
    scenario_id: r.scenario_id,
    target: r.target,
    started_at: r.started_at,
    finished_at: r.finished_at,
    duration_ms: r.duration_ms,
    progress: r.progress,
    failure: r.failure,
    outcome_checks: r.outcome_checks,
    steps: full ? r.steps : r.steps.filter((s) => s.status === 'failed' || s.flaky),
    console_errors: full
      ? r.console_errors
      : r.console_errors.filter((c) => c.relevant).slice(0, SUMMARY_LIMIT),
    network_failures: full
      ? r.network_failures
      : r.network_failures.filter((n) => n.relevant).slice(0, SUMMARY_LIMIT),
    blocked_requests: full ? r.blocked_requests : r.blocked_requests.slice(0, SUMMARY_LIMIT),
    artifacts: r.artifacts,
    browser: r.browser,
  };
}

export function registerGetRunResult(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_run_result',
    {
      title: 'Get checkout test run result',
      description: GET_RUN_RESULT_DESCRIPTION,
      inputSchema: GetRunResultInput,
      outputSchema: GetRunResultOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const record = await deps.manager.waitForChange(args.run_id, args.wait_s * 1000);
        const view = toRunView(record, args.detail);
        const extra: ToolResultShape['content'] = [];
        const shot = record.status === 'finished' ? record.failure?.screenshot : undefined;
        if (shot) {
          try {
            const data = (await readFile(shot)).toString('base64');
            extra.push({ type: 'image', data, mimeType: 'image/png' });
          } catch {
            // The screenshot file is gone. The path in the result is still useful to a human.
          }
        }
        return jsonResult(view, extra, record.summary);
      } catch (err) {
        return toToolErrorResult(err);
      }
    },
  );
}
