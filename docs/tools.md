# Tool definitions v0.1 (draft for review)

The code blocks are the planned source. They use zod 4 and the SDK v2 `registerTool` API.
The `description` strings are product text. Review them like UI copy.

Contents:

1. Shared schemas
2. Error shape
3. `list_scenarios`
4. `run_scenario`
5. `get_run_result`
6. `compare_runs`
7. Reasons behind the choices

## 1. Shared schemas

```ts
import { z } from 'zod';

export const RunId = z
  .string()
  .regex(/^run_[A-Za-z0-9_-]{16}$/)
  .describe('Run id returned by run_scenario, for example "run_8fK2mQ9xLp3vTz1a".');

export const NextAction = z.object({
  kind: z.enum([
    'call_tool', // call `tool` with `arguments`
    'change_argument', // fix one argument and call the same tool again
    'wait_and_retry', // transient problem, call again after `after_s`
    'fix_scenario', // the scenario YAML is probably out of date
    'treat_as_regression', // the site behaviour changed, report it
    'ask_human', // the agent cannot fix this (config, env var, access)
  ]),
  description: z.string().describe('One sentence the agent can act on.'),
  tool: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  after_s: z.number().int().positive().optional(),
});

export const Verdict = z.enum(['passed', 'failed', 'error', 'blocked', 'cancelled']);
// passed:    all steps and outcome checks passed.
// failed:    the site did not behave as the scenario expects. Probable regression or stale scenario.
// error:     the run could not reach a verdict about the site (browser crash, target unreachable, server restart).
// blocked:   a safety rule stopped the run (host outside allowlist, unknown card number).
// cancelled: reserved for cancel_run in a later version.

export const FailureCategory = z.enum([
  'assertion_failed', // element found, but text/url/state is wrong
  'element_not_found', // locator matched nothing before the timeout
  'timeout', // step or run time limit, without a more exact cause
  'unexpected_response', // an expected response had another status, or a forbidden response arrived
  'navigation_failed', // page load failed (DNS, TLS, 5xx on document)
  'blocked_by_safety',
  'target_unreachable',
  'browser_error',
  'server_restarted',
]);
```

## 2. Error shape

`isError: true` means the tool call did not work. It never means "the checkout failed".
The same object goes into `structuredContent` and, as JSON text, into `content[0]`.

```ts
export const ToolErrorCode = z.enum([
  'UNKNOWN_TARGET',
  'UNKNOWN_SCENARIO',
  'SCENARIO_NOT_COMPATIBLE', // scenario profile does not match target profile
  'INVALID_PARAMS', // scenario-level param validation (types are checked by the SDK)
  'HOST_NOT_ALLOWED',
  'PRODUCTION_HOST_REFUSED',
  'REAL_CARD_DATA_REFUSED',
  'SECRET_IN_ARGUMENTS',
  'MISSING_ENV_SECRET',
  'IDEMPOTENCY_CONFLICT',
  'RUN_NOT_FOUND',
  'RUN_NOT_FINISHED', // compare_runs only
  'RUNS_NOT_COMPARABLE',
  'QUEUE_FULL',
  'INTERNAL_ERROR',
]);

export const ToolError = z.object({
  error: z.object({
    code: ToolErrorCode,
    message: z.string().describe('What happened, in one or two sentences.'),
    likely_cause: z.string(),
    retryable: z.boolean().describe('True when the same call can work later without changes.'),
    next_actions: z.array(NextAction).min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
```

Example: the agent sends a target that does not exist.

```json
{
  "error": {
    "code": "UNKNOWN_TARGET",
    "message": "Target \"stagin\" is not in the server config.",
    "likely_cause": "Typo in the target name. Configured targets: demo-local, saucedemo, my-staging.",
    "retryable": false,
    "next_actions": [
      {
        "kind": "change_argument",
        "description": "Call run_scenario again with target \"my-staging\".",
        "tool": "run_scenario",
        "arguments": { "target": "my-staging" }
      }
    ],
    "details": {
      "configured_targets": ["demo-local", "saucedemo", "my-staging"],
      "closest_match": "my-staging"
    }
  }
}
```

Example: the agent sends a card number in a param.

```json
{
  "error": {
    "code": "REAL_CARD_DATA_REFUSED",
    "message": "Param \"note\" contains a value that looks like a payment card number. The server does not accept card numbers in arguments.",
    "likely_cause": "A card number was passed directly. Only test card ids from list_scenarios are accepted.",
    "retryable": false,
    "next_actions": [
      {
        "kind": "call_tool",
        "description": "Get the valid test card ids and use one in the \"card\" param.",
        "tool": "list_scenarios",
        "arguments": { "scenario_id": "card-3ds-challenge-fail" }
      }
    ],
    "details": { "param": "note" }
  }
}
```

The error never echoes the refused value.

## 3. `list_scenarios`

```ts
server.registerTool(
  'list_scenarios',
  {
    title: 'List checkout test scenarios',
    description: [
      'Lists the checkout and payment test scenarios this server can run, the targets (test environments) they can run against, and the test cards you can use.',
      'Call this first, before run_scenario, to get valid values for scenario_id, target, and params.',
      'Each scenario lists its params with type, default, and description. Params of type "test_card" take an id from the test_cards list, never a card number.',
      'This tool is read-only and fast.',
    ].join(' '),
    inputSchema: z.object({
      target: z
        .string()
        .optional()
        .describe('Only show scenarios that can run on this target. Omit to see all.'),
      tag: z
        .string()
        .optional()
        .describe('Only show scenarios with this tag, for example "3ds" or "negative".'),
      scenario_id: z.string().optional().describe('Only show this one scenario, with full param details.'),
    }),
    outputSchema: z.object({
      targets: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          profile: z.string(),
          base_url: z.string(),
        }),
      ),
      scenarios: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          summary: z.string(),
          tags: z.array(z.string()),
          expected_outcome: z.enum(['order_placed', 'payment_declined', 'validation_error', 'custom']),
          compatible_targets: z.array(z.string()),
          estimated_duration_s: z.number().int(),
          params: z.array(
            z.object({
              name: z.string(),
              type: z.enum(['string', 'integer', 'number', 'boolean', 'enum', 'test_card']),
              required: z.boolean(),
              default: z.union([z.string(), z.number(), z.boolean()]).optional(),
              description: z.string(),
              values: z.array(z.string()).optional(), // enum only
              minimum: z.number().optional(),
              maximum: z.number().optional(),
              test_card_behaviour: z.string().optional(), // test_card only
            }),
          ),
        }),
      ),
      test_cards: z.array(
        z.object({
          id: z.string(), // "stripe/3ds2-challenge-required"
          provider: z.string(),
          brand: z.string(),
          last4: z.string(),
          behaviour: z.enum([
            'success',
            'challenge_required',
            'frictionless_3ds',
            'declined_generic',
            'declined_insufficient_funds',
            'declined_expired',
          ]),
          description: z.string(),
        }),
      ),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  handler,
);
```

## 4. `run_scenario`

```ts
server.registerTool(
  'run_scenario',
  {
    title: 'Start a checkout test run',
    description: [
      'Starts one checkout test scenario against a configured test environment and returns a run_id at once. The run continues in the background, usually for 30 to 180 seconds.',
      'Then call get_run_result with the run_id to get progress and the final verdict. Do not call run_scenario again to check progress.',
      'idempotency_key is required: use the same key when you retry this call after a timeout or transport error, and the server returns the first run instead of starting a second checkout. Use a new key only when you want a new run, for example "pr-4812-3ds-fail-after-deploy".',
      'target and scenario_id must come from list_scenarios. Only test environments from the server config are accepted, never URLs. Card params take test card ids, never card numbers.',
    ].join(' '),
    inputSchema: z.object({
      target: z
        .string()
        .min(1)
        .describe('Target name from list_scenarios.targets, for example "my-staging".'),
      scenario_id: z
        .string()
        .min(1)
        .describe('Scenario id from list_scenarios.scenarios, for example "card-3ds-challenge-fail".'),
      params: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .default({})
        .describe('Scenario params by name. Omit a param to use its default.'),
      idempotency_key: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{8,128}$/)
        .describe('8 to 128 characters: letters, digits, ".", "_", ":", "-". Same key = same run.'),
      options: z
        .object({
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
        })
        .default({}),
    }),
    outputSchema: z.object({
      run_id: RunId,
      status: z.enum(['queued', 'running', 'finished']),
      reused_existing_run: z
        .boolean()
        .describe('True when this idempotency_key already had a run. No new checkout started.'),
      scenario_id: z.string(),
      target: z.string(),
      resolved_params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      estimated_duration_s: z.number().int(),
      next: NextAction.describe('Normally: call get_run_result with wait_s 20.'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false, // creates orders on a test environment only
      idempotentHint: true, // with the same idempotency_key
      openWorldHint: true,
    },
  },
  handler,
);
```

Example output:

```json
{
  "run_id": "run_8fK2mQ9xLp3vTz1a",
  "status": "queued",
  "reused_existing_run": false,
  "scenario_id": "card-3ds-challenge-fail",
  "target": "demo-local",
  "resolved_params": {
    "product_path": "/products/ceramic-mug",
    "quantity": 1,
    "card": "stripe/3ds2-challenge-required"
  },
  "estimated_duration_s": 45,
  "next": {
    "kind": "call_tool",
    "description": "Wait for the run and get the result.",
    "tool": "get_run_result",
    "arguments": { "run_id": "run_8fK2mQ9xLp3vTz1a", "wait_s": 20 }
  }
}
```

## 5. `get_run_result`

```ts
const StepResult = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped']),
  duration_ms: z.number().int().optional(),
  url_after: z.string().optional(),
  screenshot: z.string().optional().describe('Absolute file path.'),
  flaky: z.boolean().optional(),
});

const Failure = z.object({
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

server.registerTool(
  'get_run_result',
  {
    title: 'Get checkout test run result',
    description: [
      'Returns the status of a run started with run_scenario, and the verdict when it is finished.',
      'Set wait_s (max 20) to wait for the run to finish or make progress before the call returns. While status is "queued" or "running", call again with wait_s 20.',
      'verdict "failed" means the site did not behave as the scenario expects: read failure.category, failure.likely_causes, and failure.next_actions.',
      'verdict "error" or "blocked" means the run could not test the site: read failure.next_actions before you retry.',
      'detail "summary" (default) returns the failing step, relevant console errors, and relevant network failures. Use detail "full" only when you need every step, console line, and request.',
    ].join(' '),
    inputSchema: z.object({
      run_id: RunId,
      wait_s: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(0)
        .describe('Seconds to wait for completion or progress. 0 returns at once.'),
      detail: z.enum(['summary', 'full']).default('summary'),
    }),
    outputSchema: z.object({
      run_id: RunId,
      status: z.enum(['queued', 'running', 'finished']),
      verdict: Verdict.nullable().describe('null until status is "finished".'),
      summary: z.string().describe('Two to four sentences: what ran, what happened, what to do.'),
      scenario_id: z.string(),
      target: z.string(),
      started_at: z.string().datetime().nullable(),
      finished_at: z.string().datetime().nullable(),
      duration_ms: z.number().int().nullable(),
      progress: z.object({
        completed_steps: z.number().int(),
        total_steps: z.number().int(),
        current_step_id: z.string().nullable(),
      }),
      failure: Failure.nullable(),
      outcome_checks: z.array(
        z.object({
          id: z.string(),
          status: z.enum(['passed', 'failed', 'not_run']),
          message: z.string().optional(),
        }),
      ),
      steps: z.array(StepResult).describe('summary: only failed and flaky steps. full: all steps.'),
      console_errors: z
        .array(
          z.object({
            level: z.enum(['error', 'warning']),
            text: z.string(),
            source_url: z.string().optional(),
            step_id: z.string(),
            count: z.number().int(),
            relevant: z.boolean(),
          }),
        )
        .describe('summary: only relevant items, max 10.'),
      network_failures: z
        .array(
          z.object({
            method: z.string(),
            url: z.string().describe('Query string values are redacted.'),
            status: z.number().int().nullable().describe('null when the request failed without a response.'),
            failure_text: z.string().optional(),
            resource_type: z.string(),
            step_id: z.string(),
            relevant: z.boolean(),
          }),
        )
        .describe('HTTP >= 400, aborted, and failed requests. summary: only relevant items, max 10.'),
      blocked_requests: z
        .array(z.object({ url: z.string(), step_id: z.string() }))
        .describe('Requests the host guard stopped. Often a missing third_party_hosts entry.'),
      artifacts: z.object({
        run_dir: z.string(),
        screenshots: z.array(z.object({ step_id: z.string(), path: z.string(), uri: z.string() })),
        trace_path: z.string().nullable(),
      }),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  handler,
);
```

`content` for a finished, failed run: one text block with the summary and the JSON, plus one image block with the failing-step screenshot.

Example `failure` for the 3DS scenario when the challenge did not appear:

```json
{
  "step_id": "submit_payment",
  "step_title": "Submit the payment",
  "category": "element_not_found",
  "message": "No element matched role=button name=\"Fail authentication\" inside frame iframe[name^='three-ds-challenge'] within 30000 ms.",
  "expected": "3DS challenge frame with a \"Fail authentication\" button",
  "actual": "Page navigated to /checkout/success. No challenge frame was present.",
  "likely_causes": [
    "The checkout skipped 3D Secure for a card that requires a challenge. This is a probable regression.",
    "Scenario author hint: the card can be wrong for this scenario. Check that the card behaviour is challenge_required."
  ],
  "next_actions": [
    {
      "kind": "treat_as_regression",
      "description": "Report that the order completed without 3DS. Include the screenshot and the POST /api/payments response."
    },
    {
      "kind": "call_tool",
      "description": "Run the same scenario on the baseline target and compare, to confirm the change is new.",
      "tool": "run_scenario",
      "arguments": { "target": "demo-local", "scenario_id": "card-3ds-challenge-fail" }
    }
  ],
  "screenshot": "/path/to/.checkout-test-mcp/runs/run_8fK2mQ9xLp3vTz1a/04-submit_payment.png",
  "page_url": "http://localhost:4173/checkout/success"
}
```

The runner builds `likely_causes` from rules. Examples:

| Situation                                               | Category              | First likely cause                | First next action                           |
| ------------------------------------------------------- | --------------------- | --------------------------------- | ------------------------------------------- |
| Locator timeout, page has no error, URL unchanged       | `element_not_found`   | Selector out of date              | `fix_scenario`                              |
| Locator timeout, page URL is an unexpected page         | `element_not_found`   | Flow changed                      | `treat_as_regression`                       |
| Locator timeout, a relevant 5xx exists in the same step | `unexpected_response` | Backend error                     | `treat_as_regression`                       |
| Step timeout, no network activity for the full time     | `timeout`             | Slow environment                  | `change_argument` (`timeout_multiplier: 2`) |
| Blocked request to a payment script host                | `blocked_by_safety`   | Missing `third_party_hosts` entry | `ask_human`                                 |
| Document request failed with DNS or TLS error           | `target_unreachable`  | Environment down or VPN off       | `ask_human`                                 |

## 6. `compare_runs`

```ts
server.registerTool(
  'compare_runs',
  {
    title: 'Compare two checkout test runs',
    description: [
      'Compares two finished runs of the same scenario, for example before and after a deploy, and reports regressions.',
      'baseline_run_id is the known-good or earlier run. candidate_run_id is the new run.',
      'A regression is a step or outcome check that passed in the baseline and failed in the candidate, a new relevant console error, a new relevant network failure, or a step that became much slower.',
      'Both runs must have status "finished". The runs can use different targets, for example production-like staging and a preview environment.',
    ].join(' '),
    inputSchema: z.object({
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
    }),
    outputSchema: z.object({
      verdict: z.enum(['regression', 'fixed', 'no_change', 'both_failing', 'inconclusive']),
      summary: z.string(),
      scenario_id: z.string(),
      baseline: z.object({ run_id: RunId, target: z.string(), verdict: Verdict, finished_at: z.string() }),
      candidate: z.object({ run_id: RunId, target: z.string(), verdict: Verdict, finished_at: z.string() }),
      regressions: z.array(
        z.object({
          kind: z.enum([
            'step_failed',
            'outcome_failed',
            'new_console_error',
            'new_network_failure',
            'slower',
          ]),
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
      warnings: z
        .array(z.string())
        .describe('For example: params differ, scenario file changed between runs.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  handler,
);
```

- Different scenario ids: `RUNS_NOT_COMPARABLE`.
- One run not finished: `RUN_NOT_FINISHED`, with `next_actions` that call `get_run_result` with `wait_s: 20`.
- `inconclusive`: one run has verdict `error` or `blocked`. The site was not tested in that run.
- Each run stores a hash of the scenario file. A different hash gives a warning, not an error.

## 7. Reasons behind the choices

1. **The description tells the model the order of calls.** Each description says which tool comes before it, which comes after it, and what not to do ("Do not call run_scenario again to check progress"). Models follow sequence text in descriptions well.
2. **Examples inside `.describe()`.** A concrete example value ("pr-4812-3ds-fail-after-deploy") gives the model the format at once. This lowers first-call errors more than a long rule.
3. **`next` and `next_actions` carry ready arguments.** The model can copy them into the next call. This removes a common mistake: a wrong run_id or a missing field on the follow-up call.
4. **Types in the schema, business rules in the server.** The SDK rejects a wrong type before the handler runs. Rules that need config (target exists, card behaviour fits) give a `ToolError` with a fix.
5. **Verdict and category are enums.** The agent can branch on them without text parsing. `summary` is for the human reading the agent transcript.
6. **`relevant` flags and caps in summary mode.** A checkout page can log hundreds of console lines. The model gets at most ten items of each kind, ordered by relevance.
7. **Annotations are honest.** `run_scenario` is not read-only and is open-world. Clients that ask the user before side effects ask for this tool only.
8. **`tools/list` snapshot test.** A test stores the generated JSON of all four tools. Any change to a description or schema shows in review as a diff.
