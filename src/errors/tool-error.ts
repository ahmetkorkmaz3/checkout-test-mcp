import { z } from 'zod';
import { NextAction } from '../schemas/common.js';

export const ToolErrorCode = z.enum([
  'UNKNOWN_TARGET',
  'UNKNOWN_SCENARIO',
  'SCENARIO_NOT_COMPATIBLE',
  'INVALID_PARAMS',
  'HOST_NOT_ALLOWED',
  'PRODUCTION_HOST_REFUSED',
  'REAL_CARD_DATA_REFUSED',
  'SECRET_IN_ARGUMENTS',
  'MISSING_ENV_SECRET',
  'IDEMPOTENCY_CONFLICT',
  'RUN_NOT_FOUND',
  'RUN_NOT_FINISHED',
  'RUNS_NOT_COMPARABLE',
  'QUEUE_FULL',
  'AUTHORING_DISABLED',
  'SCENARIO_INVALID',
  'PATH_REFUSED',
  'SCENARIO_EXISTS',
  'INSPECTION_FAILED',
  'INTERNAL_ERROR',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

export const ToolErrorPayload = z.object({
  error: z.object({
    code: ToolErrorCode,
    message: z.string(),
    likely_cause: z.string(),
    retryable: z.boolean(),
    next_actions: z.array(NextAction).min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ToolErrorPayload = z.infer<typeof ToolErrorPayload>;

export interface ToolErrorInit {
  code: ToolErrorCode;
  message: string;
  likelyCause: string;
  retryable?: boolean;
  nextActions: [NextAction, ...NextAction[]];
  details?: Record<string, unknown>;
}

/** A tool call that did not work. Never use it for a failed checkout: that is a run verdict. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly likelyCause: string;
  readonly retryable: boolean;
  readonly nextActions: NextAction[];
  readonly details: Record<string, unknown> | undefined;

  constructor(init: ToolErrorInit) {
    super(init.message);
    this.name = 'ToolError';
    this.code = init.code;
    this.likelyCause = init.likelyCause;
    this.retryable = init.retryable ?? false;
    this.nextActions = init.nextActions;
    this.details = init.details;
  }

  toPayload(): ToolErrorPayload {
    return {
      error: {
        code: this.code,
        message: this.message,
        likely_cause: this.likelyCause,
        retryable: this.retryable,
        next_actions: this.nextActions,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export interface ToolResultShape {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function toToolErrorResult(err: unknown): ToolResultShape {
  const toolError =
    err instanceof ToolError
      ? err
      : new ToolError({
          code: 'INTERNAL_ERROR',
          message: 'The server had an internal error while it handled this call.',
          likelyCause: err instanceof Error ? `Bug or unexpected state: ${err.message}` : 'Unknown error.',
          retryable: true,
          nextActions: [
            {
              kind: 'wait_and_retry',
              description: 'Retry the same call once. If it fails again, report the error to a human.',
              after_s: 5,
            },
          ],
        });
  const payload = toolError.toPayload();
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}
