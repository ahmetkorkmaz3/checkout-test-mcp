# Public Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `checkout-test-mcp` installable by anyone with one command (`npx`) or one click (`.mcpb`), and publish it from a public repo with a cleaned history.

**Architecture:** The CLI gets two subcommands (`init`, `demo-store`) next to the stdio server. The config gets `env_file` and `browser`. A release workflow publishes the npm package, the `.mcpb` file, and the MCP Registry entry from a tag. The history rewrite is a manual controller task at the end, because it handles private data.

**Tech Stack:** TypeScript 7, Node `>=22.12`, MCP SDK v2 (`@modelcontextprotocol/server` 2.4.0), Playwright 1.65.1, zod 4, vitest 5, biome, `@anthropic-ai/mcpb` 2.1.2, `mcp-publisher` 0.4.2, `git filter-repo`.

**Spec:** `docs/superpowers/specs/2026-11-25-public-release-design.md`

## Global Constraints

- Read `CLAUDE.md` first. Its hard rules bind every task.
- Never write to stdout in `src/`. The CLI subcommands also write to stderr.
- No real card number, real customer data, real company host, or local user path in code, tests, fixtures, docs, or commit messages. Use `shop.example`, `localhost`, and `~/work/...`.
- Pin exact versions (no `^` or `~`). Check the npm registry before you add a dependency. Prefer no new runtime dependency.
- An `env_file` value never appears in a log, an error message, a tool result, or a snapshot. An error names the path and the line number only.
- License: MIT, `Copyright (c) 2026 Ahmet Korkmaz`.
- Tool names, params, output fields, config keys: snake_case.
- Prose in docs, comments, error messages, and descriptions: ASD-STE100 (short sentences, active voice, no semicolons, no contractions).
- A change to a tool output schema updates `test/integration/__snapshots__/tools-list.json` (after a diff review) and `docs/tools.md`.
- `npm run typecheck`, `npm run lint`, and `npm test` pass at the end of each task.

## Review Focus

- A run record on disk from v0.1 (no `browser` field) must still load after the upgrade. A restart must not start a second checkout.
- The `.mcpb` passes `--env-file ""` when the user leaves the field empty. An empty value means "not set", not "file not found".
- `init` in a folder where only `scenarios/` exists must stop before it writes any file.
- In `browser: auto`, a Chromium launch that fails for another reason than a missing executable must not switch to Chrome.
- `init` and `demo-store` must work from any working folder after `npx`, so they find package files from `import.meta.url`, not from `process.cwd()`.

---

### Task 1: License, package metadata, and pack allow list

**Files:**
- Create: `LICENSE`, `test/unit/package-files.test.ts`
- Modify: `package.json`, `README.md` (license line), `docs/design.md` (tree comment near line 44 and the Q12 row)

**Interfaces:**
- Produces: `package.json` fields `license: "MIT"`, `mcpName: "io.github.ahmetkorkmaz3/checkout-test-mcp"`, `repository`, `homepage`, `bugs` (all on `https://github.com/ahmetkorkmaz3/checkout-test-mcp`), `keywords` (`mcp`, `model-context-protocol`, `checkout`, `e2e`, `playwright`, `payments`, `testing`). `files` adds `examples/demo-store/server.mjs` and `LICENSE`.

- [ ] **Step 1: Write the failing test** `package-files.test.ts`: run `npm pack --dry-run --json` (with `execFileSync`, `--ignore-scripts`) and assert that every packed path matches one of these prefixes: `dist/`, `scenarios/`, `test-data/`, `schemas/`, `examples/demo-store/server.mjs`, `checkout-test-mcp.config.example.yaml`, `LICENSE`, `README.md`, `package.json`. Assert that `LICENSE` and `examples/demo-store/server.mjs` are in the list. Assert that no path contains `.map` from `test/` or any `.env`.
- [ ] **Step 2: Run it.** `npx vitest run test/unit/package-files.test.ts`. Expected: FAIL (no LICENSE, no demo store).
- [ ] **Step 3: Implement.** Write the standard MIT text with the copyright line from Global Constraints. Update `package.json`, the README license line, and the design doc lines.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `Use the MIT license and add package metadata`.

### Task 2: CLI subcommands `init` and `demo-store`

**Files:**
- Create: `src/cli/args.ts`, `src/cli/init.ts`, `src/cli/demo-store.ts`, `src/cli/package-root.ts`, `test/unit/cli-init.test.ts`, `test/unit/cli-args.test.ts`
- Modify: `src/index.ts`, `CLAUDE.md` (Commands section). The README changes are in Task 6.

**Interfaces:**
- Produces: `parseCli(argv: string[]): CliCommand` where `CliCommand = { kind: 'serve'; config?: string; envFile?: string } | { kind: 'init'; dir: string; skipBrowser: boolean } | { kind: 'demo-store'; port: number } | { kind: 'help' } | { kind: 'version' }`. `--env-file` is parsed here, Task 3 uses it.
- Produces: `packageRoot(): string` — the folder that holds `package.json`, found from `import.meta.url` (it works from `src/` under tsx and from `dist/`).
- Produces: `runInit(opts: { dir: string; skipBrowser: boolean; root: string; log: (line: string) => void; installBrowser: () => Promise<void> }): Promise<number>` — returns the exit code.
- Produces: `runDemoStore(opts: { port: number; root: string; log: (line: string) => void }): Promise<void>` — dynamic `import()` of `<root>/examples/demo-store/server.mjs` by a file URL, then `startDemoStore({ port })`.

- [ ] **Step 1: Write failing tests**
  - `parseCli([])` → `{ kind: 'serve' }`. `parseCli(['--config', 'a.yaml'])` → serve with config. `parseCli(['init', '--dir', 'x', '--skip-browser'])` → init. `parseCli(['demo-store', '--port', '5000'])` → port 5000. An unknown subcommand throws an error that names it.
  - `runInit` in an empty temp folder writes `checkout-test-mcp.config.yaml`, `scenarios/demo-store/card-success.yaml`, and `test-data/`, and calls `installBrowser` once. It returns 0.
  - `runInit` with `skipBrowser: true` does not call `installBrowser`.
  - `runInit` in a folder with only `scenarios/` returns 1, writes no file, and the log names `scenarios`.
  - `runInit` never calls `process.stdout.write` (spy on it).
  - The written config loads with `loadConfig` and lists the target `demo-local`.
  - `packageRoot()` returns a folder with a `package.json` whose name is `checkout-test-mcp`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** `init` checks all destination paths first, then copies with `fs.cp` (`errorOnExist: true`, `force: false`). The real `installBrowser` runs `process.execPath` with `<root>/node_modules/playwright/cli.js install chromium`, or resolves the Playwright CLI with `createRequire`, and pipes its stdout to stderr. If the install fails, `init` logs that Google Chrome also works (Task 4) and returns 0. The last log lines show a client config snippet with `npx -y checkout-test-mcp --config <absolute config path>` and the command `npx checkout-test-mcp demo-store`. `src/index.ts` switches on `parseCli`. The usage text lists the subcommands.
- [ ] **Step 4: Manual check.** `npm run build && node dist/index.js init --dir "$TMPDIR/ctm-init" --skip-browser`, then `node dist/index.js demo-store --port 4199` and fetch `http://localhost:4199/`. Stop the demo store after.
- [ ] **Step 5: Run** `npm run typecheck && npm run lint && npm test`.
- [ ] **Step 6: Commit** `Add the init and demo-store commands`.

### Task 3: `env_file`

**Files:**
- Create: `src/config/env-file.ts`, `test/unit/env-file.test.ts`
- Modify: `src/schemas/config.ts` (`ServerConfig.env_file: z.string().optional()`), `src/config/load-config.ts` (resolve the path against the config folder), `src/app.ts` (`bootstrap` gets `envFile?: string`), `src/index.ts`, `docs/design.md` (config section), `checkout-test-mcp.config.example.yaml` (a commented example), `npm run schema` if the config schema is generated.

**Interfaces:**
- Consumes: Task 2 `CliCommand.envFile`.
- Produces: `loadEnvFile(path: string, env: NodeJS.ProcessEnv): { loaded: string[]; skipped: string[] }` — sets keys that are not already in `env`. `loaded` and `skipped` hold key names only.

- [ ] **Step 1: Write failing tests**
  - A file with `A=1` and `B="two words"` sets both in a fresh env object.
  - A key that is already set keeps its value and appears in `skipped`.
  - A missing file throws an `Error` whose message holds the path and not the word of any value.
  - A file with a bad line throws an error that names the line number. The message does not contain the line text (use a line with a value `s3cr3t-value` and assert that the message does not contain it).
  - The CLI flag wins over the config field. A relative config field resolves against the config folder. A relative CLI flag resolves against the working folder.
  - `--env-file ""` and an empty config value mean "not set".
  - `bootstrap` loads the file before it builds `RunManager`, so a secret from the file reaches the redactor (assert with a run manager env that sees the value).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** with `parseEnv` from `node:util`. Wrap its error: keep only a line number if you can find one, never the text. Log `env file loaded` with the key count, not the names of the keys and never the values.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm test`.
- [ ] **Step 5: Commit** `Read secrets from an env file`.

### Task 4: Browser choice and the `browser` result field

**Files:**
- Create: `src/runner/launch.ts`, `test/unit/launch.test.ts`
- Modify: `src/schemas/config.ts` (`ServerConfig.browser: z.enum(['auto', 'chromium', 'chrome']).default('auto')`), `src/runner/browser.ts`, `src/runner/classify.ts` (`browser_error` hint), `src/schemas/run.ts` (`RunRecord.browser`), the run executor and the get_run_result view, `src/compare/compare.ts`, `docs/tools.md`, `docs/design.md`, the tools-list snapshot.

**Interfaces:**
- Produces: `launchBrowser(choice: 'auto' | 'chromium' | 'chrome', options: LaunchOptions, launcher?: Pick<BrowserType, 'launch'>): Promise<{ browser: Browser; info: BrowserInfo }>` with `BrowserInfo = { name: 'chromium' | 'chrome'; version: string }` (`version` from `browser.version()`).
- Produces: `GuardedContext.info: BrowserInfo`. `GuardedContextInput.config` picks `browser` too.
- Produces: `RunRecord.browser: BrowserInfo | null`, schema `.nullable().default(null)`, so old records parse. `get_run_result` output shows `browser`.
- Produces: the error message prefix `No browser found.` for the case where no browser can start.

- [ ] **Step 1: Write failing tests** (with a fake `launcher`)
  - `auto`: Chromium starts → `info.name === 'chromium'`.
  - `auto`: the Chromium launch throws a message with `Executable doesn't exist` → a second launch with `channel: 'chrome'` → `info.name === 'chrome'`.
  - `auto`: the Chromium launch throws another error (for example `Target closed`) → that error goes up, no Chrome launch.
  - `auto`: both fail with missing executables → the error message starts with `No browser found.` and names both ways to fix it.
  - `chromium` and `chrome` never fall back.
  - A v0.1 run record JSON without `browser` parses, and `browser` is `null`.
  - `compareRuns` adds the warning `The runs used different browsers: chromium <v1> and chrome <v2>.` when the names or the major versions differ, and no warning when one side is `null`.
  - classify: a `browser_error` with `No browser found.` gives an `ask_human` action that names "install Google Chrome" and `npx checkout-test-mcp init`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep all current launch options (proxy, args, headless) on both launches. Set `browser` on the run record when the context opens. Inspections use the same launch path.
- [ ] **Step 4: Snapshot.** `npx vitest run -u test/integration`, then read the diff of `tools-list.json`. Only the new `browser` output field may change.
- [ ] **Step 5: Run** `npm run typecheck && npm run lint && npm test && npm run test:e2e`. The e2e run shows `browser.name` in a result.
- [ ] **Step 6: Commit** `Fall back to the system Chrome and record the browser`.

### Task 5: Desktop extension and registry files

**Files:**
- Create: `manifest.json`, `server.json`, `.mcpbignore`, `scripts/pack-mcpb.sh`, `test/unit/release-files.test.ts`
- Modify: `package.json` (`devDependencies`: `@anthropic-ai/mcpb` at the exact registry version, script `pack:mcpb`)

**Interfaces:**
- Consumes: Task 2 CLI, Task 3 `--env-file`.
- Produces: `npm run pack:mcpb` → `checkout-test-mcp-<version>.mcpb` in the repo root (git-ignored).

- [ ] **Step 1: Read the current formats.** Run `npx @anthropic-ai/mcpb@2.1.2 --help` and read the manifest spec that version links to. Run `npx mcp-publisher@0.4.2 --help` (or the install method its docs give) and read the `server.json` schema it names. Do not write either file from memory.
- [ ] **Step 2: Write the failing test** `release-files.test.ts`: the versions in `package.json`, `manifest.json`, and `server.json` are equal. `manifest.json` has `license: "MIT"`, a `user_config.config_path` of type file with `required: true`, a `user_config.env_file` of type file that is not required, and no default value that looks like a path under `/home/`. `server.json` names the npm package `checkout-test-mcp` and the `mcpName` from `package.json`.
- [ ] **Step 3: Run it.** Expected: FAIL.
- [ ] **Step 4: Implement.** The manifest server entry runs `dist/index.js` with `--config ${user_config.config_path}` and `--env-file ${user_config.env_file}`. `pack-mcpb.sh` builds, copies `dist`, `scenarios`, `test-data`, `schemas`, `examples/demo-store/server.mjs`, `LICENSE`, `manifest.json`, `package.json`, and `package-lock.json` to a temp folder, runs `npm ci --omit=dev --ignore-scripts` there, then `mcpb validate` and `mcpb pack`.
- [ ] **Step 5: Manual check.** `npm run pack:mcpb`. The file is under 60 MB. `unzip -l` shows no `test/`, no `docs/`, and no `.env` file.
- [ ] **Step 6: Run** `npm run typecheck && npm run lint && npm test`.
- [ ] **Step 7: Commit** `Add the Desktop extension and registry files`.

### Task 6: Workflows and README

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Modify: `README.md`, `docs/design.md` (a short release section)

**Interfaces:**
- Consumes: Tasks 1 to 5.

- [ ] **Step 1: ci.yml.** On push to `main` and on pull requests: Node 22.12 and 26 matrix, `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`. A second job installs Chromium and runs `npm run test:e2e` on Node 26. Pin each action to a full commit SHA with the tag in a comment.
- [ ] **Step 2: release.yml.** On a tag `v*`. Permissions: `contents: write`, `id-token: write`. Steps: the CI checks, a check that the tag equals `v` plus the `package.json` version, `npm publish --provenance --access public` (npm trusted publishing, no token), `npm run pack:mcpb`, `gh release create` with the `.mcpb` file, then `mcp-publisher login github-oidc` and `mcp-publisher publish`. Check each command against the current docs of the tool.
- [ ] **Step 3: Check the files.** Run `actionlint` if it is installed (`npx` is not enough, it is a Go tool). If it is not installed, read both files again against the GitHub Actions syntax and note in the report that `actionlint` did not run.
- [ ] **Step 4: README.** A "Quick start" section first: 1. `npx -y checkout-test-mcp init`, 2. add the client config (show the JSON for Claude Desktop and `claude mcp add` for Claude Code), 3. `npx checkout-test-mcp demo-store` and ask the agent to run `list_scenarios`. Then sections: Claude Desktop extension (`.mcpb` from the release page), browser choice, `env_file`, safety (test targets by default, production needs a confirmation for each run), license MIT.
- [ ] **Step 5: Run** `npm run typecheck && npm run lint && npm test`.
- [ ] **Step 6: Commit** `Add the CI and release workflows and a quick start`.

### Task 7: History rewrite and the public repo (controller only, manual)

This task handles private data. The controller does it. No subagent gets the replace file or the pattern list.

- [ ] **Step 1:** Merge the work of Tasks 1 to 6 into `main` of the private repo (the user merges the PR).
- [ ] **Step 2:** Ask the user before `brew install git-filter-repo`.
- [ ] **Step 3:** In the scratchpad: `git clone --no-local --single-branch --branch main <private repo> rewrite`. Write `replacements.txt` and `messages.txt` in the scratchpad, outside the clone.
- [ ] **Step 4:** `git filter-repo --replace-text ../replacements.txt --replace-message ../messages.txt`.
- [ ] **Step 5:** Scan every blob of every commit and every commit message with the pattern list. Expected: zero hits. Also scan the `npm pack` file list output and the `.mcpb` content.
- [ ] **Step 6:** `npm ci && npm run typecheck && npm run lint && npm test` on the rewritten `main`.
- [ ] **Step 7:** Stop. Ask the user to rename the private repo to `checkout-test-mcp-private` and to approve the new public repo. Then `gh repo create ahmetkorkmaz3/checkout-test-mcp --public` and push `main` only.

### Task 8: First release (the user leads)

- [ ] **Step 1:** The user sets up npm trusted publishing for the repo and the `release.yml` workflow. If npm needs a first manual publish, the user runs it with 2FA.
- [ ] **Step 2:** Bump the version to `0.2.0` in `package.json`, `manifest.json`, and `server.json`. Open a PR. The user merges.
- [ ] **Step 3:** With the yes of the user, push the tag `v0.2.0`.
- [ ] **Step 4:** Check the results: `npm view checkout-test-mcp version`, the `.mcpb` on the release page, and the registry entry. In an empty folder, run `npx -y checkout-test-mcp init --skip-browser` and call `list_scenarios` over stdio.
