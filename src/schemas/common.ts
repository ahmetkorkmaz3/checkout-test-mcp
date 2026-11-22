import { z } from 'zod';

export const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{16}$/;

export const RunId = z
  .string()
  .regex(RUN_ID_PATTERN)
  .describe('Run id returned by run_scenario, for example "run_8fK2mQ9xLp3vTz1a".');

export const NextActionKind = z.enum([
  'call_tool',
  'change_argument',
  'wait_and_retry',
  'fix_scenario',
  'treat_as_regression',
  'ask_human',
]);

export const NextAction = z.object({
  kind: NextActionKind,
  description: z.string().describe('One sentence the agent can act on.'),
  tool: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  after_s: z.number().int().positive().optional(),
});
export type NextAction = z.infer<typeof NextAction>;

export const Verdict = z.enum(['passed', 'failed', 'error', 'blocked', 'cancelled']);
export type Verdict = z.infer<typeof Verdict>;

export const RunStatus = z.enum(['queued', 'running', 'finished']);
export type RunStatus = z.infer<typeof RunStatus>;

export const FailureCategory = z.enum([
  'assertion_failed',
  'element_not_found',
  'timeout',
  'unexpected_response',
  'navigation_failed',
  'blocked_by_safety',
  'target_unreachable',
  'browser_error',
  'server_restarted',
]);
export type FailureCategory = z.infer<typeof FailureCategory>;

export const ParamValue = z.union([z.string(), z.number(), z.boolean()]);
export type ParamValue = z.infer<typeof ParamValue>;

export const ExpectedOutcome = z.enum(['order_placed', 'payment_declined', 'validation_error', 'custom']);

export const CardBehaviour = z.enum([
  'success',
  'challenge_required',
  'frictionless_3ds',
  'declined_generic',
  'declined_insufficient_funds',
  'declined_expired',
]);
export type CardBehaviour = z.infer<typeof CardBehaviour>;
