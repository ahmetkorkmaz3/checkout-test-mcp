# checkout-test-mcp

An MCP server that lets AI agents run end-to-end checkout and payment test scenarios against e-commerce **test environments**, and get structured results they can act on.

> "Run the 3D Secure failure scenario on staging and tell me what broke."

The agent calls `list_scenarios`, starts a run with `run_scenario`, reads the verdict with `get_run_result`, and checks a deploy with `compare_runs`. A failed checkout comes back as a result with a failing step, a category, likely causes, next actions, a screenshot, and the relevant console errors and network failures.

Status: v0.1. Stdio transport. Scenarios in YAML. Playwright (Chromium).

## Safety

- The agent sends a **target name**, never a URL. Targets come from the config file.
- Every browser request goes through a host allowlist. A request to another host is blocked. A navigation to another host stops the run with verdict `blocked`.
- A host must look like a test environment (`localhost`, `*.test`, or a label such as `staging`, `qa`, `sandbox`). A test target refuses hosts in `production_hosts`.
- A production target needs `environment: production`. Each tool shows a warning for it, and each new run needs `confirm_production: true` after the user says yes. See [Production targets](#production-targets).
- Card values come only from a built-in registry of payment providers' published test cards. A card number in a tool argument or a scenario file is refused.
- Secrets come from environment variables named in the config. Secret-like tool arguments are refused. Logs and results are redacted.

## Production targets

You can run the scenarios on the live site. A run there makes a real order and a real payment, changes stock, starts shipping, and sends email or SMS to real addresses. The server does not cancel or refund the order.

```yaml
production_hosts: [www.shop.example]

targets:
  shop-live:
    environment: production
    profile: my-store
    base_url: https://www.shop.example
    allowed_hosts: [www.shop.example]
    live_cards:
      company-visa:
        number_env: SHOP_LIVE_CARD_NUMBER
        expiry_env: SHOP_LIVE_CARD_EXPIRY
        cvc_env: SHOP_LIVE_CARD_CVC
        behaviour: success
```

1. Set the three env vars for the MCP server process. Never put a card number in the config.
2. Pass `card: live/company-visa` as a param of `run_scenario`.
3. The agent asks you before each run. It sends `confirm_production: true` only after you say yes.

Details: [docs/design.md, section 12](docs/design.md#12-production-targets).

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
| `inspect_target` | Reads a test target (site and, when configured, source code) and suggests scenarios with evidence. One tool starts the job and long polls it with the same key.           |
| `save_scenario`  | Checks and writes a scenario, fragment, or test data file, and can start a validation run.                                                                                 |

Full definitions: [docs/tools.md](docs/tools.md).

## Authoring and inspection

An agent can write scenarios for a new target. It calls `inspect_target`, reads the suggested scenarios and warnings, writes the YAML, and saves each file with `save_scenario`. Two config blocks turn this on:

```yaml
authoring:
  dir: ./scenarios/local # save_scenario writes here. Must be inside one of scenario_dirs.
  test_data_dir_writable: false

targets:
  my-staging:
    # ...
    inspect:
      source_dirs: [../my-storefront] # optional, read-only code scan
      start_paths: ["/"]
      max_pages: 25
      probe_checkout: false
```

- Without `authoring`, `save_scenario` refuses with `AUTHORING_DISABLED`.
- Without `inspect`, `inspect_target` crawls from `/` with defaults, skips the code scan, and does not run the checkout probe.
- `probe_checkout: true` lets the probe go to the payment step with fictional data. It never pays. On the test site it makes a cart item, a guest account with an `example.test` email, an address, and possibly an unpaid order draft. Turn it on only when this is acceptable.
- Reports go to `runs_dir/inspections/<id>.json`.

## Set up a new shop

The server has an MCP prompt that sets up the checkout tests of a new shop with no human help. The agent asks you only for what the tools cannot find.

1. Add a target and the `authoring` and `inspect` blocks to the config:

   ```yaml
   authoring:
     dir: ./scenarios/local # inside one of scenario_dirs
     test_data_dir_writable: true # lets the agent write a fictional customer file

   targets:
     my-staging:
       profile: my-store
       base_url: https://staging.example-shop.test
       allowed_hosts: [staging.example-shop.test]
       third_party_hosts: [] # the agent asks you to add the payment and 3D Secure hosts
       secrets:
         member_email: SHOP_MEMBER_EMAIL # for the member scenario
         member_password: SHOP_MEMBER_PASSWORD
       inspect:
         source_dirs: [../my-storefront] # optional
         probe_checkout: true
   ```

2. Set the secrets as environment variables before you start the server. Never paste a password into the chat. The agent tells you the names when one is missing.
3. Run the prompt `setup_checkout_tests` with the target name. In Claude Code: `/setup_checkout_tests my-staging` (the client can show it with a server prefix).

The server reads the config once. After a config change, restart the server. The agent waits for the restart before it runs card scenarios.

The first setup inspects the target, writes the fragments, and writes and runs the baseline scenarios: guest card, declined card, terms required, and member card, when the report has the evidence. It tries each scenario at most 3 times. It ends with a table of each scenario, what it proves, its verdict, and its run id. Then it lists the offers (for example OTP login, gift card), the missing inputs, and the files. Commit the files yourself.

For one more scenario later, run the prompt `create_scenario` with the target and a request, for example "a declined card shows an error". See [docs/tools.md](docs/tools.md#9-prompts).

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

MIT. See [LICENSE](LICENSE).
