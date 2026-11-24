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
7. `save_scenario`
8. `inspect_target`
9. Prompts
10. Reasons behind the choices

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
  'AUTHORING_DISABLED', // save_scenario: no authoring block, or test data writes are off
  'SCENARIO_INVALID', // save_scenario: schema, house rule, or trial load issues in details.issues
  'PATH_REFUSED', // a file path leaves its allowed folder
  'SCENARIO_EXISTS', // save_scenario: the file exists with other content and overwrite is off
  'INSPECTION_FAILED', // inspect_target: a phase of the job stopped. A report warning, not a tool error
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
  "screenshot": "/path/to/.checkout-test-mcp/runs/run_8fK2mQ9xLp3vTz1a/05-submit_payment.png",
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

## 7. `save_scenario`

The agent writes the YAML. The server checks it and writes the file. Source: `src/tools/save-scenario.ts` (tool) and `src/authoring/save.ts` (logic). Design: [scenario authoring spec](superpowers/specs/2026-11-24-scenario-authoring-design.md), sections 7.3 and 7.6.

```ts
server.registerTool(
  'save_scenario',
  {
    title: 'Save a scenario file',
    description: SAVE_SCENARIO_DESCRIPTION, // see the source, reviewed through the tools/list snapshot
    inputSchema: z.object({
      kind: z.enum(['scenario', 'fragment', 'test_data']),
      path: z.string().min(1), // relative, kebab-case, ".yaml"
      yaml: z.string().min(1).max(65_536),
      overwrite: z.boolean().default(false),
      validate_on: z
        .object({ target: z.string().min(1), params: z.record(z.string(), ParamValue).optional() })
        .optional(), // kind "scenario" only
    }),
    outputSchema: z.object({
      path: z.string(),
      kind: z.enum(['scenario', 'fragment', 'test_data']),
      scenario_id: z.string().nullable(),
      written: z.boolean(),
      unchanged: z.boolean(),
      fixes_applied: z.array(z.string()),
      warnings: z.array(RuleIssue), // { rule, severity, path, message, fix }
      validation: z
        .object({ run_id: RunId, status: RunStatus, reused_existing_run: z.boolean() })
        .nullable(),
      next: NextAction,
    }),
    // openWorldHint: validate_on starts a browser run against a test target.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  handler,
);
```

The server does these steps in this order. A refusal writes nothing.

1. No `authoring` block in the config: `AUTHORING_DISABLED`. `kind: "test_data"` without `authoring.test_data_dir_writable: true`: `AUTHORING_DISABLED`. `validate_on` with a kind other than `scenario`: `INVALID_PARAMS`.
2. The path resolves inside `authoring.dir` (scenario, fragment) or `test_data_dir` (test data). A path with `..`, an absolute path, a wrong name, or a symlink that leaves the folder: `PATH_REFUSED`.
3. A card-like number anywhere in the text, also a registry test card number: `REAL_CARD_DATA_REFUSED`. Secret-like text: `SECRET_IN_ARGUMENTS`. A key whose whole value is one template, for example `password: "{{secrets.member_password}}"`, is not a secret value. A key that opens a nested map is not a secret value either, unless its block has a literal `default:`.
4. Automatic fixes (schema line, `schema_version: 1`), YAML parse, zod schema, trial load of all scenario folders with the new text, and the house rules. Test data gets no fixes and uses the test data rules. Any error: `SCENARIO_INVALID` with every issue in `details.issues`. An issue never shows a YAML key with other characters than letters, digits, `_`, and `-`. Such a key shows as `<key>`, because it can be an email or another value.
5. The file exists with the same text after the fixes: success with `unchanged: true` and `written: false`. Other text and `overwrite: false`: `SCENARIO_EXISTS`.
6. Atomic write (temp file in the same folder, then rename). A read or write error, for example a folder with the file name, gives `PATH_REFUSED` with the relative path and the error code, never the absolute path. The server swaps in the trial registry, so `list_scenarios` and `run_scenario` see the file at once.
7. `validate_on` starts a run. The server makes the idempotency key: `save-<first 60 characters of scenario_id>-<first 16 hex of sha256(target + scenario hash + params JSON with sorted keys)>`. The scenario hash comes from the trial load and covers the scenario text and all its fragment texts. The same file, fragments, target, and params give the same run, also with the params in another key order. A changed file, a changed fragment, or another target gives a new run. When the run does not start, the error message says that the file was saved, and `details` has `saved: true`.

Example: save and validate.

```json
{
  "kind": "scenario",
  "path": "guest/card-success-two-items.yaml",
  "yaml": "id: card-success-two-items\ntitle: ...",
  "validate_on": { "target": "demo-local", "params": { "quantity": 2 } }
}
```

```json
{
  "path": "guest/card-success-two-items.yaml",
  "kind": "scenario",
  "scenario_id": "card-success-two-items",
  "written": true,
  "unchanged": false,
  "fixes_applied": ["Added \"schema_version: 1\"."],
  "warnings": [],
  "validation": { "run_id": "run_8fK2mQ9xLp3vTz1a", "status": "queued", "reused_existing_run": false },
  "next": {
    "kind": "call_tool",
    "description": "Wait for the validation run and get the result.",
    "tool": "get_run_result",
    "arguments": { "run_id": "run_8fK2mQ9xLp3vTz1a", "wait_s": 20 }
  }
}
```

Example: a weak outcome check.

```json
{
  "error": {
    "code": "SCENARIO_INVALID",
    "message": "The scenario breaks 1 rule. Nothing was written.",
    "likely_cause": "The YAML does not match the schema, a house rule, or the other scenario files.",
    "retryable": false,
    "next_actions": [
      {
        "kind": "fix_scenario",
        "description": "Fix every issue in details.issues, then call save_scenario again with the fixed YAML.",
        "tool": "save_scenario"
      }
    ],
    "details": {
      "issues": [
        {
          "rule": "outcome-proves-order",
          "severity": "error",
          "path": "outcome",
          "message": "expected_outcome is order_placed, but no outcome check of kind \"response\" or \"url\" counts. A check with \"when\" does not count.",
          "fix": "Add an outcome check without \"when\" that waits for the order response (\"response\") or the confirmation page URL (\"url\")."
        }
      ]
    }
  }
}
```

Errors:

| Code | When |
|---|---|
| `AUTHORING_DISABLED` | No `authoring` block, or test data writes are off. |
| `PATH_REFUSED` | The path is not relative, does not match the name rule, or leaves the folder. The server cannot read or write the file. |
| `REAL_CARD_DATA_REFUSED` | The text has a card-like number. |
| `SECRET_IN_ARGUMENTS` | The text has secret-like text. |
| `SCENARIO_INVALID` | Schema, house rule, or trial load issues. See `details.issues`. |
| `SCENARIO_EXISTS` | The file exists with other text and `overwrite` is false. |
| `INVALID_PARAMS` | `validate_on` with a kind other than `scenario`. |
| Errors of `run_scenario` | The file is saved, but the validation run did not start. |

## 8. `inspect_target`

The tool reads a test target and suggests scenarios. One tool starts the background job and long polls it, like `run_scenario` plus `get_run_result` in one call. Source: `src/tools/inspect-target.ts` (tool), `src/inspect/manager.ts` (jobs), `src/inspect/report.ts` (report schema and trim), and `src/inspect/suggest.ts` (rules). Design: [scenario authoring spec](superpowers/specs/2026-11-24-scenario-authoring-design.md), sections 7.2 and 7.4.

```ts
server.registerTool(
  'inspect_target',
  {
    title: 'Inspect a test target',
    description: INSPECT_TARGET_DESCRIPTION, // see the source, reviewed through the tools/list snapshot
    inputSchema: z.object({
      target: z.string().min(1),
      idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/), // same regex as run_scenario
      scope: z.enum(['site', 'code', 'both']).default('both'),
      wait_s: z.number().int().min(0).max(20).default(20),
      // Read arguments: one page of a list from the full stored report. Not part of the request hash.
      section: z.enum(['pages', 'api_calls', 'ui_strings', 'test_ids', 'routes', 'probe_steps']).optional(),
      offset: z.number().int().min(0).default(0),
    }),
    outputSchema: InspectionReport.extend({
      reused_existing_inspection: z.boolean(),
      slice: z
        .object({
          section: ReportSection,
          offset: z.number().int(),
          total: z.number().int(),
          items: z.array(z.record(z.string(), z.unknown())),
          next_offset: z.number().int().nullable(), // null when no items are left
        })
        .nullable(), // null without section
      next: NextAction,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  handler,
);

const InspectionReport = z.object({
  inspection_id: z.string().regex(/^insp_[A-Za-z0-9_-]{16}$/),
  target: z.string(),
  status: z.enum(['queued', 'running', 'finished']),
  interrupted: z.boolean(), // the server stopped during the job. It was not repeated.
  progress: z.string(),
  site: SiteReport.nullable(), // pages, api_calls, blocked_hosts
  checkout_probe: ProbeResult.nullable(), // reached, stopped_reason, steps, dialogs, guest_option, payment, side_effects
  code: CodeReport.nullable(), // frameworks, routes, ui_strings, test_ids, payment_hints, otp_hints, stats, warnings
  suggested_scenarios: z.array(Suggestion),
  warnings: z.array(z.string()),
  side_effects: z.array(z.string()),
  report_path: z.string(), // runs_dir/inspections/<id>.json
});

const Suggestion = z.object({
  id: z.string(), // "<target>-guest-card"
  title: z.string(),
  expected_outcome: ExpectedOutcome,
  baseline: z.boolean(), // write and run in the first setup with no question
  why: z.string(),
  evidence: z.array(z.string()), // report paths, for example "checkout_probe.payment.test_card_select"
  missing: z.array(z.string()), // inputs to ask the user for
  card_source: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('site_select'), option: z.string() }),
      z.object({ kind: z.literal('registry'), card_id: z.string() }),
    ])
    .nullable(),
});
```

`ProbeResult.payment` also has `card_frames` (`{ host, title, name? }[]`) and `card_fields` (`{ label?, placeholder?, autocomplete?, in_frame }[]`). The probe reads a card frame from the iframe element on the parent page, so a frame on a blocked host is listed too. A frame counts when it has card fields, or when the guard blocked it and it looks like a payment frame. `card_fields` has the inline card inputs and the inputs of card frames on allowed hosts: labels, placeholders, and autocomplete values, never values. When a card frame host is blocked, a warning says that the card fields are unknown and names the host to add to `third_party_hosts`.

`ProbeResult.stopped_reason` is one of `payment_step_reached`, `login_required`, `no_product`, `no_add_to_cart`, `no_checkout_button`, `form_not_understood`, `timeout`, `blocked_by_safety`, `verification_required`. `ProbeResult.dialogs` lists the dialogs that opened during the probe.

The server does these steps in this order:

1. Unknown target: `UNKNOWN_TARGET`. A target host in `production_hosts`: `PRODUCTION_HOST_REFUSED` (the config load refuses it too). A host without a test label: `HOST_NOT_ALLOWED`. `scope: "code"` without `inspect.source_dirs`: `INVALID_PARAMS`.
2. The key has an inspection with the same target and scope: the server returns it with `reused_existing_inspection: true`. Other arguments: `IDEMPOTENCY_CONFLICT`. `wait_s` is not part of the comparison.
3. `http_credentials` secrets that are not set: `MISSING_ENV_SECRET`.
4. The job waits in the queue. One inspection runs at a time, and it needs a browser slot that it shares with the runs (`max_parallel_runs`).
5. Site phase (`scope` "site" or "both"): the crawl. Then the checkout probe, only with `inspect.probe_checkout: true`. Without the flag, `checkout_probe` is null and a warning names the flag and the side effects.
6. Code phase (`scope` "code" or "both"): the scan of `inspect.source_dirs`. With `scope: "both"` and no source folders, the scan does not run and a warning says so.
7. Suggestions from the rules in the spec, section 7.4. Then `status: "finished"`.

A phase that crashes does not give a tool error. The job keeps the parts that are done, finishes, and adds a warning that starts with `INSPECTION_FAILED`. The warning has the phase, the error class, and a short message without URLs or absolute paths.

After a restart, an inspection that was `queued` or `running` becomes `finished` with `interrupted: true` and a warning. The server does not repeat it. Each record on disk has its idempotency key, so the server rebuilds a key that the index file does not have. A failed job never stops the jobs after it.

The compact JSON of the whole output object (the report, `reused_existing_inspection`, and `next`) stays under 40 000 characters. The text block is that compact JSON, not a pretty-printed copy. To fit, the server cuts page `elements` first, then `code.ui_strings`, then `site.api_calls`. If that is not enough, it cuts `code.test_ids`, `code.routes`, `code.otp_hints`, and then pages from the end. It adds one warning that lists the cut parts and tells the agent to read them with `section` and `offset`. The file at `report_path` also has the full report, but an agent with only the MCP tools cannot read it.

To read a cut list, call `inspect_target` with the same target, key, and scope, plus `section` and `offset` (start with 0). The key must already have an inspection. Otherwise the tool refuses with `INVALID_PARAMS` and starts nothing. `section` and `offset` are read arguments: they are not part of the request hash, so they never give `IDEMPOTENCY_CONFLICT`. When the inspection is finished, the result has `slice` with as many items from `offset` as fit under the same 40 000 character limit (at least one), `total`, and `next_offset` (null at the end). In this result `site`, `checkout_probe`, and `code` are null, `suggested_scenarios` and `side_effects` are empty, and one warning says so. `next` holds the call for the next page. When the inspection is not finished, `slice` is null and the result is the usual progress.

`next`: while the status is not `finished`, a `call_tool` of `inspect_target` with the same arguments. When it is finished, a `call_tool` of `save_scenario` if a baseline suggestion exists, else `ask_human` for the missing inputs.

Example: a finished inspection (trimmed).

```json
{
  "inspection_id": "insp_Q2x8LmN4pR7sTv0a",
  "target": "demo-local",
  "status": "finished",
  "interrupted": false,
  "progress": "Finished.",
  "site": {
    "pages": [
      { "path_pattern": "/products/*", "url_path": "/products/ceramic-mug", "kind": "product", "title": "Ceramic mug", "...": "..." },
      { "path_pattern": "/checkout", "url_path": "/checkout", "kind": "checkout", "...": "..." }
    ],
    "api_calls": [
      { "method": "GET", "path_pattern": "/api/products/*", "status": 200, "content_type": "application/json", "page_kind": "product" }
    ],
    "blocked_hosts": []
  },
  "checkout_probe": {
    "reached": "payment",
    "stopped_reason": "payment_step_reached",
    "steps": [{ "action": "add to cart: \"Add to cart\"", "page_kind": "product", "url_path": "/", "result": "done" }],
    "dialogs": [],
    "guest_option": true,
    "payment": {
      "methods": [],
      "card_form": true,
      "card_iframe_hosts": ["localhost"],
      "card_frames": [{ "host": "localhost", "title": "Secure card payment input" }],
      "card_fields": [
        { "placeholder": "Card number", "autocomplete": "cc-number", "in_frame": true },
        { "placeholder": "MM / YY", "autocomplete": "cc-exp", "in_frame": true },
        { "placeholder": "CVC", "autocomplete": "cc-csc", "in_frame": true }
      ],
      "test_card_select": null,
      "agreement_checkbox": "I accept the terms",
      "pay_button": "Pay now"
    },
    "side_effects": ["cart item", "guest account inspect-0a1b2c3d@example.test", "address"]
  },
  "code": {
    "frameworks": [],
    "routes": [],
    "ui_strings": [],
    "test_ids": [{ "value": "pay-button", "file": "app/checkout/page.tsx", "line": 9 }],
    "payment_hints": [{ "provider": "stripe", "package": "@stripe/stripe-js", "file": "package.json" }],
    "otp_hints": [],
    "stats": { "files": 2, "skipped": 0, "truncated": false },
    "warnings": []
  },
  "suggested_scenarios": [
    {
      "id": "demo-local-guest-card",
      "title": "Guest checkout with a test card that succeeds",
      "expected_outcome": "order_placed",
      "baseline": true,
      "why": "Proves that a guest can place an order with a card. It is the main checkout path.",
      "evidence": ["checkout_probe.reached (payment)", "checkout_probe.guest_option", "code.payment_hints[0] (@stripe/stripe-js)"],
      "missing": [],
      "card_source": { "kind": "registry", "card_id": "stripe/visa-success" }
    },
    {
      "id": "demo-local-member-card",
      "title": "Member login and checkout with a test card that succeeds",
      "expected_outcome": "order_placed",
      "baseline": false,
      "why": "Proves that a logged-in member can place an order with a card.",
      "evidence": ["code.payment_hints[0] (@stripe/stripe-js)"],
      "missing": ["a login page on the site", "member secrets: map member_email and member_password in the target secrets config"],
      "card_source": { "kind": "registry", "card_id": "stripe/visa-success" }
    }
  ],
  "warnings": [],
  "side_effects": ["cart item", "guest account inspect-0a1b2c3d@example.test", "address"],
  "report_path": "/home/me/shop-tests/.checkout-test-mcp/runs/inspections/insp_Q2x8LmN4pR7sTv0a.json",
  "reused_existing_inspection": false,
  "next": {
    "kind": "call_tool",
    "description": "Write each baseline scenario in suggested_scenarios, then save it with save_scenario and validate_on on this target.",
    "tool": "save_scenario"
  }
}
```

Suggestion rules (spec section 7.4):

| Suggestion | Baseline when |
|---|---|
| `<target>-guest-card` | The probe reached the payment step, and a test card source has a success card. |
| `<target>-card-declined` | The same, and the source has a decline card. |
| `<target>-terms-required` | The payment step has an agreement checkbox. |
| `<target>-member-card` | A login page exists, the target maps `member_email` and `member_password` in `secrets`, and a test card source has a success card. |
| `<target>-otp-login` (offer) | A page has a one-time code field, or the code scan found OTP hints. |
| `<target>-gift-card`, `<target>-wallet-<name>` (offers) | The payment step lists these methods. |

The four baseline rows are always in the list. A row with missing evidence has `baseline: false` and says what is missing. Test card source order: the site test card select (decline options match the `decline` word list), then the first `code.payment_hints` provider with registry cards, then a `card_iframe_hosts` host that contains a provider name. A provider without published cards, for example Craftgate, gives `card_source: null` and a `missing` entry.

Errors:

| Code | When |
|---|---|
| `UNKNOWN_TARGET` | The target is not in the config. |
| `PRODUCTION_HOST_REFUSED` | A target host is in `production_hosts`. |
| `HOST_NOT_ALLOWED` | A target host has no test label. |
| `INVALID_PARAMS` | `scope: "code"` without `inspect.source_dirs`, or `section` with a key that has no inspection. |
| `IDEMPOTENCY_CONFLICT` | The key has an inspection with another target or scope. |
| `MISSING_ENV_SECRET` | An `http_credentials` secret is not set. |
| `INSPECTION_FAILED` | Not a tool error. A warning in the report when a phase stopped. |

## 9. Prompts

The server has two MCP prompts. A client shows them as commands, for example `/setup_checkout_tests` in Claude Code. A prompt returns one user message with the procedure. The texts are product text, like the tool descriptions. The source is `src/prompts/`.

Both prompts start with the config facts and the fragments that no tool shows. The fragment list comes from the files in `authoring.dir` when the prompt runs: path, id, description, and args with descriptions and defaults (at most 50 fragments). The config facts are: whether the checkout probe is on, the source folders, the authoring folder, test data writes, the secret names with their env var names (never the values), and the third-party hosts. So the agent asks the user only for what the config and the report cannot answer. For a target that is not in the config, a prompt returns only a text that lists the targets and tells the agent to stop.

Both prompts also say that the server reads the config once: a change to `authoring`, `inspect`, `third_party_hosts`, or `secrets` needs a server restart. The agent waits for the restart before it runs card scenarios. A `blocked` verdict that names a host is a config fix, not one of the 3 tries. When a result is cut, the agent reads the lists with `section` and `offset`.

### 9.1 `setup_checkout_tests`

Arguments: `target` (target name, never a URL).

The first setup of a target. The agent does these steps in order:

1. Calls `list_scenarios` and checks that the target exists.
2. Asks the user once, in one message, for the config changes that the setup needs. When `inspect.probe_checkout` is not `true`, it asks to allow the probe and lists the side effects: a guest account with an `example.test` email, an address, an unpaid order draft, and a cart item. The user edits the config.
3. Calls `inspect_target` with a new key (for example `setup-<target>-<YYYYMMDD>`) and polls with the same key until `finished`. When `reused_existing_inspection` is true and the config changed after that inspection, it adds a counter to the key.
4. Shows `blocked_hosts`. A payment or 3D Secure host must go into `third_party_hosts`. Analytics and ad hosts stay blocked.
5. Writes and saves the fragments first: add to cart, guest start, address, pay.
6. Writes a customer test data file when `test_data_dir_writable` is on, with a reserved email domain and the site's own city and district options.
7. Writes each suggestion with `baseline: true`, saves it with `validate_on`, polls `get_run_result`, reads the failure when the verdict is not `passed`, fixes, and saves again. Maximum 3 tries for each scenario. After that, the scenario is "needs a human" with the last failure.
8. Ends with a table (scenario, what it proves, verdict, run id), then lists: needs a human, offers (`baseline: false`), missing inputs, side effects (also the test orders of `order_placed` validation runs), and the saved files.

The text also has the secret rules (the agent never asks for a password in the chat), a short scenario format, the house rules by id, and writing rules from earlier setups:

- After a step opens a page, an expect `response` check before the first click, because a click before hydration does nothing. The url is `"**"` plus the `path_pattern` of the call. Without a call for the page kind, a `wait_for` step with a `visible` check.
- Card fields in a frame: `within: { frame: { css: "iframe[title='<title>']" } }` with the labels from `card_fields`. The `prefer-semantic-locator` warning is expected there.
- `exact: true` role names for duplicated buttons.
- `url: { regex: "^https?://[^/]+/path/?(\\?.*)?$" }` for paths, not a `**` glob.
- `capture.body_regex` for a Next.js server action body, `json_path` for JSON.
- A boolean `three_ds` param with a `when` on the 3D Secure fragment when the provider decides.
- Custom comboboxes: click the combobox, then the option by exact name.
- A site test card select: select the option by its text. Never a card number.

### 9.2 `create_scenario`

Arguments: `target`, `request` (what the scenario must prove, in plain words, max 2000 characters).

The same loop for one scenario. The agent checks that no scenario already does the request, reads the latest finished inspection of the target, asks the user once for what is missing (also the probe, when the report has no payment step), reuses the fragments in the authoring folder, saves the scenario with `validate_on`, and fixes it in at most 3 tries.

The prompt names the key of the latest finished inspection of the target that read the site and that the server did not interrupt. An inspection whose probe reached the payment step wins over a newer one whose probe did not. A call with that key returns the stored report and starts no probe. When the target has no such inspection, the prompt tells the agent to use a new key.

## 10. Reasons behind the choices

1. **The description tells the model the order of calls.** Each description says which tool comes before it, which comes after it, and what not to do ("Do not call run_scenario again to check progress"). Models follow sequence text in descriptions well.
2. **Examples inside `.describe()`.** A concrete example value ("pr-4812-3ds-fail-after-deploy") gives the model the format at once. This lowers first-call errors more than a long rule.
3. **`next` and `next_actions` carry ready arguments.** The model can copy them into the next call. This removes a common mistake: a wrong run_id or a missing field on the follow-up call.
4. **Types in the schema, business rules in the server.** The SDK rejects a wrong type before the handler runs. Rules that need config (target exists, card behaviour fits) give a `ToolError` with a fix.
5. **Verdict and category are enums.** The agent can branch on them without text parsing. `summary` is for the human reading the agent transcript.
6. **`relevant` flags and caps in summary mode.** A checkout page can log hundreds of console lines. The model gets at most ten items of each kind, ordered by relevance.
7. **Annotations are honest.** `run_scenario` is not read-only and is open-world. Clients that ask the user before side effects ask for this tool only.
8. **`tools/list` snapshot test.** A test stores the generated JSON of all tools. Any change to a description or schema shows in review as a diff.
