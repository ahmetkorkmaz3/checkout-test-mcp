# Contributing

Thank you for your help. This file tells you how to set up the project and what a pull request needs.

## Set up

Requirements: Node.js 22.12 or later (26 recommended).

```bash
npm ci
npx playwright install chromium
npm test
```

To run the server against the bundled demo store:

```bash
npm run demo-store
npm run dev -- --config ./checkout-test-mcp.config.yaml
```

Copy `checkout-test-mcp.config.example.yaml` to `checkout-test-mcp.config.yaml` first.

## Before you open a pull request

1. Run `npm run typecheck`, `npm run lint`, and `npm test`. All three must pass.
2. Run `npm run test:e2e` when you change the runner, a scenario, or the demo store.
3. If you change a tool description or schema, update `docs/tools.md` and the `tools/list` snapshot. Review the snapshot diff before you run `npx vitest run -u`.
4. If you change the scenario format, update `docs/scenario-format.md` and run `npm run schema`.
5. If you add a safety rule or an error code, add a unit test for each refuse path.

The full project rules are in [CLAUDE.md](CLAUDE.md). They apply to people and to AI agents.

## Hard rules

- Never add a real card number, real customer data, or a real company host. Use `example.test` hosts and fictional data.
- Add a test card only with the published source URL of the payment provider.
- Never write to stdout in `src/`. Stdout is the MCP channel. Use the logger.
- Do not loosen a safety check to make a test pass.
- Pin exact versions in `package.json`. Do not use `^` or `~`.

## Add a scenario

1. Put the YAML file in `scenarios/<profile>/<id>.yaml`.
2. Give every param a `description` and a `default`, or `required: true`.
3. Use `test_card` params for cards. Never write a card number.
4. Add `on_failure.hint` to steps where the cause of a failure is not obvious.

See [docs/scenario-format.md](docs/scenario-format.md).

## Add a tool

The server has six tools on purpose. Open an issue before you add a tool, so that we can agree on the design first.

## Commit messages

Write a short subject line in the imperative mood, for example "Add a timeout to the 3DS step". Explain why in the body when the reason is not obvious.
