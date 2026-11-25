# Public release: design

Status: approved by the user on 2026-11-25 (chat).

## Intent

Anyone can install and use `checkout-test-mcp` with one command or one click. The user wants a public release. The source, the package, and the registry entry are public.

## Goals

1. A public GitHub repo with the full commit history, after a rewrite that removes all private data.
2. An npm package `checkout-test-mcp`. A user starts it with `npx -y checkout-test-mcp --config <path>`.
3. A Claude Desktop extension (`.mcpb`). A user installs it with a double click and fills a form.
4. An entry in the MCP Registry.
5. A command `checkout-test-mcp init` that makes a working setup in an empty folder.
6. A release workflow that runs on a version tag.

## Non-goals

- No hosted server (no HTTP transport for the public). Stdio only.
- No private scenarios. The company scenarios stay in their own private repo.
- No change to the safety rules or the six tools.

## Anti-goals

- Private data in the public repo, in the package, or in the `.mcpb` file. This includes the name of the first customer, its product paths, and local folder paths.
- A secret in the `.mcpb` manifest, in a workflow file, or in a release log.
- An npm token or a registry token in the repo or in this chat.

## Constraints

- CLAUDE.md rules stay: no stdout in `src/` (the `init` command also writes to stderr), exact versions, no real hosts or real cards.
- Tool versions from the npm registry on 2026-11-25: `@anthropic-ai/mcpb` 2.1.2, `mcp-publisher` 0.4.2. Check them again before use.
- The npm name `checkout-test-mcp` is free on 2026-11-25.

## Approaches (for the repo)

1. A new repo with one clean first commit. Lowest risk. Loses the history.
2. **Rewrite the history and push it to a new public repo. Picked by the user.** Keeps the 53 commits.
3. Keep the repo private and publish only the package. Users cannot read the code.

### Why the rewrite goes to a new repo

GitHub keeps the old commits of a pull request reachable by their SHA, also after a force push. The 4 pull requests of the private repo also hold the private name in their descriptions. So we do not make the old repo public. We push the rewritten history to a new public repo. The old repo stays private and is archived.

## Decisions

### History rewrite (last step, after all other work is merged)

- Tool: `git filter-repo` with a `--replace-text` file and a `--replace-message` file. Install it with Homebrew.
- Work on a fresh mirror clone, not on the working copy.
- Rules: every case of the first customer name becomes `acme`. The real product path becomes `/urun/example-tabak-19-cm`. A local path `/home/<name>/...` becomes `~/work/...`.
- Keep only `main`. Drop the other branches.
- Check before the push: scan every blob and every commit message of the new history with the pattern list below. The scan must find zero hits. `npm ci && npm test` must pass on the new `main`.
- Pattern list: the customer name (any case), the real product path, `/home/`, the work email domain, `sk_live`, `pk_live`. Published test card numbers are allowed.
- The replace file and the pattern list name private data. They stay in the session scratchpad and never enter a repo. The controller writes them, not a subagent.
- Before the rewrite, the same scan runs on the files that `npm pack` ships (`scenarios`, `test-data`, `schemas`, `examples/demo-store`).
- The private repo gets the name `checkout-test-mcp-private`. The new public repo gets `checkout-test-mcp`. The user does the rename and the archive, or approves each one.

### npm package

- Unscoped name `checkout-test-mcp`. Add `mcpName: io.github.ahmetkorkmaz3/checkout-test-mcp`, `repository`, `homepage`, `bugs`, and `keywords` to `package.json`.
- License: MIT (decided by the user on 2026-11-25). It replaces Apache-2.0. Add a `LICENSE` file with the MIT text and `Copyright (c) 2026 Ahmet Korkmaz`. Set `license: MIT` in `package.json` and in the `.mcpb` manifest. Update the license line in `README.md` and the Q12 row in `docs/design.md`.
- Add `examples/demo-store` to `files`. Add the subcommand `checkout-test-mcp demo-store [--port 4173]`. It starts the bundled demo store. My call: without it, an `npx` user has no target for the first run. A CLI subcommand is not an MCP tool, so the six-tool rule does not apply.
- Add a test that runs `npm pack --dry-run --json` and fails on a file outside the allow list.
- The release workflow publishes with npm trusted publishing (OIDC) and provenance. No npm token in GitHub secrets. If npm needs a first manual publish before trusted publishing works, the user does that publish.

### `init` command

- `checkout-test-mcp init [--dir <path>]` (default: the current folder).
- It copies the example config to `checkout-test-mcp.config.yaml`, and the example scenarios and test data to `scenarios/` and `test-data/`. It never overwrites a file. It stops with a clear message if a file exists.
- It runs the `playwright install chromium` command of the bundled Playwright package. Playwright skips the download if the browser is already there. The flag `--skip-browser` skips this step.
- It writes all messages to stderr. At the end, it shows the next steps: the client config snippet for `npx` and the demo store command.

### Browser choice (decided by the user: use the system Chrome)

- New config field `browser`: `auto` (default), `chromium`, or `chrome`.
- `auto`: use the Playwright Chromium if it is installed. If not, use the installed Google Chrome (Playwright `channel: 'chrome'`). If neither exists, give a clear error with the install command.
- `chromium` and `chrome` use only that browser. They never fall back.
- The run result gets `browser: { name, version }`. A result must show which browser ran it, because results can differ between browsers.
- `compare_runs` adds a note when the two runs used different browsers.
- `src/runner/classify.ts` already has a hint for a missing browser. Update it to name both ways: install Google Chrome, or run `npx checkout-test-mcp init`.
- If a new error code is necessary, add it to the catalogue and to `docs/tools.md` with a unit test.
- These are output and config schema changes. Update the `tools/list` snapshot, `docs/tools.md`, and the config docs.

### Desktop extension (`.mcpb`)

- `manifest.json` at the repo root. Server type `node`. Entry `dist/index.js`.
- `user_config`:
  - `config_path` (type file, required): the config file.
  - `env_file` (type file, optional): a dotenv file with the secrets.
- The pack step runs on a clean `npm ci --omit=dev` tree, so the bundle holds the runtime dependencies. No bundler.
- New config field: `env_file` (CLI flag `--env-file`). The server reads the file at start and adds the values to its own env. The values never go to logs, tool arguments, or results. Env vars that are already set win. A relative path resolves against the folder of the config file. A missing or unreadable file stops the start with a clear error. The CLI keeps its default config path. The `.mcpb` makes `config_path` required. This is my call. It solves one problem: Desktop does not pass the shell env to an extension, and the manifest cannot know the secret names of a user.
- The release workflow builds the `.mcpb` with `mcpb pack` and attaches it to the GitHub release.

### MCP Registry

- A `server.json` at the repo root. It points to the npm package.
- The release workflow publishes it with `mcp-publisher` and GitHub OIDC, after the npm publish.

### Workflows

- `.github/workflows/ci.yml`: on push and pull request, run typecheck, lint, and test on Node 22 and 26.
- `.github/workflows/release.yml`: on a tag `v*`, run the CI checks, check that the tag equals the package version, then npm publish, `.mcpb` pack and release, and registry publish.

### README

- A "Quick start" section with 3 steps: `npx checkout-test-mcp init`, add the client config, ask the agent to run `list_scenarios`.
- Sections for Claude Desktop (`.mcpb`), Claude Code (`claude mcp add`), and other clients.
- A short safety section: test targets only by default, production needs confirmation.

## Order of work

1. Packaging work on a branch in the private repo: LICENSE, package metadata, `init`, `env_file`, `manifest.json`, `server.json`, workflows, README. Review and merge.
2. History rewrite on a mirror clone. Scan and test.
3. The user renames the private repo. We create the public repo and push `main`.
4. The user sets up npm trusted publishing (and the first publish, if needed).
5. Tag `v0.2.0`. The release workflow publishes all three.

## What the user does

- Checks that the employer allows an open source release.
- Has an npm account with 2FA.
- Approves the repo rename, the new public repo, and each publish.

## Left to the builder

- The exact text of the README and the `init` messages.
- The test layout for `init` and `env_file`.
- The dotenv parser: a small own parser or the `node:util` `parseEnv` function, if the Node version allows it.
