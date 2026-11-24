# Scenario authoring: inspect_target and save_scenario

Status: reviewed, waiting for approval. Date: 2026-11-24.

## 1. Intent

Today a person or an agent writes every scenario by hand. For Acme this took
two code-reading agents, a manual browser walk, and many fix-and-run loops.

The goal: one request ("set up checkout tests for this site") gives a working
scenario set. The first user is the Acme team. After that, the server is
published as open source, and any shop must be able to do the same setup with
no help from us.

The calling agent writes the scenarios. The server collects the facts, enforces
the scenario rules, saves the files, and proves each scenario with a run.

## 2. Goals

1. A new tool `inspect_target` scans the site of a target and, when the config
   gives one, the source code of the shop. It returns a structured report that an
   agent can write scenarios from.
2. A new tool `save_scenario` takes scenario or fragment YAML from the agent,
   validates it, applies the house rules, writes it to the authoring folder,
   reloads the scenario list, and can start a validation run.
3. Two MCP prompts give every client the same procedure:
   - `setup_checkout_tests`: inspect, plan, write, save, run, fix, for a first setup.
   - `create_scenario`: the same loop for one scenario that the user asks for.
4. The report lists suggested scenarios with the evidence for each.
5. **The first setup delivers a baseline test set automatically** (user decision,
   2026-11-24). The user does not pick scenarios before the first setup. The
   setup writes, saves, and runs the baseline set (section 7.4), and then shows
   the user a summary: each scenario, its verdict, and what it proves. After
   that, the user asks for more scenarios with `create_scenario`.

## 3. Non-goals

- No language model inside the server. The server never calls an LLM API.
- No MCP sampling in this version. It can come later as an option.
- No production hosts. All current safety rules stay as they are.
- No payment in an inspection. The probe never clicks a pay button and never
  asks for a phone code.
- No git operations. The server writes files only. The user commits them.
- No scenario editing UI.
- No crawl of hosts outside the target host rules.

## 4. Anti-goals (failure even if it "works")

1. A saved scenario that passes because its checks are empty or weak. A
   scenario with `expected_outcome: order_placed` and no check that proves an
   order is worse than no scenario.
2. Personal data, secrets, or card numbers in an inspection report, a saved
   file, a log, or a result.
3. A tool argument that makes the server read or write a file outside the
   configured folders, or open a URL that the config did not allow.
4. An inspection that changes data in a way the user did not expect, for example
   a submitted form or a placed order.

## 5. Constraints

- `CLAUDE.md` principles apply in full: safety first, structured errors, never
  block a tool call for minutes, same idempotency key gives the same job, small
  scope.
- Tools accept target names, never URLs. File paths in tool arguments are
  relative to a folder from the config and are checked.
- Tool descriptions and schemas are product design. The `tools/list` snapshot
  and `docs/tools.md` change in the same PR.
- The server must work for any shop: any framework, any language of the UI.

## 6. Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| A. Agent writes, server collects facts and enforces rules | Works in every MCP client, no API key, no extra cost. Quality depends on the calling model, but every saved scenario is proved by a run. | **Chosen** by the user on 2026-11-24. |
| B. Server writes with the client model (MCP sampling) | The server controls the whole loop. Many clients do not support sampling, so most open-source users could not use it. | Later, as an option. |
| C. Server writes with its own LLM key | Same result everywhere. Each user needs a key and pays for it, and code and page content go to an LLM vendor. | Rejected. |
| Templates only, no model | Every shop has a different structure. Templates break on most sites. | Rejected. |

## 7. Design

### 7.1 Config changes

```yaml
authoring:
  dir: ./scenarios/local          # must be inside one of scenario_dirs
  test_data_dir_writable: false   # save_scenario never writes test data in v1

targets:
  acme-test:
    ...
    inspect:
      source_dirs: [~/work/acme/acme-storefront]   # optional, read-only
      start_paths: ["/"]                                        # crawl seeds
      product_paths: ["/urun/example-tabak-19-cm"]  # optional hint
      max_pages: 25
      probe_checkout: true      # may click add-to-cart and the checkout button
```

- `authoring.dir` missing: `save_scenario` refuses with `AUTHORING_DISABLED`.
- `inspect` missing: `inspect_target` crawls from `/` with defaults and skips the
  code scan.
- `source_dirs` are read-only. The scan skips `.git`, `node_modules`, build
  folders, `.env*`, files over 512 KB, and binary files.

### 7.2 Tool `inspect_target`

Input:

| Param | Type | Notes |
|---|---|---|
| `target` | string | Target name from the config. |
| `idempotency_key` | string | Same key gives the same inspection, also after a restart. |
| `scope` | `"site" \| "code" \| "both"` | Default `"both"`. |
| `wait_s` | int 0..20 | Long poll. The first call starts the job. |

The tool starts a background job and long polls, like `run_scenario` plus
`get_run_result`, but in one tool: a second call with the same key returns the
progress or the result. This keeps the tool count at six.

Output (`structuredContent`):

- `inspection_id`, `status` (`queued | running | finished`), `progress`.
- `site`:
  - `pages[]`: URL path pattern, page kind guess (`home | listing | product |
    cart | login | checkout | result | other`), title, headings, landmarks,
    interactive elements (role, accessible name, label, test id, visible),
    forms with fields (label, type, autocomplete, required), selects with their
    options (capped at 50), iframes with host, dialogs that opened.
  - `api_calls[]`: method, path pattern (ids replaced with `*`), status,
    content type, page kind. No bodies, no query values.
  - `blocked_hosts[]`: hosts the guard blocked, with counts. The agent uses this
    to ask the user about `third_party_hosts`.
  - `checkout_probe`: the steps the probe did and where it stopped, with the
    reason (for example "personal data form").
- `code` (when `source_dirs` exist):
  - `framework` guesses with evidence (package names, folder layout).
  - `routes[]` for known layouts (Next.js app and pages, Nuxt, Remix, Shopify
    theme templates). Others: none, with a note.
  - `ui_strings[]`: catalog entries whose key or text matches checkout words in
    many languages (cart, checkout, payment, card, address, OTP, terms).
  - `test_ids[]`: value and `file:line`.
  - `payment_hints[]`: payment SDK packages and test-mode flags found.
  - `otp_hints[]`: endpoints and types that look like send-code or verify.
- `suggested_scenarios[]`: id, title, expected outcome, why, and the evidence
  ids it rests on. Rules, not a model, make this list (section 7.4).
- `warnings[]`: for example "no test card source found", "login needs a code
  that the response does not show".
- `report_path`: the full JSON on disk in `runs_dir/inspections/<id>.json`. The
  tool result is capped (about 40 KB). The file has the rest.

Site crawl rules:

1. Every request goes through the same host guard as a run.
2. The crawler follows links on allowed hosts only, breadth first, up to
   `max_pages`. It reads one example of each URL pattern.
3. It never fills a field, submits a form, or clicks a button, except in the
   checkout probe.
4. Checkout probe (`probe_checkout: true`, user decision 1b on 2026-11-24): the
   probe goes up to the payment step with fictional test data, as the manual
   Acme setup did.
   - On a product page, click add-to-cart. Open the cart. Click the checkout button.
   - Choose the guest option when one exists. Use an email on a reserved domain
     (`example.test`).
   - Fill the address form with a fictional name and the first options of the
     site's own select lists (city, district). Save the address.
   - On the payment step, record the payment methods, the card form, any test
     card select with its options, the agreement checkbox, and the pay button.
   - Never click the pay button. Never submit a phone number for a code. Stop at
     a login wall when the target has no member secrets.
   - Record each dialog and choice that opens, and each step where the probe
     stopped, with the reason.
   - Button names come from a multi-language word list (section 7.5).
   - Side effects on the test environment: a guest account, an address, an
     unpaid order draft, and a cart item. The report lists them.
   - Default: `false` when the `inspect` block is missing. The
     `setup_checkout_tests` prompt asks the user once before it turns the probe on.
5. Text values pass through a redactor before they go in the report: emails,
   phone numbers, card-like numbers, and long tokens become placeholders.

### 7.3 Tool `save_scenario`

Input:

| Param | Type | Notes |
|---|---|---|
| `kind` | `"scenario" \| "fragment"` | |
| `path` | string | Relative to `authoring.dir`, kebab-case, `.yaml`. No `..`, no absolute path. |
| `yaml` | string | Max 64 KB. |
| `overwrite` | boolean | Default false. |
| `validate_on` | object, optional | `{ target, params?, idempotency_key }`. Starts a run after a save. |

Steps:

1. Path check: resolve inside `authoring.dir`, refuse symlinks that leave it.
2. Parse and validate with the zod schemas (the existing `parseScenario` and
   fragment parse, so all current refuse rules apply, card number rule
   included).
3. House rules (section 7.6). Each rule is an error, a warning, or an
   automatic fix. Errors stop the save.
4. Write the file atomically. Reload the scenario registry (section 7.7).
5. With `validate_on`: start a run with the same code path as `run_scenario`
   and return its `run_id`. The agent polls `get_run_result`.

Output: `path`, `scenario_id`, `fixes_applied[]`, `warnings[]`, `run_id?`.
A failed rule gives a `ToolError` `SCENARIO_INVALID` with every issue in
`details.issues[]` (rule id, YAML path, message, how to fix).

### 7.4 Baseline set and suggested scenarios (rules)

The rules below make the suggestion list. The rows marked **baseline** are the
set that the first setup writes and runs with no question to the user, when the
evidence exists. The other rows go to the user as offers in the final summary.


| Suggestion | When |
|---|---|
| **baseline** `<target>-guest-card` | Probe reached the payment step as a guest, and a test card source has a success card. |
| **baseline** `<target>-card-declined` | Same as above, and a test card source has a decline card. |
| **baseline** `<target>-terms-required` | The payment step has an agreement checkbox. |
| **baseline** `<target>-member-card` | A login page exists, and the target has member secrets. |
| offer `<target>-otp-login` | Login needs a code, and a response shows it (regex hint). |
| offer `<target>-gift-card`, `<target>-wallet-*` | The payment step lists these methods. Needs test data from the user. |

A test card source is one of:

1. A test card select on the site (found by the probe). The scenario selects an
   option by its text, so no card number is ever written. Its options are read
   from the site, and decline options are found by words like "declined",
   "insufficient", "onaylanmadı", "yetersiz".
2. The card registry in `src/safety/test-cards.ts`. User decision 2b: v1 adds
   **iyzico** and **Craftgate** entries next to Stripe. Each card needs the
   provider's published source URL (the existing rule). The code scan maps a
   found payment SDK to a registry provider.

Each suggestion lists what is missing, for example "no member secret in the
config".

### 7.5 Multi-language word lists

One file, `src/inspect/words.ts`, with words for add-to-cart, cart, checkout,
guest, login, pay, terms, and success, in at least English, Turkish, German,
French, Spanish, Italian, and Dutch. Shops can add words in the config
(`inspect.words`).

### 7.6 House rules for `save_scenario`

The rules run on a fragment file on its own and on the expanded scenario (with
its fragments). Outcome checks count only from `outcome`, and a check with a
`when` condition does not count toward a minimum.

Errors:

1. Every param has a `description` and a `default` or `required: true`.
2. A scenario with `expected_outcome: order_placed` has at least one outcome check
   of kind `response` or `url`, and one of kind `visible` or `text`.
3. `payment_declined` and `validation_error` scenarios have a check that proves
   no success (a `hidden` or `no_response` check).
4. No literal value that looks like an email, phone, or password in a `fill`,
   a param default, or a `with` value. Use `data`, `secrets`, or `params`.
5. Scenario id is kebab-case and unique across all scenario folders.
6. Step ids are snake_case.

Automatic fixes:

1. Add the `yaml-language-server` schema line.
2. Add `schema_version: 1` when it is missing.

Warnings:

1. A step with a CSS locator: prefer role, label, or test id.
2. A payment step without `on_failure.hint`.
3. A `url` check with a glob that also matches a query string (the `/sepet`
   bug from 2026-11-24).

### 7.6.1 Test data files

`save_scenario` also takes `kind: "test_data"` and writes to `test_data_dir`.
Every email must use a reserved domain (`example.test`, `example.com`,
`.invalid`). Card-like numbers are refused. The config flag
`authoring.test_data_dir_writable` turns this on, and the setup prompt asks
the user once.

### 7.6.2 Save safety

1. Before the write, the server loads all scenario folders with the new content
   as a trial. A failed trial load refuses the save, and nothing is written.
   This also covers a fragment change that breaks other scenarios.
2. A save with content equal to the file on disk is a success, not
   `SCENARIO_EXISTS`. So a retry after a lost response is safe.
3. The `validate_on` run gets an idempotency key that the server makes from the
   scenario id, the file hash, and the params. A fixed file gives a new run, and
   a repeated save of the same file gives the same run.

### 7.7 Registry reload

`ScenarioRegistry` becomes reloadable: `RunManager` and the tools read the
current registry through a holder. A reload that fails keeps the old registry
and returns the load errors. A run that started keeps the scenario object it
started with.

### 7.8 MCP prompts

- `setup_checkout_tests(target)`: the procedure for a first setup. Call
  `inspect_target`, read the warnings, ask the user only for what the report
  cannot answer (test accounts, test cards, third-party hosts), write the
  fragments first, then the suggested scenarios, save each with `validate_on`,
  read the result, fix, and repeat up to three times for each scenario.
- `create_scenario(target, request)`: the same loop for one scenario. It reuses
  fragments in `authoring.dir` and the last inspection report.

### 7.8.1 Final summary of the first setup

The `setup_checkout_tests` prompt ends with a table for the user: scenario id,
what it proves, verdict, run id. Then a list of offers (section 7.4) and of
missing inputs (for example "member secrets", "gift card test number").

### 7.9 New error codes

`AUTHORING_DISABLED`, `SCENARIO_INVALID`, `PATH_REFUSED`,
`SCENARIO_EXISTS`, `INSPECTION_FAILED`. Each goes in the catalogue, in
`docs/tools.md`, and gets a refuse-path test.

## 8. Testing

- Unit: path guard, house rules (one test per rule), redactor, page kind
  guesser, word lists, code scan on a fixture folder.
- Integration: `inspect_target` and `save_scenario` over `InMemoryTransport`,
  updated `tools/list` snapshot, prompt list.
- E2E: inspect the demo store, check the report finds the product, cart,
  checkout, and the guest choice. Save a scenario from the suggestions and run it.
  The demo store gets a small source folder fixture for the code scan.

## 9. Calls made by the designer (check these)

1. `inspect_target` is one tool that starts and long polls the job (same key
   gives the same job), so the tool count is six, not seven.
2. `CLAUDE.md` principle 6 ("four tools") is updated in the same PR.
3. The probe default is `false` when the `inspect` block is missing.
4. Test data writes are off until the config turns them on.

## 10. Left to the builder

- File layout under `src/inspect/` and `src/authoring/`.
- Exact output field names inside the report, within the shape above.
- How to cap and trim the report for the tool result.
- The page kind heuristics.
