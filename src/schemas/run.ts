import { z } from 'zod';
import { FailureCategory, NextAction, ParamValue, RunId, RunStatus, Verdict } from './common.js';

export const RunOptions = z.object({
  timeout_multiplier: z
    .number()
    .min(1)
    .max(5)
    .default(1)
    .describe(
      'Multiplies every step timeout. Use 2 or 3 when a previous run failed with category "timeout" on a slow environment.',
    ),
  capture: z
    .enum(['failure_only', 'every_step'])
    .default('failure_only')
    .describe(
      '"every_step" takes a screenshot after each step. Use it when you need to compare screens between runs.',
    ),
  trace: z
    .boolean()
    .default(false)
    .describe('Record a Playwright trace file for a human to open later. Makes the run slower.'),
});
export type RunOptions = z.infer<typeof RunOptions>;

export const StepResult = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped']),
  duration_ms: z.number().int().optional(),
  url_after: z.string().optional(),
  screenshot: z.string().optional().describe('Absolute file path.'),
  flaky: z.boolean().optional(),
});
export type StepResult = z.infer<typeof StepResult>;

export const Failure = z.object({
  step_id: z.string().describe('Step id, or outcome check id when an outcome check failed.'),
  step_title: z.string(),
  category: FailureCategory,
  message: z.string(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  likely_causes: z.array(z.string()).describe('Most likely first. Includes the scenario author hint.'),
  next_actions: z.array(NextAction),
  screenshot: z.string().optional(),
  page_url: z.string().optional(),
});
export type Failure = z.infer<typeof Failure>;

export const OutcomeCheckResult = z.object({
  id: z.string(),
  status: z.enum(['passed', 'failed', 'not_run']),
  message: z.string().optional(),
});
export type OutcomeCheckResult = z.infer<typeof OutcomeCheckResult>;

export const ConsoleError = z.object({
  level: z.enum(['error', 'warning']),
  text: z.string(),
  source_url: z.string().optional(),
  step_id: z.string(),
  count: z.number().int(),
  relevant: z.boolean(),
});
export type ConsoleError = z.infer<typeof ConsoleError>;

export const NetworkFailure = z.object({
  method: z.string(),
  url: z.string().describe('Query string values are redacted.'),
  status: z.number().int().nullable().describe('null when the request failed without a response.'),
  failure_text: z.string().optional(),
  resource_type: z.string(),
  step_id: z.string(),
  relevant: z.boolean(),
});
export type NetworkFailure = z.infer<typeof NetworkFailure>;

export const BlockedRequest = z.object({ url: z.string(), step_id: z.string() });
export type BlockedRequest = z.infer<typeof BlockedRequest>;

export const Artifacts = z.object({
  run_dir: z.string(),
  screenshots: z.array(z.object({ step_id: z.string(), path: z.string(), uri: z.string() })),
  trace_path: z.string().nullable(),
});
export type Artifacts = z.infer<typeof Artifacts>;

/** The full run record as stored on disk. get_run_result returns a view of it. */
export const RunRecord = z.object({
  run_id: RunId,
  idempotency_key: z.string(),
  request_hash: z.string(),
  scenario_id: z.string(),
  scenario_hash: z.string(),
  target: z.string(),
  params: z.record(z.string(), ParamValue),
  options: RunOptions,
  status: RunStatus,
  verdict: Verdict.nullable(),
  summary: z.string(),
  created_at: z.string(),
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
  steps: z.array(StepResult),
  console_errors: z.array(ConsoleError),
  network_failures: z.array(NetworkFailure),
  blocked_requests: z.array(BlockedRequest),
  artifacts: Artifacts,
});
export type RunRecord = z.infer<typeof RunRecord>;
