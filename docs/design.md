# checkout-test-mcp: design v0.1 (draft for review)

Status: v0.1 implemented on 2026-11-22. Section 10 lists what the implementation changed or decided.
Working name: `checkout-test-mcp`. The npm name is free on 2026-11-22.

Related files:

- Tool definitions: [tools.md](tools.md)
- Full scenario example: [card-3ds-challenge-fail.yaml](../scenarios/demo-store/card-3ds-challenge-fail.yaml)
- Project rules for agents: [CLAUDE.md](../CLAUDE.md)

## 1. Versions (checked on 2026-11-22)

| Package                        | Version                        | Note                                                                                    |
| ------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------- |
| Node.js                        | 26.13.1 (Active LTS "Lithium") | Node 24 "Krypton" is still LTS. Local machine has 22.21.1.                              |
| `@modelcontextprotocol/server` | 2.4.0                          | SDK v2, the stable line. Implements MCP spec 2026-07-28. Needs Node >= 20 and zod ^4.2. |
| `@modelcontextprotocol/sdk`    | 1.32.2                         | v1 line. Do not use. v2 replaces it.                                                    |
| `@modelcontextprotocol/node`   | 2.4.0                          | Node HTTP adapter. Only for the later HTTP transport.                                   |
| `playwright`                   | 1.65.1                         | Library package, not `@playwright/test`. Needs Node >= 20.                              |
| `zod`                          | 4.6.7                          | One source for all schemas.                                                             |
| `yaml`                         | 2.9.1                          | Scenario and config parser.                                                             |
| `typescript`                   | 7.0.2                          | Native compiler. See open question Q10.                                                 |
| `vitest`                       | 5.1.1                          | Unit and integration tests.                                                             |
| `tsx`                          | 4.23.15                        | Dev runner.                                                                             |
| `@biomejs/biome`               | 2.6.8                          | Lint and format.                                                                        |
| `@types/node`                  | 26.6.6                         | TS >= 6 needs `"types": ["node"]` in tsconfig (SDK README).                             |

SDK v2 API facts that the design uses:

- `new McpServer({ name, version })` and `server.registerTool(name, { title, description, inputSchema, outputSchema, annotations }, handler)`.
- `inputSchema` and `outputSchema` take a `z.object(...)`. The raw-shape form is deprecated in v2.
- The handler returns `{ content, structuredContent, isError? }`.
- Stdio comes from `@modelcontextprotocol/server/stdio` (`StdioServerTransport`, `serveStdio`).
- HTTP later: `WebStandardStreamableHTTPServerTransport` or `createMcpHandler`, plus `@modelcontextprotocol/node`.
- The spec has a Task primitive (`ToolExecution.taskSupport`). v0.1 does not use it. See section 6.

## 2. Repository structure

```
checkout-test-mcp/
├─ CLAUDE.md
├─ README.md
├─ LICENSE                          # MIT or Apache-2.0, see Q12
├─ package.json                     # exact versions, "type": "module", bin entry
├─ tsconfig.json                    # strict, NodeNext, types: ["node"]
├─ biome.json
├─ vitest.config.ts
├─ checkout-test-mcp.config.example.yaml
│
├─ src/
│  ├─ index.ts                      # CLI: parse args, load config, start stdio. Only file that knows the transport.
│  ├─ server.ts                     # createServer(deps): McpServer. Transport-agnostic.
│  ├─ transports/
│  │  └─ stdio.ts                   # http.ts comes later, same createServer()
│  ├─ tools/                        # one file per tool: definition + handler. No business logic.
│  │  ├─ list-scenarios.ts
│  │  ├─ run-scenario.ts
│  │  ├─ get-run-result.ts
│  │  └─ compare-runs.ts
│  ├─ schemas/                      # zod schemas: tool inputs/outputs, shared types
│  ├─ errors/                       # ToolError, error code catalogue, toToolResult()
│  ├─ config/                       # load and validate config, resolve env secrets
│  ├─ safety/                       # host guard, production check, card guard, secret redaction
│  │  └─ test-cards.ts              # the only place card numbers exist. Code, not config.
│  ├─ scenarios/                    # YAML loader, zod schema, templating, registry
│  ├─ runner/                       # run queue, Playwright executor, step actions, capture
│  ├─ runs/                         # run store on disk, idempotency index
│  └─ compare/                      # diff of two run results
│
├─ scenarios/                       # shipped example scenarios
│  ├─ demo-store/
│  │  ├─ card-success.yaml
│  │  └─ card-3ds-challenge-fail.yaml
│  └─ saucedemo/
│     └─ guest-checkout-happy-path.yaml
├─ test-data/
│  └─ customers/tr-guest.yaml       # fake person, fake address
├─ schemas/
│  └─ scenario.schema.json          # generated from zod, for editor autocomplete
├─ examples/
│  └─ demo-store/                   # small local store + mock 3DS provider, see Q1
│
├─ test/
│  ├─ unit/                         # safety, templating, compare, schemas
│  ├─ integration/                  # MCP client <-> server in memory, tools/list snapshot
│  └─ e2e/                          # real browser against examples/demo-store
└─ docs/
   ├─ design.md
   ├─ tools.md
   ├─ scenario-format.md
   └─ safety.md
```

Reasons:

- `server.ts` gets all dependencies as arguments (config, run store, runner, clock). Tests start it with `InMemoryTransport`. The HTTP transport later needs only a new file in `transports/`.
- `tools/` stays thin. A tool file parses input, calls a service, and maps the result. This keeps descriptions and schemas easy to review as product text.
- `safety/` is a separate module with its own unit tests. Every path that can open a page or fill a field goes through it.
- The card registry is TypeScript, not YAML. A user cannot add a card number with a config edit. A change to the registry is a code change with review.

## 3. Config file

The agent never sends a URL. It sends a target name. The config file maps names to hosts.

```yaml
# checkout-test-mcp.config.yaml
runs_dir: .checkout-test-mcp/runs # results, screenshots, traces
max_parallel_runs: 1
scenario_dirs: [./scenarios]
test_data_dir: ./test-data

targets:
  demo-local:
    description: Bundled demo store on this machine.
    profile: demo-store # must match scenario compatible_profiles
    base_url: http://localhost:4173
    allowed_hosts: [localhost]
    third_party_hosts: [] # mock provider runs on the same host
  saucedemo:
    description: Public Sauce Labs demo store. No payment step.
    profile: saucedemo
    base_url: https://www.saucedemo.com
    allowed_hosts: [www.saucedemo.com]
    allow_unlabeled_host: true # see section 7, rule 2
  my-staging:
    description: Company staging, checkout v2 branch.
    profile: my-store
    base_url: https://staging.example-shop.test
    allowed_hosts: [staging.example-shop.test, api-staging.example-shop.test]
    third_party_hosts: [sandbox-api.iyzipay.com, sandbox-merchant.iyzipay.com]
    secrets: # name in scenario -> env var name
      basic_auth_user: STAGING_BASIC_USER
      basic_auth_pass: STAGING_BASIC_PASS
    inspect: # optional. Settings for inspect_target. All fields have defaults.
      source_dirs: [../my-storefront] # read-only code scan. Relative to this file.
      start_paths: ["/"] # crawl seeds
      product_paths: [] # optional hint: product pages to try first
      max_pages: 25 # 1..100
      probe_checkout: false # true lets the probe click add-to-cart and checkout, never pay

authoring: # optional. Without it, save_scenario refuses with AUTHORING_DISABLED.
  dir: ./scenarios/local # must be inside one of scenario_dirs
  test_data_dir_writable: false # true lets save_scenario write test data files

production_hosts: # always refused, even if listed above
  - example-shop.com
  - www.example-shop.com
```

## 4. Scenario format

The current reference is [scenario-format.md](scenario-format.md). It also covers `include` and `when`. This section keeps the original design.

Full example: [card-3ds-challenge-fail.yaml](../scenarios/demo-store/card-3ds-challenge-fail.yaml).

### 4.1 Top-level keys

| Key                   | Required | Meaning                                                                                      |
| --------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `schema_version`      | yes      | Integer. `1` for v0.1.                                                                       |
| `id`                  | yes      | Kebab-case. Unique in all scenario dirs. The agent uses it in `run_scenario`.                |
| `title`               | yes      | One line.                                                                                    |
| `summary`             | yes      | What the scenario does and what result it expects. The agent reads it in `list_scenarios`.   |
| `tags`                | no       | Free words for filters.                                                                      |
| `compatible_profiles` | yes      | Target profiles where the selectors are valid.                                               |
| `expected_outcome`    | yes      | One of `order_placed`, `payment_declined`, `validation_error`, `custom`.                     |
| `params`              | no       | Inputs the agent can set. Each has `type`, `description`, and `default` or `required: true`. |
| `data`                | no       | Named test data files.                                                                       |
| `timeouts`            | no       | `step_ms` (default 15000) and `run_ms` (default 180000).                                     |
| `ignore`              | no       | Console and network noise filters.                                                           |
| `steps`               | yes      | Ordered list.                                                                                |
| `outcome`             | no       | Final checks after the last step. Each check gets its own result.                            |

### 4.2 Param types

`string`, `integer`, `number`, `boolean`, `enum` (with `values`), `test_card` (id from the registry, with optional `constraints.behaviour`).

There is no free-text card param. A `string` param that contains a Luhn-valid 13 to 19 digit number is refused (section 7).

### 4.3 Steps

A step has an `id`, a `title`, and exactly one action key:

| Action              | Value                                                                    |
| ------------------- | ------------------------------------------------------------------------ |
| `goto`              | Path relative to `base_url`. An absolute URL must be on an allowed host. |
| `click`             | Locator.                                                                 |
| `fill`              | Locator, plus `value`.                                                   |
| `select`            | Locator, plus `option` (label or value).                                 |
| `check` / `uncheck` | Locator.                                                                 |
| `fill_form`         | List of `{ field: Locator, value }` or `{ field: Locator, select }`.     |
| `press`             | Locator, plus `key`.                                                     |
| `wait_for`          | An expectation (same shapes as `expect`).                                |

Optional step keys:

- `within: { frame: Locator }`: run the action inside an iframe.
- `then`: a short list of follow-up actions in the same step. Use it for "click and continue" pairs.
- `expect`: list of expectations. All must pass for the step to pass.
- `timeout_ms`: override for this step.
- `on_failure.hint`: author text. The result shows it in `failure.likely_causes`.

### 4.4 Locators

A locator maps one-to-one to a Playwright locator. Prefer the top rows.

| YAML                              | Playwright                                |
| --------------------------------- | ----------------------------------------- |
| `{ role, name?, level?, exact? }` | `getByRole(role, { name, level, exact })` |
| `{ test_id }`                     | `getByTestId(test_id)`                    |
| `{ label }`                       | `getByLabel(label)`                       |
| `{ placeholder }`                 | `getByPlaceholder(placeholder)`           |
| `{ text }`                        | `getByText(text)`                         |
| `{ css }`                         | `locator(css)`. Fallback only.            |

`name` can be a string or `{ matches: "<regex>" }`. The regex form helps with Turkish and English text on the same site.

### 4.5 Expectations

| Shape                                                     | Passes when                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `visible: Locator`                                        | Element is visible before the timeout.                                          |
| `hidden: Locator`                                         | Element is hidden or absent.                                                    |
| `text: { <locator keys>, equals \| contains \| matches }` | Element text matches.                                                           |
| `url: { matches \| equals }`                              | Page URL matches (glob or regex).                                               |
| `response: { method, url, status }`                       | A matching response arrived during this step. `status` can be `201` or `"2xx"`. |
| `no_response: { method, url, status }`                    | No matching response arrived during the run.                                    |

### 4.6 Templating

`{{params.x}}`, `{{data.customer.email}}`, `{{card.number}}`, `{{card.expiry}}`, `{{card.cvc}}`, `{{secrets.name}}`.

- Templates are plain substitution. No expressions, no code.
- `{{secrets.name}}` resolves through the target's `secrets` map to an env var. A missing env var stops the run before the browser starts.
- All secret and card values are registered for redaction before the run starts.
- `{{captured.name}}` is a value that a step reads from a response during the run (`capture`). It is filled in during the run and redacted like a secret. See [scenario-format.md](scenario-format.md) section 6.3.

## 5. Run lifecycle

```
run_scenario ──► validate (schema, target, scenario, params, safety)
            ──► idempotency lookup ──► existing run? return it
            ──► create run record (status: queued) ──► return run_id
                                   │
              queue (max_parallel_runs) ──► running ──► finished (verdict)
                                   │
get_run_result ◄── reads run record from disk (optional long poll, max 20 s)
```

- The run record lives in `runs_dir/<run_id>/result.json`. Screenshots and traces live in the same folder.
- The idempotency index lives in `runs_dir/idempotency.json`. The server writes it before the run starts. A crash or restart does not start a second checkout for the same key.
- A run that was `running` when the server stopped gets the verdict `error` with category `server_restarted` on the next start. The server never resumes or repeats it.

## 6. Key design choices

1. **Four tools, not more.** Targets and test cards appear in the `list_scenarios` output. A separate `list_targets` tool adds a choice for the model with no benefit. A `cancel_run` tool is a candidate for v0.2 (Q6).
2. **Target name, never URL.** The agent cannot point the server at a host. The allowlist works by construction, not only by validation.
3. **Run and result as two plain tools, not MCP Tasks.** The spec has a Task primitive. Client support is not uniform yet. Two tools work in every client today. The run store design allows a Task wrapper later.
4. **Short long poll in `get_run_result`.** `wait_s` (0 to 20) lets the agent wait for a change without a sleep tool. The cap stays well under common client timeouts.
5. **A failed checkout is not a tool error.** `get_run_result` returns `isError: false` with `verdict: "failed"`. `isError: true` means the tool call itself did not work (unknown run id, bad target). The model then knows which problem it has.
6. **Every failure carries `likely_causes` and `next_actions`.** The server knows the category (timeout, element missing, unexpected response). It gives the agent ordered hypotheses and concrete follow-up calls.
7. **Idempotency key is required.** Agents retry calls after transport errors. An optional key is a key that the model forgets. Same key and same arguments return the first run. Same key and other arguments return `IDEMPOTENCY_CONFLICT`.
8. **Params as a list, not raw JSON Schema.** Models read `{ name, type, required, default, description }` with fewer mistakes than nested JSON Schema. Each param has one level only.
9. **`detail: summary` by default.** A full result with all steps, console lines, and requests can be large. The summary keeps the failing step, relevant errors, and a short text. The agent asks for `full` when it needs more.
10. **Screenshots as files, plus one inline image.** The result lists screenshot paths and `file://` URIs. It adds the failing-step screenshot as one image block, so a model with vision sees the problem without a second call (Q4).
11. **Relevance flags on console and network data.** The runner marks an error as `relevant` when it happens in the failing step or the step before, or when it matches the scenario's response expectations. The agent reads the relevant items first.

## 7. Safety rules

The server refuses before it starts a browser. The browser layer enforces the same rules again during the run.

1. **Host allowlist.** The host guard has two layers. A request must pass both. A top-level navigation to a blocked host stops the run with verdict `blocked`.
   - **Route layer (URL level, first hops).** Every request that Playwright routes goes through `context.route('**/*')`. The guard checks the full URL against `allowed_hosts` and `third_party_hosts`. It aborts a request outside the allowlist with `blockedbyclient` and calls `onBlocked` with the frame. It lets an allowed request go on with `route.continue()`. Playwright routes only the first URL of a redirect chain, so this layer never sees a redirect hop.
   - **Proxy layer (host level, every request).** Each guarded browser uses its own forward proxy on `127.0.0.1` with a random port (`src/runner/guard-proxy.ts`). Every request of the browser goes through it, also each redirect hop, image, and stream. The bypass list is `<-loopback>`, so the proxy also checks `localhost` and `127.0.0.1`. The proxy applies the same host rule as the route layer (`isHostAllowed`): `allowed_hosts` and `third_party_hosts`, never `production_hosts`. It forwards an allowed plain http request. It tunnels an allowed CONNECT request without TLS interception. It answers 403 to any other host, so that host never gets a request. It calls `onBlocked` without a frame. For an https request, the URL has the host only, because a CONNECT tunnel has no path.
   - **Blocked redirects in a run.** The runner marks a main-frame navigation to a host outside the allowlist from the browser `request` event, because a proxy block has no frame. A blocked redirect of the run page thus ends with verdict `blocked`, and `blocked_requests` shows the redirect target. A 403 response or a failed request of a blocked host is not a network failure of the site.
   - **Unreachable hosts.** If the proxy cannot reach an allowed http host (for example connection refused or a DNS failure), it answers 502 with the header `x-checkout-test-guard-error`. The runner reads that header as `target_unreachable`. A failed CONNECT tunnel shows as `ERR_TUNNEL_CONNECTION_FAILED`, which is also `target_unreachable` unless the host was blocked.
   - **Basic auth.** The context gets `http_credentials` with `origin` set to the origin of `base_url`. The browser sends the credentials to that origin only, also after a same-host redirect. A third-party host never gets them, also when it asks for them.
   - **Blocked URLs.** The guard removes a user name and password from a blocked URL. `redactQuery` also removes them before a URL goes into a result.
2. **Production check.** A target host must satisfy one of these:
   - It is `localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, or `*.test`.
   - One host label starts with `staging`, `stage`, `stg`, `test`, `qa`, `dev`, `sandbox`, `preview`, or `uat`.
   - The target sets `allow_unlabeled_host: true`, and `production_hosts` in the config is not empty.

   A host in `production_hosts` is always refused. This check runs at config load and again for each run.
3. **Card guard.** Card values come only from `src/safety/test-cards.ts`. Each entry has the provider, the published source URL, and the behaviour. Before each `fill`, the runner checks the value. A Luhn-valid 13 to 19 digit number that is not in the registry stops the run with verdict `blocked`. The same check runs on all tool arguments.
4. **Secrets.** Secrets come from env vars named in the config. Tool arguments that look like secrets (`sk_live_`, `Bearer `, `password=`, a value equal to a known secret) are refused with `SECRET_IN_ARGUMENTS`. The logger and result writer redact all registered secret and card values. Screenshots use Playwright `mask` on password, card, and one-time code fields. A value read by `capture` is registered for redaction as soon as the runner reads it.
5. **Stdout is the protocol.** All logs go to stderr. A `console.log` in `src/` is a lint error.

## 8. Example scenarios to ship

| Scenario                              | Target             | Why                                                                             |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `demo-store/card-success`             | bundled demo store | Happy path with a frictionless test card. Baseline for `compare_runs`.          |
| `demo-store/card-3ds-challenge-fail`  | bundled demo store | 3DS challenge and decline. The full example.                                    |
| `saucedemo/guest-checkout-happy-path` | www.saucedemo.com  | Public site built for test automation. Shows a remote target. Has no card step. |

## 9. Open questions and trade-offs

Each item has my recommendation. Decide or change them before implementation.

| #   | Question                                | Options                                                                                                                      | My recommendation                                                                                                                                                                                   |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Which demo store for payment scenarios? | (a) Bundle a small local store with a mock 3DS provider. (b) Use Stripe test mode with a public demo. (c) Only public sites. | (a). Public demo stores with a real 3DS flow are rare and change without notice. A local store makes CI deterministic and needs no accounts. Keep one public target (saucedemo) to show remote use. |
| Q2  | Is the idempotency key required?        | Required or optional.                                                                                                        | Required. Safety principle beats convenience.                                                                                                                                                       |
| Q3  | Unlabeled staging hosts                 | Your company's staging host may have no `staging` label.                                                                     | Keep `allow_unlabeled_host` per target, and require a non-empty `production_hosts` list.                                                                                                            |
| Q4  | Inline screenshots                      | Inline failing-step image, all paths only, or MCP resources only.                                                            | Inline one image for the failing step. Paths for the rest. Resource URIs as an extra.                                                                                                               |
| Q5  | Where do runs live?                     | Project folder, XDG state dir, or temp dir.                                                                                  | `./.checkout-test-mcp/runs` by default, configurable. The agent can then open screenshots by path. Add retention (keep last N runs or N days).                                                      |
| Q6  | `cancel_run` in v0.1?                   | Add now or later.                                                                                                            | Later. Add it when runs get longer than about 3 minutes.                                                                                                                                            |
| Q7  | Retries inside a run                    | Auto-retry flaky steps, or never.                                                                                            | Never auto-retry a step after payment submit. Allow one retry for steps before checkout, and report it as `flaky: true`.                                                                            |
| Q8  | Real side effects on staging            | Orders on staging trigger emails, stock changes, ERP sync.                                                                   | Document it. Add an optional `teardown` step list in v0.2 (for example, cancel the order through a staging API).                                                                                    |
| Q9  | Turkish payment providers               | iyzico, PayTR, and bank virtual POS flows differ from Stripe.                                                                | Ship the registry with Stripe and iyzico published test cards. Add others only with a source URL for each card.                                                                                     |
| Q10 | TypeScript 7                            | TS 7 is the native compiler. Some tools can lag behind.                                                                      | Use 7.0.2. Fall back to TS 6.x if Biome, tsx, or Vitest show type tool problems.                                                                                                                    |
| Q11 | Node engine range                       | `>=24` or `>=26`.                                                                                                            | `engines.node: ">=24"`, develop and run CI on 26. Your machine has 22.21.1, so install 26 first.                                                                                                    |
| Q12 | License and name                        | MIT or Apache-2.0. `checkout-test-mcp` or another name.                                                                      | Apache-2.0 for the patent grant. Keep `checkout-test-mcp`.                                                                                                                                          |
| Q13 | Scenario reuse across targets           | Copy scenarios per site, or support selector overrides per profile.                                                          | Copy for v0.1. Add a `selectors` map per profile in v0.2 if duplication grows.                                                                                                                      |
| Q14 | Telemetry                               | None, or opt-in.                                                                                                             | None.                                                                                                                                                                                               |

## 10. Implementation notes (v0.1)

Decisions taken with the go-ahead on 2026-11-22. They follow the recommendations in section 9.

- Q1: the repo bundles `examples/demo-store` (no dependencies) with a mock card provider and a 3DS challenge. It also has fault injection (`skip-3ds`) so tests can show a real regression.
- Q2: `idempotency_key` is required. The request hash uses the arguments as sent, so a retry matches before any other work.
- Q11: `engines.node` is `>=22.12`, the Vitest 5 minimum. Develop on Node 26.
- Q3, Q8, Q9: still open. The card registry has Stripe and iyzico test cards. Each iyzico card cites the official page https://docs.iyzico.com/en/add-ons/test-cards. Craftgate cards are not in the registry yet, because the Craftgate docs need a login.

Format details that the design did not fix:

- `url.matches` is a glob. Use `url.regex` for a regular expression. `text.matches` and `name: { matches }` are regular expressions (`name` is case-insensitive).
- Expectations use the page scope. Use `{ within, locator }` in `visible` or `hidden`, or `within` in `text`, for an iframe. The step `within` applies only to the step actions.
- `{{card.*}}` works when the scenario has exactly one `test_card` param. Otherwise use `{{cards.<param>.*}}`.
- `role=alert` has no accessible name from its content. Check alert text with `text: { role: alert, matches: ... }`.
- Target config has `test_id_attribute` (for example `data-test` for Sauce Demo), `http_credentials` (basic auth from secrets), and `locale`.
- Screenshot `uri` values are `file://` URLs. MCP resource URIs are not registered in v0.1.

### 10.1 One-time codes (2026-11-24)

Many test environments return an SMS or email code in the API response of the page, for example `send-code`. A step reads it with `capture` and a later step fills it in.

- The runner reads only responses that the page receives. It sends no request of its own. So the host guard and the allowlist stay the only network rules.
- The value is never stored. The run record and the result show `[REDACTED]`.
- `body_regex` reads a code from a body that is not JSON, for example the `text/x-component` body of a Next.js server action. Error messages name the regex and the count of checked responses. They never show the body.
- A separate OTP service that the runner must call is out of scope. It needs a new safety review.

## 11. Authoring

Two tools let an agent write scenarios: `inspect_target` reads a test target and suggests scenarios, and `save_scenario` checks and writes a scenario, fragment, or test data file. The design is in the [scenario authoring spec](superpowers/specs/2026-11-24-scenario-authoring-design.md). The tool contract of `save_scenario` is in [tools.md](tools.md), section 7.

### Inspection jobs and browser slots

`InspectionManager` (`src/inspect/manager.ts`) runs the `inspect_target` jobs. It stores each report in `runs_dir/inspections/<id>.json` and the key index in `runs_dir/inspections/idempotency.json`, with atomic writes (temp file, then rename). The same key gives the same inspection, also after a restart. At startup, an inspection that was `queued` or `running` becomes `finished` with `interrupted: true`, and the server does not repeat it.

Runs and inspections share one `BrowserSlots` object (`src/runs/browser-slots.ts`) with `max_parallel_runs` slots. So the server never has more browsers open than the config allows. Rules:

- One inspection runs at a time. The jobs wait on one chain.
- An inspection waits for a free slot. With the default `max_parallel_runs: 1`, an inspection never runs while a run is active, and a run waits while an inspection is active.
- A freed slot goes to a waiting inspection before a queued run, so a stream of runs cannot keep an inspection waiting for ever. A run starts when the inspection frees its slot.
- A `scope: "code"` inspection takes a slot too. It is short, and one rule is simpler than two.

A phase that crashes (browser start, crawl, probe, code scan) adds a warning that starts with `INSPECTION_FAILED`. The job keeps the other parts and finishes. The warning has the error class and a short message without URLs or absolute paths.

### Checkout probe

The probe (`src/inspect/probe.ts`) goes through the checkout of a test target up to the payment step with fictional data. Every click, fill, select, and key press goes through `src/inspect/actions.ts`:

- A click needs a name that matches the step: add to cart, cart, checkout, guest, cookie reject, or continue. A list click needs the combobox or option role.
- Checkout words start the checkout only. A form step is saved only with a continue word or an explicit go-to-payment phrase, such as "Continue to payment" or "Ödemeye geç". On some shops a checkout phrase, such as "Passer la commande", places the order. Such phrases and wallet names (PayPal, Apple Pay, Klarna) are in the `pay` list.
- A click is refused when the element has no name, or when any of its texts names a pay, cookie accept, or send-code action. A click is also refused on a page with card fields or a one-time code field, and in a form with a password field.
- A fill is refused for password, card, and one-time code fields, and for a field whose label names a secret.
- One rule finds card inputs: `isCardInput` and `cardInputs()` in `src/safety/card-inputs.ts`. It reads the `cc-*` autocomplete and card hints in the name, id, placeholder, and label. The probe, the guarded actions, and the run screenshot mask all use it.
- The only key press is Escape.

The payment step has card fields in any frame, a frame that the host guard blocked, a visible terms checkbox, or a visible payment method radio or tab. A payment method is a card, wallet, cash on delivery, or bank transfer label, for example "Kapıda ödeme" or "Virement". A pay button alone counts only when no empty field is left, because express wallet buttons also show on the contact step.

The crawl and the probe keep the raw URL path, because they navigate with it. The report gets the path through `redactPath`: it removes emails, tokens, and card numbers, and keeps ids and barcodes. The crawl does not open links whose path has a data change segment, such as `remove`, `delete`, `clear`, `add`, `sil`, `temizle`, `kaldır`, or `ekle`.

`ProbeResult.dialogs` lists every native dialog and dialog element that the probe saw. `ProbeResult.steps` holds only the dialogs that a probe action opened. A dialog that is already open when a page loads, such as a cookie banner, is in `ProbeResult.dialogs` only.

The probe records a blocked frame by its URL and by its Playwright frame. It reads each child-frame navigation request from the browser `request` event and records the ones to a host outside the target. That covers a frame that the route layer blocks, and a same-host frame that redirects to a blocked host, which the proxy layer blocks. The probe lists such a frame with the blocked host. If the probe cannot read the iframes after a blocked load, it acts as if a blocked payment frame is on the page.

The probe also refuses every click on a page with a payment-like iframe whose load the host guard blocked. That frame can be a card form on a provider host that the target does not list. A blocked frame counts only when its host or title has a payment word (for example pay, card, checkout, 3ds, or a provider name), or when the text of its nearest container names a card or payment. Blocked ad, tag manager, and chat frames do not count.

Stop reasons: `payment_step_reached`, `login_required`, `no_product`, `no_add_to_cart`, `no_checkout_button`, `form_not_understood`, `timeout`, `blocked_by_safety`, and `verification_required`. The probe stops with `verification_required` when a page with a phone field says that it sends a code. It reads send-code and verification phrases, such as "SMS ile doğrulama", "doğrulama kodu", or "verification code". A bare "SMS" does not count, because a marketing consent such as "Kampanyalardan SMS ile haberdar olmak istiyorum" often stands next to the phone field. It stops before it clicks to go on.

Probe risks:

- The fictional phone number (`555` and zeros) can belong to a real subscriber. The probe never clicks a send-code button, and it stops before it continues on a page that says it sends a code to the phone.
- The probe makes a cart item, a guest checkout with an `example.test` email, an address, and possibly an unpaid order draft. `side_effects` lists them.

Known limits:

- The test id attribute is global in Playwright (`selectors.setTestIdAttribute`). Two targets with different `test_id_attribute` values that run at the same time can use the wrong attribute. With the default `max_parallel_runs: 1`, this does not occur.
- The server does not reload a symlinked subfolder of `authoring.dir` at startup. Save scenarios into real folders.
- The guard covers requests of the browser. The server code sends no request of its own with `context.request` or Node. Do not add one without a guard.
