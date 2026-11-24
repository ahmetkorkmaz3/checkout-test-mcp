# checkout-test-mcp

An MCP server that lets AI agents run end-to-end checkout and payment test scenarios against e-commerce **test environments**, and get structured results they can act on.

> "Run the 3D Secure failure scenario on staging and tell me what broke."

The agent calls `list_scenarios`, starts a run with `run_scenario`, reads the verdict with `get_run_result`, and checks a deploy with `compare_runs`. A failed checkout comes back as a result with a failing step, a category, likely causes, next actions, a screenshot, and the relevant console errors and network failures.

Status: v0.1. Stdio transport. Scenarios in YAML. Playwright (Chromium).

## Safety

- The agent sends a **target name**, never a URL. Targets come from the config file.
- Every browser request goes through a host allowlist. A request to another host is blocked. A navigation to another host stops the run with verdict `blocked`.
- A host must look like a test environment (`localhost`, `*.test`, or a label such as `staging`, `qa`, `sandbox`). Hosts in `production_hosts` are always refused.
- Card values come only from a built-in registry of payment providers' published test cards. A card number in a tool argument or a scenario file is refused.
- Secrets come from environment variables named in the config. Secret-like tool arguments are refused. Logs and results are redacted.

## Quick start

Requirements: Node.js 22.12 or later (26 recommended).

```bash
npm ci
npx playwright install chromium
cp checkout-test-mcp.config.example.yaml checkout-test-mcp.config.yaml
npm run build
npm run demo-store
```

Add the server to Claude Code (run in this folder):

```bash
claude mcp add checkout-test -- node dist/index.js --config ./checkout-test-mcp.config.yaml
```

Then ask: "Run card-3ds-challenge-fail on demo-local."

To see regression detection, restart the demo store with a bug and run the scenario again:

```bash
DEMO_STORE_BUGS=skip-3ds npm run demo-store
```

Then ask the agent to compare the two runs.

Other bug flags: `cookie-banner` shows a consent dialog over every page. `login-wall` removes the guest checkout. The checkout probe tests use them.

## Tools

| Tool             | What it does                                                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_scenarios` | Lists scenarios, targets, and test card ids. Call it first.                                                                                                                |
| `run_scenario`   | Starts a run in the background and returns a `run_id` at once. Needs an `idempotency_key`: the same key never starts a second checkout.                                    |
| `get_run_result` | Status, verdict (`passed`, `failed`, `error`, `blocked`), failing step, likely causes, next actions, screenshots, console and network failures. `wait_s` waits up to 20 s. |
| `compare_runs`   | Diffs two runs of the same scenario and reports regressions, fixes, and slower steps.                                                                                      |

Full definitions: [docs/tools.md](docs/tools.md).

## Scenarios

Scenarios are YAML files with steps, Playwright-style locators, expectations, and final outcome checks. See [card-3ds-challenge-fail.yaml](scenarios/demo-store/card-3ds-challenge-fail.yaml) and the format in [docs/scenario-format.md](docs/scenario-format.md). Fragments (`include`) and conditions (`when`) let one scenario cover guest and member checkouts. Editors can use [schemas/scenario.schema.json](schemas/scenario.schema.json) for autocomplete.

Shipped examples:

| Scenario                   | Target                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `card-success`             | bundled demo store                                                                                      |
| `card-3ds-challenge-fail`  | bundled demo store                                                                                      |
| `saucedemo-guest-checkout` | www.saucedemo.com (needs `SAUCEDEMO_USERNAME` and `SAUCEDEMO_PASSWORD`, shown on the site's login page) |

## Development

```bash
npm test            # unit + integration
npm run test:e2e    # real browser against the demo store
npm run lint
npm run typecheck
npm run smoke       # build and call the server over stdio
```

Project rules: [CLAUDE.md](CLAUDE.md).

## License

Apache-2.0
