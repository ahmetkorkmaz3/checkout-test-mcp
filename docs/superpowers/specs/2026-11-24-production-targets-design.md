# Production targets: design

Status: approved by the user on 2026-11-24 (chat). Branch: `feat/scenario-authoring` (PR 4).

## Intent

A user can run the scenarios on the live site when they want to. The server warns about the side effects. It does not refuse the run. The user can supply a live test account and a live card through env vars.

## Goals

- A target can say `environment: production`. That target may use hosts that are in `production_hosts`.
- A production target can declare `live_cards`. The card number, expiry, and CVC come from env vars only.
- A scenario selects a live card with the id `live/<name>` in a `test_card` param, at run time.
- `run_scenario` needs `confirm_production: true` for every new run on a production target.
- `list_scenarios`, `run_scenario`, and `inspect_target` show a warning about side effects for a production target.
- The prompts tell the agent to ask the user before each production run.

## Non-goals

- No change to the host guard rule: only `allowed_hosts` and `third_party_hosts`.
- No card numbers in YAML, tool arguments, logs, results, or snapshots. This rule does not change.
- The probe of `inspect_target` still never clicks a pay button.
- No automatic cancel or refund of live orders.

## Anti-goals

- A test target must never reach a production host by accident. A test target with a host in `production_hosts` stays a config error.
- A live card number must never leave the process in clear text.

## Decisions

1. `TargetConfig.environment: 'test' | 'production'`, default `'test'`.
2. Host checks for a production target: no test-label rule and no `production_hosts` refusal for its own `allowed_hosts` and `third_party_hosts`. The guard still allows only the hosts in these two lists. A test target keeps every current check.
3. `live_cards` is allowed only on a production target. Config load refuses it on a test target. Each entry: `number_env`, `expiry_env`, `cvc_env`, `behaviour` (CardBehaviour), `description` (default `''`). Entry names match `^[a-z0-9][a-z0-9-]*$`.
4. The run manager resolves a `live/<name>` card at run start from env. A missing env var gives `MISSING_ENV_SECRET`. A number that is not 13 to 19 digits with a valid Luhn check also gives `MISSING_ENV_SECRET` with a message that says the value is not a valid card number. The message never holds the value.
5. A `live/<name>` id on a test target, or an unknown live name, gives `INVALID_PARAMS`. The `behaviour` constraint of the param applies to live cards too. Scenario defaults stay test card ids.
6. The executor card guard accepts the numbers of the live cards of this run, and no other unregistered number. The redactor registers the live number and expiry. Screenshots keep the current card input mask.
7. `options.trace: true` on a production target gives `INVALID_PARAMS`. A trace holds DOM snapshots with typed values.
8. `run_scenario` input `confirm_production: boolean` (optional, default false). A new run on a production target without `true` gives the new error code `PRODUCTION_CONFIRMATION_REQUIRED`, `retryable: false`, with an `ask_human` next action and a `change_argument` next action that sets `confirm_production: true`. The flag is not part of the request hash. A reused run for an existing key needs no flag. On a test target the flag has no effect.
9. Outputs: `list_scenarios.targets[]` gets `environment`, `warning` (string, only for production), and `live_cards` (`id`, `behaviour`, `description`, no digits). `run_scenario` output gets `environment` and an optional `warning`. `inspect_target` puts the production warning first in `warnings`. It needs no confirmation, because the probe never pays.
10. The warning text names the side effects: a real order, a real payment, stock changes, shipping, and emails or SMS to real addresses.
11. `PRODUCTION_HOST_REFUSED` stays for test targets.
12. CLAUDE.md principle 1, `docs/design.md`, and `docs/tools.md` describe the new rule.
