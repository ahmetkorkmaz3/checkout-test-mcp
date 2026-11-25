# CLAUDE.md: checkout-test-mcp

## Goal

An MCP server that lets AI agents run end-to-end checkout and payment test scenarios against e-commerce test environments, and get structured results they can act on without a human.

Example request this server must support:
"Run the 3D Secure failure scenario on staging and tell me what broke."

Status: v0.1 implemented (2026-11-22). Read `docs/design.md` and `docs/tools.md` before you change a tool, the scenario format, or a safety rule.

## Principles (in priority order)

1. **Safety first.** Only hosts on the config allowlist. Only published test cards from `src/safety/test-cards.ts`. A test target refuses production hosts. A production target needs `environment: production`, shows a warning, and needs a confirmation for each run. Live cards come only from env vars. Refuse anything else that looks like real card data. Secrets come from env vars only. They never appear in tool arguments, logs, results, or test snapshots.
2. **Tool descriptions and schemas are product design.** Write them so a model picks the right tool and fills params correctly on the first try. Treat a change to them like a UI change: review the `tools/list` snapshot diff.
3. **Structured errors.** Every `ToolError` has `code`, `message`, `likely_cause`, `retryable`, and at least one `next_actions` item. A failed checkout is a result (`verdict: "failed"`), not a tool error.
4. **Never block a tool call for minutes.** Long work is `run_scenario` plus `get_run_result`, or `inspect_target`, one tool that starts the job and long polls it (same key, same job). Long poll is 20 s maximum.
5. **Same idempotency key = same run.** Never start a second checkout for a key that has a run, also after a restart.
6. **Small scope.** v0.1 has six tools: `list_scenarios`, `run_scenario`, `get_run_result`, `compare_runs`, `inspect_target`, `save_scenario`. Ask before you add a tool.

## Hard rules for agents working in this repo

- Never add a real card number, real customer data, or a real company host to code, tests, fixtures, examples, or docs.
- Add a test card only with the provider's published source URL in the registry entry.
- Never write to stdout in `src/`. Stdout is the MCP stdio channel. Use the logger, which writes to stderr.
- Never log a resolved template value. Log the template (`{{secrets.basic_auth_pass}}`), not the value.
- Never pass a URL from a tool argument to the browser. Tools accept target names only.
- Do not loosen a safety check to make a test pass. Fix the test or ask.

## Tech and versions

Pin exact versions in `package.json` (no `^` or `~`). Check the registry before you upgrade. Do not trust memory for versions or APIs.

| Package                        | Version                                            |
| ------------------------------ | -------------------------------------------------- |
| Node.js                        | `>=22.12` in engines (Vitest 5 minimum), 26.x in dev and CI |
| `@modelcontextprotocol/server` | 2.4.0 (SDK v2, not `@modelcontextprotocol/sdk` v1) |
| `playwright`                   | 1.65.1 (library, not `@playwright/test`)           |
| `zod`                          | 4.6.7                                              |
| `yaml`                         | 2.9.1                                              |
| `typescript`                   | 7.0.2                                              |
| `vitest`                       | 5.1.1                                              |
| `tsx`                          | 4.23.15                                            |
| `@biomejs/biome`               | 2.6.8                                              |

SDK v2 usage:

- `server.registerTool(name, { title, description, inputSchema: z.object(...), outputSchema: z.object(...), annotations }, handler)`.
- Do not use the deprecated raw-shape form (`inputSchema: { a: z.string() }`).
- Return `structuredContent` that matches `outputSchema`, plus a text block for clients that ignore structured content.
- Stdio transport: `@modelcontextprotocol/server/stdio`.

## Architecture rules

- `src/server.ts` exports `createServer(deps)`. It knows nothing about the transport. Only `src/index.ts` and `src/transports/*` do.
- `src/tools/*` files are thin: parse, call a service, map the result. No Playwright calls in tool files.
- zod schemas in `src/schemas/` are the single source of truth. Generate `schemas/scenario.schema.json` from them. Do not edit it by hand.
- Every path that opens a page, sends a request, or fills a field goes through `src/safety/`.
- Errors: throw `ToolError` with a code from the catalogue in `src/errors/`. `toToolResult()` turns it into `{ isError: true, structuredContent, content }`. Add a new code to the catalogue and to `docs/tools.md` in the same change.
- Run state lives on disk in `runs_dir`. The server must survive a restart without a second checkout.

## Conventions

- ESM only (`"type": "module"`), `NodeNext` module resolution, `strict: true`, `noUncheckedIndexedAccess: true`.
- File names: kebab-case. Types and zod schemas: PascalCase. Functions: camelCase.
- Tool names, param names, output fields, and YAML keys: snake_case.
- Scenario ids: kebab-case, unique in all scenario dirs.
- No default exports.
- Prefer Playwright role, test id, and label locators. CSS locators are a fallback.
- Comments explain why, not what.

## Commands

```bash
npm ci
npx playwright install chromium
npm run demo-store                                        # demo store on http://localhost:4173
npm run dev -- --config ./checkout-test-mcp.config.yaml   # tsx, stdio
npm run build                                             # tsc to dist/
npm run typecheck
npm run lint                                              # biome check
npm run format                                            # biome format --write
npm test                                                  # vitest: unit + integration (no browser)
npm run test:e2e                                          # real Chromium against examples/demo-store
npm run schema                                            # regenerate schemas/scenario.schema.json
npm run smoke                                             # build, start over stdio, call list_scenarios
node dist/index.js init --dir ./my-tests                  # starter config, demo scenarios, Chromium (--skip-browser)
node dist/index.js demo-store --port 4173                 # demo store from the built package
```

Update `test/integration/__snapshots__/tools-list.json` with `npx vitest run -u` only after you review the diff.

## Tests

- Unit: safety (host guard, production check, card guard, redaction), templating, scenario schema, compare logic. Safety code needs a test for each refuse path.
- Integration: an MCP client talks to `createServer()` over `InMemoryTransport`. Includes a snapshot of `tools/list`.
- E2E: real Chromium against `examples/demo-store`. No test calls a remote host. The demo store has fault injection (`setBugs(['skip-3ds'])`, or `DEMO_STORE_BUGS=skip-3ds`) to test regression detection.
- A test that needs a secret reads it from env and skips with a clear message when it is missing.

## Definition of done for a change

1. `npm run typecheck`, `npm run lint`, and `npm test` pass.
2. A change to a tool description or schema has an updated `tools/list` snapshot and an updated `docs/tools.md`.
3. A change to the scenario format has an updated `docs/scenario-format.md`, regenerated JSON Schema, and still-valid example scenarios.
4. A new safety rule or error code has unit tests for the refuse path.
5. No secret, card number, or real host appears in the diff.

## Adding a scenario

1. Put the YAML file in `scenarios/<profile>/<id>.yaml`.
2. Give every param a `description` and a `default`, or `required: true`.
3. Use `test_card` params for cards. Never write a card number.
4. Add `on_failure.hint` to steps where the cause of a failure is not obvious.
5. Run `npm run test:e2e` or run the scenario with MCP Inspector against the demo store.
