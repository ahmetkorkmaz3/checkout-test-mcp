# Production Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user run scenarios on a production target, with a warning and a per-run confirmation, and with live cards from env vars.

**Architecture:** A new `environment` field on the target relaxes the production and label checks for that target only. Live cards resolve from env at run start and join the per-run card allowlist and redactor. `run_scenario` gates each new production run on `confirm_production: true`.

**Tech Stack:** TypeScript 7, zod 4, MCP SDK v2 (`@modelcontextprotocol/server` 2.4.0), Playwright 1.65.1, vitest 5, biome.

**Spec:** `docs/superpowers/specs/2026-11-24-production-targets-design.md`

## Global Constraints

- Read `CLAUDE.md` first. Its hard rules bind every task.
- No real card number, real customer data, or real company host in code, tests, fixtures, or docs. Use hosts like `www.shop.example` or `localhost`. In tests, use a registered Stripe test number as the env value of a live card.
- Never write to stdout in `src/`.
- A live card number, expiry, or CVC never appears in an error message, log, result, or snapshot.
- Tool names, params, output fields: snake_case.
- `npm run typecheck`, `npm run lint`, and `npm test` pass at the end of each task.
- Prose in docs, comments, error messages, and descriptions: ASD-STE100 (short sentences, active voice, no semicolons, no contractions).

## Review Focus

- A test target with a production host must still fail config load.
- A production target must not open a host outside its `allowed_hosts` and `third_party_hosts`, also when that host is in `production_hosts`.
- A `live/<name>` id on a test target must fail with `INVALID_PARAMS`.
- An unregistered card number that is not a live card of this run must still stop the run with `blocked_by_safety`.
- A retry with the same idempotency key and without `confirm_production` must return the existing run.

---

### Task 1: Config schema and host checks

**Files:**
- Modify: `src/schemas/config.ts`, `src/config/load-config.ts`, `src/safety/hosts.ts`, `src/inspect/manager.ts` (refusal block near line 330), and the matching production check in `src/runs/manager.ts` if one exists.
- Test: `test/unit/` (the existing config and hosts test files).

**Interfaces:**
- Produces: `TargetConfig.environment: 'test' | 'production'` (default `'test'`), `TargetConfig.live_cards: Record<string, LiveCardConfig>` (default `{}`), `LiveCardConfig = { number_env, expiry_env, cvc_env, behaviour: CardBehaviour, description: string }`. Env names match `^[A-Z][A-Z0-9_]*$`. Live card names match `^[a-z0-9][a-z0-9-]*$`.
- Produces: `isProductionTarget(target: TargetConfig): boolean` in `src/safety/hosts.ts`.

- [ ] **Step 1: Write failing tests**
  - Config load accepts a production target whose base_url host and allowed_hosts are in `production_hosts` (`www.shop.example`).
  - Config load accepts a production target with an unlabeled host and an empty `production_hosts`.
  - Config load still refuses a test target with a host in `production_hosts` (existing test stays).
  - Config load refuses `live_cards` on a test target. Message names the target and says `live_cards needs environment: production`.
  - `isHostAllowed('www.shop.example', prodTarget, cfg)` is true when the host is in the target `allowed_hosts` and in `production_hosts`.
  - `isHostAllowed('api.other.example', prodTarget, cfg)` is false when the host is in `production_hosts` but not in the target lists.
  - `isHostAllowed` for a test target and a production host stays false.
  - `checkTargetHost` returns `{ ok: true }` for a production target host.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run test/unit`
- [ ] **Step 3: Implement.** In `checkTargetHost` and `isHostAllowed`, skip the production and label rules when `target.environment === 'production'`. The allowlist rule stays. In `validateTargets`, skip the third-party production check for production targets, and add the `live_cards` refusal. The inspect manager refusal then passes for production targets with no other change.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `Allow production hosts on production targets`.

### Task 2: Live cards at run time

**Files:**
- Modify: `src/scenarios/params.ts`, `src/runs/manager.ts` (`prepare`), `src/runner/executor.ts` (`guardValue`, `ExecuteInput`), `src/safety/test-cards.ts` only if a shared card type is needed.
- Test: `test/unit/scenarios.test.ts`, the run manager unit tests.

**Interfaces:**
- Consumes: Task 1 `TargetConfig.live_cards`, `isProductionTarget`.
- Produces: `RunCard = Pick<TestCard, 'id' | 'provider' | 'brand' | 'number' | 'expiry' | 'cvc' | 'behaviour' | 'description'>`. `resolveParams(scenario, input, liveCards?: Record<string, RunCard>)` where keys are full ids (`live/company-visa`). `ExecuteInput.allowedCardNumbers: ReadonlySet<string>`.

- [ ] **Step 1: Write failing tests**
  - `resolveParams` with `card: 'live/company-visa'` and a matching live card returns that card in `cards.card` and `values.card === 'live/company-visa'`.
  - `resolveParams` with `card: 'live/nope'` throws `INVALID_PARAMS`. With no `liveCards` argument, `live/company-visa` throws `INVALID_PARAMS` whose message says live cards need a production target.
  - The `behaviour` constraint refuses a live card with another behaviour.
  - Run manager: a production target, live card env vars set (number = `4242424242424242`, expiry `12 / 34`, cvc `123`), param `live/company-visa` → run is prepared, and the redactor redacts the number and expiry.
  - Run manager: a missing live card env var → `MISSING_ENV_SECRET`, details list the env name, no value.
  - Run manager: env number `1234` → `MISSING_ENV_SECRET`, message says not a valid card number, no digits from the value.
  - Run manager: `options.trace: true` on a production target → `INVALID_PARAMS`.
  - Executor guard: a fill value equal to a number in `allowedCardNumbers` passes. Use a Luhn-valid unregistered number that only the test builds at run time (for example compute it in the test), so no new literal card number enters the repo. Another unregistered number still gives `blocked_by_safety`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** The manager reads `live_cards` env only for live ids that the params name, after `resolveParams` validation of the id. Do not read the env of unused live cards. Pass the live numbers as `allowedCardNumbers`. `guardValue` accepts a card span whose digits are in that set.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm test`.
- [ ] **Step 5: Commit** `Resolve live cards from env on production targets`.

### Task 3: Confirmation, warnings, prompts, and docs

**Files:**
- Modify: `src/errors/tool-error.ts` (code `PRODUCTION_CONFIRMATION_REQUIRED`), `src/tools/run-scenario.ts`, `src/runs/manager.ts` (`start`), `src/tools/list-scenarios.ts`, `src/inspect/manager.ts` or `src/inspect/report.ts` (warning), `src/prompts/setup-checkout-tests.ts`, `src/prompts/create-scenario.ts`, `CLAUDE.md` (principle 1), `docs/tools.md`, `docs/design.md`, `README.md` (config example), `test/integration/__snapshots__/tools-list.json`.
- Test: integration tests over `InMemoryTransport`, unit tests for the manager.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `PRODUCTION_WARNING` constant (one place) with the text: `Production target. A run here can make a real order and a real payment, change stock, start shipping, and send email or SMS to real addresses. Ask the user before each run.`

- [ ] **Step 1: Write failing tests**
  - `run_scenario` on a production target without `confirm_production` → `isError`, code `PRODUCTION_CONFIRMATION_REQUIRED`, `next_actions` has an `ask_human` item and a `change_argument` item with `arguments: { confirm_production: true }`. No run record is written.
  - Same call with `confirm_production: true` → a run starts. Output has `environment: 'production'` and `warning` equal to `PRODUCTION_WARNING`.
  - A second call with the same key and without the flag → `reused_existing_run: true`.
  - `confirm_production` on a test target has no effect, and the output has `environment: 'test'` and no `warning`.
  - `list_scenarios` lists `environment`, `warning`, and `live_cards` (`id`, `behaviour`, `description`) for a production target. The JSON has no digits of the live card.
  - `inspect_target` on a production target starts (no `PRODUCTION_HOST_REFUSED`) and `warnings[0]` is `PRODUCTION_WARNING`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Check the flag in `start` after the early idempotency check and before `prepare` writes anything. Keep the flag out of the request hash. Update the tool descriptions: `run_scenario` says production targets need `confirm_production: true` after the user agrees. `list_scenarios` says a `test_card` param also takes a `live/<name>` id from a production target. Prompts: on a production target, show the warning to the user and ask before each `run_scenario`. Never set `confirm_production` without the user's yes in this conversation.
- [ ] **Step 4: Docs.** `docs/tools.md`: new input, outputs, error code. `docs/design.md`: a section on production targets. `CLAUDE.md` principle 1: test targets refuse production hosts; production targets need `environment: production`, a warning, and a per-run confirmation; live cards only from env. README: a short config example with `www.shop.example`.
- [ ] **Step 5: Snapshot.** `npx vitest run -u test/integration`, then read the diff of `tools-list.json`. Only the intended description and schema changes may appear.
- [ ] **Step 6: Run** `npm run typecheck && npm run lint && npm test && npm run test:e2e`.
- [ ] **Step 7: Commit** `Ask for confirmation before each production run`.
