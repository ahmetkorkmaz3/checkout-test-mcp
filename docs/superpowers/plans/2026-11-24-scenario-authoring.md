# Scenario Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `inspect_target`, `save_scenario`, and the prompts `setup_checkout_tests` and `create_scenario`, so that one request sets up a working, proved scenario set for any shop.

**Architecture:** The server collects facts (site crawl, checkout probe, code scan) and enforces the house rules. The calling agent writes the YAML. `save_scenario` validates, trial-loads, writes, swaps the registry, and starts a validation run through the existing `RunManager`. `inspect_target` is one tool that starts a background job and long polls it by idempotency key.

**Tech Stack:** TypeScript 7 (ESM, NodeNext, strict), `@modelcontextprotocol/server` 2.4.0, `playwright` 1.65.1, `zod` 4.6.7, `yaml` 2.9.1, `vitest` 5.1.1, `@biomejs/biome` 2.6.8.

**Spec:** `docs/superpowers/specs/2026-11-24-scenario-authoring-design.md`

## Global Constraints

- Every rule in `CLAUDE.md` applies. Read it before each task.
- Tools accept target names, never URLs. File paths in tool arguments are relative to a config folder and checked.
- No stdout in `src/`. Use the logger.
- Never log, return, or write a resolved secret, a card number, an email, or a phone number from a page or a source file.
- Long poll maximum: 20 s (`wait_s` 0..20).
- Same idempotency key gives the same job, also after a restart.
- Every new `ToolError` code goes in `src/errors/tool-error.ts`, in `docs/tools.md`, and gets a refuse-path test.
- A change to a tool description or schema updates `test/integration/__snapshots__/tools-list.json` (review the diff, then `npx vitest run -u`) and `docs/tools.md`.
- No production hosts. The probe never clicks a pay button and never submits a phone number for a code.
- Reserved email domains for test data: `example.test`, `example.com`, `example.org`, `example.net`, and any `.invalid` or `.test` domain.
- New test cards need the provider's published source URL. Do not trust memory: fetch the page and copy the values.
- Definition of done per task: `npm run typecheck`, `npm run lint`, `npm test` pass. Tasks with browser work also pass `npm run test:e2e`.

## Review Focus

1. **A shop with no guest checkout** (login wall on the cart button). Expect: the probe stops with reason `login_required`, the report says so, and suggestions skip guest scenarios. Test in Task 10.
2. **A cookie consent banner over the page.** Expect: the probe clicks a reject or close button from the word list before it looks for add-to-cart. It never clicks accept. Test in Task 10 with the demo store bug flag `cookie-banner`.
3. **A large source folder** (monorepo, `node_modules` symlinks, generated files). Expect: the scan follows no symlink, skips the ignore list, stops at 20 000 files or 30 s with a warning, and returns what it has. Test in Task 8.
4. **A hostile `path` in `save_scenario`** (`../x.yaml`, `/etc/x.yaml`, `a/../../x.yaml`, `Upper.yaml`, a symlink that leaves `authoring.dir`). Expect: `PATH_REFUSED`, nothing written. Test in Task 4 and Task 6.
5. **A server restart during an inspection.** Expect: the same key returns `status: "finished"` with `interrupted: true` and the partial report. A new key starts a new job. Test in Task 11.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/schemas/config.ts` (modify) | `authoring` block, target `inspect` block. |
| `src/config/load-config.ts` (modify) | Resolve and check the new paths. |
| `src/errors/tool-error.ts` (modify) | Five new codes. |
| `src/scenarios/registry.ts` (modify) | `load(dirs, { overrides })`, `swap(next)`. |
| `src/safety/test-cards.ts` (modify) | iyzico and Craftgate cards, `providerForPackage()`. |
| `src/safety/redact-text.ts` (create) | Redact emails, phones, card-like numbers, tokens in free text. |
| `src/util/paths.ts` (create) | `resolveInside()` path guard. |
| `src/authoring/rules.ts` (create) | House rules: errors, warnings, fixes. |
| `src/authoring/test-data.ts` (create) | Test data checks. |
| `src/authoring/save.ts` (create) | Save service: guard, parse, rules, trial load, write, swap, validation run. |
| `src/tools/save-scenario.ts` (create) | Thin tool. |
| `src/runner/browser.ts` (create) | `openGuardedContext()`, shared by the executor and the inspector. |
| `src/runner/executor.ts` (modify) | Use `openGuardedContext()`. |
| `src/inspect/words.ts` (create) | Multi-language word lists. |
| `src/inspect/page-kind.ts` (create) | Page kind guess. |
| `src/inspect/code-scan.ts` (create) | Source scan. |
| `src/inspect/crawl.ts` (create) | Site crawl. |
| `src/inspect/probe.ts` (create) | Checkout probe. |
| `src/inspect/suggest.ts` (create) | Baseline set and offers. |
| `src/inspect/report.ts` (create) | Report schema, trim for the tool result. |
| `src/inspect/manager.ts` (create) | Inspection jobs: idempotency, persistence, long poll. |
| `src/tools/inspect-target.ts` (create) | Thin tool. |
| `src/prompts/setup-checkout-tests.ts`, `src/prompts/create-scenario.ts` (create) | MCP prompts. |
| `src/server.ts`, `src/app.ts` (modify) | Wire the new parts. |
| `examples/demo-store/server.mjs` (modify) | Agreement checkbox, `cookie-banner` bug, `login-wall` bug. |
| `examples/demo-store/src/` (create) | Small source fixture for the code scan. |
| `test/fixtures/shop-src/` (create) | Next.js-like fixture for code scan unit tests. |
| Docs: `docs/tools.md`, `docs/design.md`, `docs/scenario-format.md`, `CLAUDE.md`, `README.md` | Updated in the task that changes the behaviour. |

---

### Task 1: Config blocks and error codes

**Files:**
- Modify: `src/schemas/config.ts`, `src/config/load-config.ts`, `src/errors/tool-error.ts`, `checkout-test-mcp.config.example.yaml`, `docs/design.md` (section 3)
- Test: `test/unit/config-compare.test.ts`

**Interfaces:**
- Produces:
  - `AuthoringConfig = { dir: string; test_data_dir_writable: boolean }` (top-level `authoring`, optional).
  - `InspectConfig = { source_dirs: string[]; start_paths: string[]; product_paths: string[]; max_pages: number; probe_checkout: boolean; words: Partial<Record<WordKind, string[]>> }` on `TargetConfig.inspect` (optional). Defaults: `source_dirs: []`, `start_paths: ["/"]`, `product_paths: []`, `max_pages: 25` (1..100), `probe_checkout: false`, `words: {}`.
  - `ResolvedConfig.authoring?: { dir: string /* absolute */; test_data_dir_writable: boolean }`. `source_dirs` resolved to absolute paths.
  - `ToolErrorCode` adds `AUTHORING_DISABLED`, `SCENARIO_INVALID`, `PATH_REFUSED`, `SCENARIO_EXISTS`, `INSPECTION_FAILED`.
  - `WordKind` is defined in Task 7. In this task, type `words` as `z.record(z.string(), z.array(z.string()))` and narrow it in Task 7.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses authoring.dir outside scenario_dirs', () => {
  expect(() => parseConfig({ ...base, authoring: { dir: '/tmp/elsewhere' } }, dir)).toThrow(/authoring.dir must be inside one of scenario_dirs/);
});
it('accepts authoring.dir inside a scenario dir and resolves it', () => {
  const c = parseConfig({ ...base, scenario_dirs: ['./s'], authoring: { dir: './s/local' } }, dir);
  expect(c.authoring?.dir).toBe(path.join(dir, 's/local'));
  expect(c.authoring?.test_data_dir_writable).toBe(false);
});
it('defaults the inspect block and keeps the probe off', () => {
  const c = parseConfig({ ...base, targets: { t: { ...target, inspect: {} } } }, dir);
  expect(c.targets.t?.inspect).toMatchObject({ start_paths: ['/'], max_pages: 25, probe_checkout: false });
});
```

- [ ] **Step 2: Run** `npx vitest run test/unit/config-compare.test.ts`. Expected: 3 FAIL.
- [ ] **Step 3: Implement** the schema fields and the check in `validateConfig` (`authoring.dir` must equal or be under a resolved `scenario_dirs` entry). Add the five codes to `ToolErrorCode`.
- [ ] **Step 4: Run** the test file. Expected: PASS. Run `npm run typecheck`.
- [ ] **Step 5: Docs.** Add both blocks to `docs/design.md` section 3 and to the example config, with comments.
- [ ] **Step 6: Commit** `git commit -m "Add authoring and inspect config blocks"`

---

### Task 2: Registry trial load and swap

**Files:**
- Modify: `src/scenarios/registry.ts`
- Test: `test/unit/scenarios.test.ts`

**Interfaces:**
- Produces:
  - `ScenarioRegistry.load(dirs: readonly string[], opts?: { overrides?: ReadonlyMap<string, string | null> }): Promise<ScenarioRegistry>`. `overrides` maps an absolute file path to its text. The text replaces the disk content, and a new path is added to the file list. `null` removes a file.
  - `swap(next: ScenarioRegistry): void`. Replaces the internal map in place, so every holder of the object sees the new list.
  - Fragment includes inside `parseScenario` also read from `overrides`. Add `readText?: (file: string) => string` to `expandScenario` options and pass it down.

- [ ] **Step 1: Write the failing tests**

```ts
it('trial load uses override text and a new file', async () => {
  const file = path.join(tmp, 'new.yaml');
  const reg = await ScenarioRegistry.load([tmp], { overrides: new Map([[file, MINIMAL.replace('id: s', 'id: added')]]) });
  expect(reg.ids()).toContain('added');
  expect(existsSync(file)).toBe(false);
});
it('trial load sees a broken fragment override in an including scenario', async () => {
  await expect(ScenarioRegistry.load([tmp], { overrides: new Map([[fragFile, 'kind: fragment\nsteps: 7']]) })).rejects.toThrow(/invalid fragment/);
});
it('swap changes what an existing holder sees', async () => {
  const reg = await ScenarioRegistry.load([tmp]);
  reg.swap(ScenarioRegistry.fromLoaded([]));
  expect(reg.ids()).toEqual([]);
});
```

- [ ] **Step 2: Run** and see 3 FAIL.
- [ ] **Step 3: Implement.** Remove `readonly` from the map field. Keep the all-or-nothing error rule.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add registry trial load and swap"`

---

### Task 3: iyzico and Craftgate test cards

**Files:**
- Modify: `src/safety/test-cards.ts`, `docs/design.md` (test card section)
- Test: `test/unit/safety.test.ts`

**Interfaces:**
- Produces:
  - New `TestCard` entries with ids `iyzico/<name>` and `craftgate/<name>`.
  - `providerForPackage(name: string): string | undefined`. Maps `stripe`, `@stripe/stripe-js`, `@stripe/react-stripe-js` → `stripe`. `iyzipay`, names that start with `@iyzico/` → `iyzico`. `@craftgate/craftgate`, names that start with `@craftgate/` → `craftgate`.

- [ ] **Step 1: Research.** Fetch the official test card pages of iyzico and Craftgate (developer docs, sandbox section). Copy only cards that the page lists for sandbox use, with the behaviour that the page states. Record each page URL as `source_url`. If a page does not show a card behaviour, leave that card out. Do not use blog posts or third-party lists.
- [ ] **Step 2: Write the failing tests**

```ts
it('has a success and a decline card for iyzico and craftgate, each with a source', () => {
  for (const p of ['iyzico', 'craftgate']) {
    const cards = TEST_CARDS.filter((c) => c.provider === p);
    expect(cards.some((c) => c.behaviour === 'success')).toBe(true);
    expect(cards.some((c) => c.behaviour.startsWith('declined'))).toBe(true);
    for (const c of cards) expect(c.source_url).toMatch(/^https:\/\/[^/]*(iyzico|craftgate)\./);
  }
});
it('maps payment packages to providers', () => {
  expect(providerForPackage('@stripe/stripe-js')).toBe('stripe');
  expect(providerForPackage('iyzipay')).toBe('iyzico');
  expect(providerForPackage('@craftgate/craftgate')).toBe('craftgate');
  expect(providerForPackage('left-pad')).toBeUndefined();
});
```

  Use the decline behaviour names that `CardBehaviour` already has. If a provider card needs a new behaviour, add it to `CardBehaviour` and to `docs/tools.md`.
- [ ] **Step 3: Run** and see FAIL. **Step 4: Implement.** **Step 5: Run** `npm test` (the card guard tests must still pass: registry numbers are allowed, other numbers are refused).
- [ ] **Step 6: Commit** `git commit -m "Add iyzico and Craftgate sandbox test cards"`

---

### Task 4: Text redactor and path guard

**Files:**
- Create: `src/safety/redact-text.ts`, `src/util/paths.ts`
- Test: `test/unit/safety.test.ts`

**Interfaces:**
- Produces:
  - `redactText(s: string): string`. Emails → `<email>`, phone-like digit runs of 10 to 13 digits with optional `+`, spaces, brackets → `<phone>`, card-like numbers (13 to 19 digits, Luhn valid, spaces or dashes) → `<card>`, JWT-like and 32+ character base64 or hex tokens → `<token>`.
  - `resolveInside(root: string, rel: string, opts: { pattern: RegExp }): string`. Returns the absolute path. Throws `ToolError` `PATH_REFUSED` when `rel` is absolute, contains `..` or a backslash, does not match `opts.pattern`, resolves outside `root`, or when an existing parent folder is a symlink whose real path is outside `root`.

- [ ] **Step 1: Write the failing tests** (one per refuse path)

```ts
it.each(['../x.yaml', '/etc/x.yaml', 'a/../../x.yaml', 'a\\b.yaml', 'Upper.yaml', 'x.yml.txt'])('refuses %s', (rel) => {
  expect(() => resolveInside(root, rel, { pattern: YAML_PATH })).toThrow(expect.objectContaining({ code: 'PATH_REFUSED' }));
});
it('refuses a symlinked folder that leaves the root', () => {
  symlinkSync(os.tmpdir(), path.join(root, 'out'));
  expect(() => resolveInside(root, 'out/x.yaml', { pattern: YAML_PATH })).toThrow(/PATH_REFUSED|outside/);
});
it('redacts personal data and tokens but keeps product text', () => {
  expect(redactText('Mail ayse@shop.com, tel 0555 000 00 00, Tabak 19 cm')).toBe('Mail <email>, tel <phone>, Tabak 19 cm');
  expect(redactText('card 4242 4242 4242 4242')).toBe('card <card>');
});
```

  `YAML_PATH = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*\.yaml$/`. Export it from `src/util/paths.ts`.
- [ ] **Steps 2 to 4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `git commit -m "Add a text redactor and a path guard"`

---

### Task 5: House rules

**Files:**
- Create: `src/authoring/rules.ts`, `src/authoring/test-data.ts`
- Test: `test/unit/authoring-rules.test.ts`

**Interfaces:**
- Consumes: `Scenario`, `Fragment` types, `expandScenario()`.
- Produces:
  - `type RuleIssue = { rule: string; severity: 'error' | 'warning'; path: string; message: string; fix: string }`.
  - `applyFixes(text: string, kind: 'scenario' | 'fragment', schemaPath: string): { text: string; fixes: string[] }`. Adds the `# yaml-language-server: $schema=<schemaPath>` line and `schema_version: 1` when missing. It keeps comments and key order (use `yaml` `parseDocument`).
  - `checkHouseRules(input: { kind: 'scenario'; raw: Scenario; expanded: Scenario } | { kind: 'fragment'; raw: Fragment }): RuleIssue[]`.
  - `checkTestData(text: string): RuleIssue[]`.
- Rule ids and checks (from the spec, section 7.6):
  - `param-described` (error): every param has `description` and `default` or `required: true`. Fragment `args` need `description`.
  - `outcome-proves-order` (error): `expected_outcome: order_placed` needs ≥1 outcome check of kind `response` or `url`, and ≥1 of kind `visible` or `text`. Checks with `when` do not count.
  - `outcome-proves-no-success` (error): `payment_declined` and `validation_error` need ≥1 `hidden` or `no_response` outcome check without `when`.
  - `no-literal-personal-data` (error): no email, phone, or password-like literal in a `fill` value, a `fill_form` value, a param `default`, or a `with` value. A value is a literal when it has no `{{`.
  - `id-format` (error): scenario id kebab-case. Step ids snake_case.
  - `prefer-semantic-locator` (warning): a `css` locator.
  - `payment-step-hint` (warning): a step whose title or locator matches the pay words (Task 7 word list, or a local copy until then) and has no `on_failure.hint`.
  - `url-glob-query` (warning): a `url.matches` glob that ends with `**`. The message names the `/sepet` case: a glob also matches a query string such as `?return=/sepet`. The fix says: use `regex` with `^https?://[^/]+/path/?(\?.*)?$`.
  - `test-data-email-domain` (error, test data): an email whose domain is not reserved.
  - `test-data-card` (error, test data): any card-like number.
  - The id-uniqueness rule is checked by the trial load in Task 6. It is not in this file.

- [ ] **Step 1: Write the failing tests.** One `it` for each rule id, each with one passing and one failing YAML. Example:

```ts
it('outcome-proves-order: a when-guarded check does not count', () => {
  const issues = check(ORDER_SCENARIO.replace('outcome:\n', 'outcome:\n  - id: w\n    when: { param: p, equals: a }\n    url: { matches: "**/ok" }\n'));
  expect(issues.map((i) => i.rule)).toContain('outcome-proves-order');
});
it('applyFixes adds the schema line and schema_version, keeps comments', () => {
  const { text, fixes } = applyFixes('# keep\nid: a\n', 'scenario', '../schemas/scenario.schema.json');
  expect(text.startsWith('# yaml-language-server: $schema=../schemas/scenario.schema.json\n')).toBe(true);
  expect(text).toContain('# keep');
  expect(text).toContain('schema_version: 1');
  expect(fixes).toHaveLength(2);
});
```

- [ ] **Steps 2 to 4:** FAIL, implement, PASS.
- [ ] **Step 5: Docs.** Add a "House rules" section to `docs/scenario-format.md` with the rule ids.
- [ ] **Step 6: Commit** `git commit -m "Add house rules for authored scenarios"`

---

### Task 6: `save_scenario`

**Files:**
- Create: `src/authoring/save.ts`, `src/tools/save-scenario.ts`
- Modify: `src/server.ts`, `src/runs/manager.ts` (only if `start()` needs a flag, see below), `docs/tools.md`, `CLAUDE.md` (principle 6 and the tool list)
- Test: `test/integration/save-scenario.test.ts`, snapshot update

**Interfaces:**
- Consumes: Task 1 config, Task 2 `load({ overrides })` and `swap()`, Task 4 `resolveInside`, Task 5 rules, `RunManager.start()`.
- Produces:
  - Tool input: `{ kind: 'scenario' | 'fragment' | 'test_data'; path: string; yaml: string /* max 65536 chars */; overwrite?: boolean /* default false */; validate_on?: { target: string; params?: Record<string, ParamValue> } }`. `validate_on` is only for `kind: 'scenario'`.
  - Tool output: `{ path: string /* relative */; kind; scenario_id: string | null; written: boolean; unchanged: boolean; fixes_applied: string[]; warnings: RuleIssue[]; validation: { run_id: string; status: RunStatus; reused_existing_run: boolean } | null; next: NextAction }`.
  - `saveScenario(deps: ServerDeps, input): Promise<SaveResult>`.
- Behaviour, in order:
  1. No `config.authoring` → `AUTHORING_DISABLED`. `kind: 'test_data'` and `test_data_dir_writable: false` → `AUTHORING_DISABLED` with a next action to set the flag.
  2. Root: `authoring.dir` for scenario and fragment, `test_data_dir` for test data. `resolveInside(root, path, { pattern: YAML_PATH })`.
  3. Card number in `yaml` → `REAL_CARD_DATA_REFUSED` (existing code). Secret-like text → `SECRET_IN_ARGUMENTS` (existing check).
  4. `applyFixes`, parse, zod validate, rules. Any error issue → `SCENARIO_INVALID` with `details.issues`.
  5. File exists: same bytes after fixes → `unchanged: true`, `written: false`, continue to step 7. Different bytes and `overwrite: false` → `SCENARIO_EXISTS`.
  6. Trial load: `ScenarioRegistry.load(config.scenario_dirs, { overrides: new Map([[abs, fixedText]]) })`. Errors → `SCENARIO_INVALID` with the load messages. Then write atomically (temp file in the same folder + rename) and `deps.registry.swap(trial)`.
  7. `validate_on`: call `deps.manager.start()` with `idempotency_key = "save-" + scenario_id + "-" + sha256(fixedText + JSON.stringify(params ?? {})).slice(0, 16)`. Return the run fields. Its `next` points to `get_run_result` with `wait_s: 20`.
- Tool description (product design, write it carefully): what it does, that the agent writes the YAML, that the server refuses card numbers, personal data literals, and weak outcome checks, that `validate_on` starts a run, and that the path is relative to the authoring folder.
- Annotations: `readOnlyHint: false`, `destructiveHint: true` (it can overwrite), `idempotentHint: true`, `openWorldHint: false`.

- [ ] **Step 1: Write the failing integration tests** (MCP client over `InMemoryTransport`, fake executor as in `server.test.ts`):

```ts
it('saves a valid scenario, swaps the registry, and starts a validation run', async () => {
  const res = await call('save_scenario', { kind: 'scenario', path: 'guest/new-one.yaml', yaml: VALID, validate_on: { target: 'demo-local' } });
  expect(res.structuredContent).toMatchObject({ written: true, scenario_id: 'new-one', validation: { status: 'queued' } });
  const list = await call('list_scenarios', {});
  expect(list.structuredContent.scenarios.map((s: { id: string }) => s.id)).toContain('new-one');
});
it('same content twice is unchanged and reuses the run', async () => { /* second call: unchanged true, reused_existing_run true */ });
it('a fixed file gets a new validation run', async () => { /* change outcome text, overwrite true, run_id differs */ });
it.each([
  ['AUTHORING_DISABLED', noAuthoringConfig, VALID],
  ['PATH_REFUSED', cfg, VALID, '../x.yaml'],
  ['SCENARIO_INVALID', cfg, WEAK_ORDER_SCENARIO],
  ['SCENARIO_INVALID', cfg, DUPLICATE_ID_SCENARIO],
  ['SCENARIO_EXISTS', cfg, VALID_CHANGED],
  ['REAL_CARD_DATA_REFUSED', cfg, VALID + '\n# 4000 0000 0000 0002'],
])('refuses with %s and writes nothing', async (code, config, yaml, p = 'guest/x.yaml') => { /* isError, code, no file */ });
it('refuses a fragment change that breaks an including scenario', async () => { /* SCENARIO_INVALID, old fragment on disk */ });
it('writes test data only with the flag and a reserved email domain', async () => { /* AUTHORING_DISABLED, then SCENARIO_INVALID test-data-email-domain, then success */ });
```

- [ ] **Step 2: Run** and see FAIL.
- [ ] **Step 3: Implement** the service and the tool. Register it in `createServer`. Add to the server `instructions` one sentence about `save_scenario`.
- [ ] **Step 4: Run** `npx vitest run test/integration`. Review the `tools/list` snapshot diff (one new tool, nothing else changed). Then `npx vitest run -u`.
- [ ] **Step 5: Docs.** `docs/tools.md`: new section with input, output, errors, and examples. Add the five error codes to the error table. `CLAUDE.md`: principle 6 lists six tools, and the long-work rule names `inspect_target` as the second pattern. `docs/design.md`: a new section 11 "Authoring" that links the spec.
- [ ] **Step 6: Commit** `git commit -m "Add the save_scenario tool"`

---

### Task 7: Word lists and page kind

**Files:**
- Create: `src/inspect/words.ts`, `src/inspect/page-kind.ts`
- Modify: `src/schemas/config.ts` (narrow `inspect.words` to `WordKind`)
- Test: `test/unit/inspect-words.test.ts`

**Interfaces:**
- Produces:
  - `type WordKind = 'add_to_cart' | 'cart' | 'checkout' | 'guest' | 'login' | 'pay' | 'terms' | 'success' | 'decline' | 'cookie_reject' | 'cookie_accept'`.
  - `wordsFor(kind: WordKind, extra?: Partial<Record<WordKind, string[]>>): RegExp`. Case-insensitive, Unicode-aware (`u` flag), and matches whole phrases. It folds Turkish `İ/ı` and German `ß` so that "SEPETE EKLE" and "Sepete Ekle" both match.
  - Languages: English, Turkish, German, French, Spanish, Italian, Dutch. Include at least the Acme strings from this session: "Sepete Ekle", "Sepetim", "Ödeme Adımına Geç", "Üye Olmadan Devam Et", "Giriş Yap", "Güvenli Öde", "Ön Bilgilendirme Formu", "Siparişin alındı", "onaylanmadı", "yetersiz".
  - `cookie_accept` exists only so the probe can avoid it.
  - `type PageKind = 'home' | 'listing' | 'product' | 'cart' | 'login' | 'checkout' | 'result' | 'other'`.
  - `guessPageKind(input: { path: string; title: string; headings: string[]; buttons: string[]; hasPasswordField: boolean; hasCardFields: boolean }): { kind: PageKind; reasons: string[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  ['add_to_cart', 'SEPETE EKLE'], ['add_to_cart', 'In den Warenkorb'], ['add_to_cart', 'Ajouter au panier'],
  ['guest', 'Üye Olmadan Devam Et'], ['guest', 'Continue as guest'], ['pay', 'Güvenli Öde'], ['pay', 'Place order'],
  ['cookie_reject', 'Reddet'], ['cookie_reject', 'Reject all'],
])('%s matches %s', (kind, text) => expect(wordsFor(kind as WordKind).test(text)).toBe(true));
it('pay does not match add to cart', () => expect(wordsFor('pay').test('Sepete Ekle')).toBe(false));
it('guesses a product page from its add-to-cart button', () => {
  expect(guessPageKind({ path: '/urun/x', title: 'X', headings: ['X'], buttons: ['Sepete Ekle'], hasPasswordField: false, hasCardFields: false }).kind).toBe('product');
});
```

- [ ] **Steps 2 to 4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `git commit -m "Add inspection word lists and page kind guess"`

---

### Task 8: Code scan

**Files:**
- Create: `src/inspect/code-scan.ts`, `test/fixtures/shop-src/**` (small Next.js-like app: `package.json` with `next` and `iyzipay`, `app/(shop)/odeme/page.tsx`, `app/sepet/page.tsx`, `locales/tr.json` with checkout strings, a component with `data-testid="pay-button"`, an `api/otp/send-code` route, a `.env` with a fake key, a `node_modules/` folder, and a symlink to `/tmp`)
- Test: `test/unit/code-scan.test.ts`

**Interfaces:**
- Consumes: Task 3 `providerForPackage`, Task 4 `redactText`, Task 7 `wordsFor`.
- Produces:
  - `scanSource(dirs: string[], opts: { words?: Partial<Record<WordKind, string[]>>; maxFiles?: number /* 20000 */; maxMs?: number /* 30000 */; testIdAttribute: string }): Promise<CodeReport>`.
  - `CodeReport = { frameworks: Evidence[]; routes: { path: string; file: string }[]; ui_strings: { key: string; text: string; file: string; line: number }[]; test_ids: { value: string; file: string; line: number }[]; payment_hints: { provider: string | null; package: string; file: string }[]; otp_hints: { text: string; file: string; line: number }[]; stats: { files: number; skipped: number; truncated: boolean }; warnings: string[] }`. `Evidence = { name: string; reason: string; file: string }`.
- Rules: never follow symlinks. Skip `.git`, `node_modules`, `dist`, `build`, `.next`, `.nuxt`, `coverage`, `vendor`, `.env*`, files > 512 KB, and files with a NUL byte in the first 8 KB. Pass every `text` through `redactText`. Route layouts: Next.js `app/` (route groups in brackets are removed) and `pages/`, Nuxt `pages/`, Remix `app/routes/`, Shopify theme `templates/`. Each list is capped at 500 entries.

- [ ] **Step 1: Write the failing tests**

```ts
it('finds framework, routes, strings, test ids, payment and otp hints', async () => {
  const r = await scanSource([FIXTURE], { testIdAttribute: 'data-testid' });
  expect(r.frameworks.map((f) => f.name)).toContain('next');
  expect(r.routes.map((x) => x.path)).toEqual(expect.arrayContaining(['/odeme', '/sepet']));
  expect(r.test_ids).toContainEqual(expect.objectContaining({ value: 'pay-button' }));
  expect(r.payment_hints).toContainEqual(expect.objectContaining({ provider: 'iyzico', package: 'iyzipay' }));
  expect(r.otp_hints.length).toBeGreaterThan(0);
});
it('skips .env, node_modules, and the symlink, and leaks no secret', async () => {
  const r = await scanSource([FIXTURE], { testIdAttribute: 'data-testid' });
  expect(JSON.stringify(r)).not.toContain('FAKE_SECRET_VALUE');
  expect(r.routes.every((x) => !x.file.includes('node_modules'))).toBe(true);
});
it('stops at maxFiles with a warning', async () => {
  const r = await scanSource([FIXTURE], { testIdAttribute: 'data-testid', maxFiles: 3 });
  expect(r.stats.truncated).toBe(true);
  expect(r.warnings.join(' ')).toMatch(/stopped after 3 files/);
});
```

  Create the symlink in `beforeAll`, not in git.
- [ ] **Steps 2 to 4:** FAIL, implement, PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the source code scan"`

---

### Task 9: Guarded browser context and site crawl

**Files:**
- Create: `src/runner/browser.ts`, `src/inspect/crawl.ts`
- Modify: `src/runner/executor.ts` (use `openGuardedContext`), `examples/demo-store/server.mjs` (add a `/products` listing page that links to the product, and a footer link to `/account/verify-phone`)
- Test: `test/e2e/inspect.test.ts`

**Interfaces:**
- Produces:
  - `openGuardedContext(input: { config: ResolvedConfig; target: TargetConfig; httpCredentials?: { username: string; password: string }; onBlocked: (url: string, isMainFrameNavigation: boolean) => void }): Promise<{ browser: Browser; context: BrowserContext; close(): Promise<void> }>`. Same launch options and the same route guard as the executor today. The executor keeps its behaviour, and the existing e2e tests prove it.
  - `PageSnapshot = { path_pattern: string; url_path: string; kind: PageKind; kind_reasons: string[]; title: string; headings: string[]; landmarks: string[]; elements: { role: string; name: string; label?: string; test_id?: string; visible: boolean }[]; forms: { fields: { label: string; type: string; autocomplete?: string; required: boolean }[] }[]; selects: { label: string; options: string[] /* max 50 */ }[]; iframes: { host: string; title?: string }[]; dialogs: string[] }`.
  - `ApiCall = { method: string; path_pattern: string; status: number; content_type: string; page_kind: PageKind }`. Path ids (digits, UUIDs, 16+ hex) → `*`. No query values.
  - `SiteReport = { pages: PageSnapshot[]; api_calls: ApiCall[]; blocked_hosts: { host: string; count: number }[] }`.
  - `crawlSite(ctx: { context: BrowserContext; target: TargetConfig; inspect: InspectConfig; signal: AbortSignal; onProgress(msg: string): void }): Promise<SiteReport>`. `blocked_hosts` comes from the `onBlocked` callback of `openGuardedContext`.
- Rules: breadth first from `start_paths` and `product_paths`. Same-host links only (the guard blocks the rest anyway). One page for each `path_pattern`. Stop at `max_pages`. Never fill, submit, or click, except closing a cookie banner with `cookie_reject` words. All text through `redactText`. Read elements with the accessibility snapshot (`page.locator('body').ariaSnapshot()` or the role queries), not raw HTML.

- [ ] **Step 1: Write the failing e2e test** (demo store):

```ts
it('crawls the demo store and finds the product page and its API call', async () => {
  const { pages, api_calls, blocked_hosts } = await crawl(demoTarget({ max_pages: 10 }));
  expect(blocked_hosts).toEqual([]);
  expect(pages.map((p) => p.kind)).toEqual(expect.arrayContaining(['product']));
  expect(pages.find((p) => p.kind === 'product')?.elements).toContainEqual(expect.objectContaining({ role: 'button', name: 'Add to cart' }));
  expect(api_calls).toContainEqual(expect.objectContaining({ method: 'GET', path_pattern: '/api/products/*' }));
  expect(demo.stats.orders).toBe(0);
});
```

- [ ] **Step 2: Run** `npm run test:e2e`. Expected: FAIL.
- [ ] **Step 3: Implement** `browser.ts` first and switch the executor to it. Run `npm run test:e2e` and see the old tests still pass. Then implement the crawl.
- [ ] **Step 4: Run** `npm run test:e2e`. Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add a guarded browser context and the site crawl"`

---

### Task 10: Checkout probe

**Files:**
- Create: `src/inspect/probe.ts`
- Modify: `examples/demo-store/server.mjs` (required agreement checkbox "I accept the terms" on the payment page, a "Continue as guest" choice on `/checkout`, bug flags `cookie-banner` and `login-wall`), the demo scenarios and fragments that pay (check the new checkbox)
- Test: `test/e2e/inspect.test.ts`

**Interfaces:**
- Consumes: Task 7 words, Task 9 context and `PageSnapshot`.
- Produces:
  - `ProbeStep = { action: string; page_kind: PageKind; url_path: string; result: 'done' | 'skipped' }`.
  - `ProbeResult = { reached: 'none' | 'product' | 'cart' | 'checkout' | 'payment'; stopped_reason: 'payment_step_reached' | 'login_required' | 'no_product' | 'no_add_to_cart' | 'no_checkout_button' | 'form_not_understood' | 'timeout' | 'blocked_by_safety'; steps: ProbeStep[]; guest_option: boolean; payment: { methods: string[]; card_form: boolean; card_iframe_hosts: string[]; test_card_select: { label: string; options: string[] } | null; agreement_checkbox: string | null; pay_button: string | null } | null; side_effects: string[] }`.
  - `probeCheckout(ctx: { context; target; inspect; signal; onProgress }): Promise<ProbeResult>`.
- Probe rules (spec 7.2 rule 4):
  1. Close a cookie banner with a `cookie_reject` button. Never click `cookie_accept`.
  2. Product: first of `product_paths`, else the first crawled product page. Click the add-to-cart button. Open the cart (cart link or `/cart`-like route from the crawl). Click the checkout button.
  3. On a login wall: click a guest button if there is one. Else stop with `login_required`.
  4. Guest email: `inspect-<8 hex>@example.test`.
  5. Address form: fill text fields by label kind (name, surname, full name, phone `5550000000`-style with the field's own digit count, address line `Test Street 1`, postcode `34000` or the first example from a pattern attribute). For a native select or a combobox, pick the first non-placeholder option. Click the save or continue button. Give up after 3 tries with `form_not_understood`.
  6. Payment step: record the fields in `ProbeResult.payment`. Never click the pay button. Never click a "send code" button.
  7. A hard cap of 120 s.
  8. `side_effects` lists what the probe made, for example `guest account inspect-1a2b3c4d@example.test`, `address`, `cart item`.

- [ ] **Step 1: Write the failing e2e tests**

```ts
it('probes the demo store to the payment step and never pays', async () => {
  const before = demo.stats.orders;
  const r = await probe(demoTarget({ probe_checkout: true }));
  expect(r.reached).toBe('payment');
  expect(r.stopped_reason).toBe('payment_step_reached');
  expect(r.guest_option).toBe(true);
  expect(r.payment?.agreement_checkbox).toMatch(/terms/i);
  expect(r.payment?.pay_button).toMatch(/^Pay/);
  expect(demo.stats.orders).toBe(before);
});
it('rejects a cookie banner and never accepts it', async () => {
  demo.setBugs(['cookie-banner']);
  const r = await probe(demoTarget({ probe_checkout: true }));
  expect(r.steps[0]).toMatchObject({ action: expect.stringMatching(/reject/i), result: 'done' });
  expect(demo.stats.cookieAccepted).toBe(0);
});
it('stops at a login wall without a guest option', async () => {
  demo.setBugs(['login-wall']);
  expect((await probe(demoTarget({ probe_checkout: true }))).stopped_reason).toBe('login_required');
});
```

- [ ] **Steps 2 to 4:** FAIL, implement (demo store first, then the probe), PASS. Run all e2e tests: the existing demo scenarios must still pass with the new checkbox.
- [ ] **Step 5: Commit** `git commit -m "Add the checkout probe"`

---

### Task 11: Suggestions, report, inspection jobs, and `inspect_target`

**Files:**
- Create: `src/inspect/suggest.ts`, `src/inspect/report.ts`, `src/inspect/manager.ts`, `src/tools/inspect-target.ts`, `examples/demo-store/src/` (fixture: `package.json` with `@stripe/stripe-js`, one page file)
- Modify: `src/app.ts` (create `InspectionManager`, recover), `src/server.ts`, `docs/tools.md`, the snapshot
- Test: `test/unit/suggest.test.ts`, `test/integration/inspect-target.test.ts`, `test/e2e/inspect.test.ts`

**Interfaces:**
- Consumes: Tasks 8 to 10, Task 3 registry.
- Produces:
  - `Suggestion = { id: string; title: string; expected_outcome: ExpectedOutcome; baseline: boolean; why: string; evidence: string[]; missing: string[]; card_source: { kind: 'site_select'; option: string } | { kind: 'registry'; card_id: string } | null }`.
  - `suggestScenarios(input: { target: string; site: SiteReport; probe: ProbeResult | null; code: CodeReport | null; hasMemberSecrets: boolean }): Suggestion[]`. Rules from spec 7.4. Decline options of a site select are found with `wordsFor('decline')`. Registry provider comes from `code.payment_hints` (first provider with cards), else from `card_iframe_hosts` (host contains the provider name), else none.
  - `InspectionReport` (zod, in `report.ts`): `{ inspection_id; target; status; interrupted: boolean; progress: string; site: SiteReport | null; checkout_probe: ProbeResult | null; code: CodeReport | null; suggested_scenarios: Suggestion[]; warnings: string[]; side_effects: string[]; report_path: string }`. `trimForResult(report): InspectionReport` keeps the JSON under 40 000 characters: it cuts `elements` first, then `ui_strings`, then `api_calls`, and adds a warning that names `report_path`.
  - `InspectionManager` with `start(input: { target: string; idempotency_key: string; scope: 'site' | 'code' | 'both' }): Promise<{ report: InspectionReport; reused: boolean }>` and `wait(id: string, wait_s: number): Promise<InspectionReport>`. Storage: `runs_dir/inspections/<id>.json` and `runs_dir/inspections/idempotency.json`, atomic writes. One inspection at a time, and an inspection waits for a free browser slot of `max_parallel_runs` (share the counter with `RunManager` through a small `BrowserSlots` class, or keep a separate limit of 1; builder's choice, but document it in `docs/design.md`). On startup, a `running` inspection becomes `finished` with `interrupted: true`.
  - Tool `inspect_target` input `{ target; idempotency_key /* same regex as run_scenario */; scope?: default 'both'; wait_s?: 0..20, default 20 }`. Output: the trimmed report plus `reused_existing_inspection: boolean` and `next: NextAction` (`call_tool inspect_target` with the same key while running, else the setup next step). Unknown target → `UNKNOWN_TARGET`. Production host target → `PRODUCTION_HOST_REFUSED` (existing check). Scope `code` with no `source_dirs` → `INVALID_PARAMS`. Crash → `INSPECTION_FAILED` in the report `warnings` and a `finished` status, not a tool error, when part of the report exists.
- Tool description: the scan reads the site and the source code, the probe (when the config allows it) goes to the payment step with fictional data and never pays, and it lists the side effects. Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.

- [ ] **Step 1: Write the failing tests**

```ts
// unit
it('makes the baseline set from a probe that reached payment with a site test card select', () => {
  const s = suggestScenarios({ target: 'k', site, probe: probeWith({ test_card_select: { label: 'Test kartı', options: ['Akbank - Master Card (Credit)', '3DS Tamamlama - İşlem onaylanmadı'] }, agreement_checkbox: 'Ön Bilgilendirme Formu…' }), code: null, hasMemberSecrets: false });
  expect(s.filter((x) => x.baseline).map((x) => x.id)).toEqual(['k-guest-card', 'k-card-declined', 'k-terms-required']);
  expect(s.find((x) => x.id === 'k-card-declined')?.card_source).toEqual({ kind: 'site_select', option: '3DS Tamamlama - İşlem onaylanmadı' });
});
it('adds member-card only with member secrets', () => { /* hasMemberSecrets true → baseline includes k-member-card */ });
it('uses the registry when code shows a payment package', () => { /* payment_hints iyzico → card_source registry iyzico/... */ });
// integration (fake crawl/probe injected into InspectionManager)
it('same key returns the same inspection, and a restart marks a running one interrupted', async () => { /* ... */ });
it('trims the report under 40000 characters and names report_path', async () => { /* ... */ });
// e2e
it('inspects the demo store and suggests the baseline set', async () => {
  const r = await inspectToEnd({ target: 'demo-local', idempotency_key: 'e2e-inspect-01' });
  expect(r.suggested_scenarios.filter((s) => s.baseline).map((s) => s.id)).toEqual(expect.arrayContaining(['demo-local-guest-card', 'demo-local-card-declined', 'demo-local-terms-required']));
  // The guest email may appear only in side_effects.
  expect(JSON.stringify({ site: r.site, code: r.code, probe: r.checkout_probe?.payment })).not.toMatch(/4242|@example\.test/);
});
```
- [ ] **Steps 2 to 4:** FAIL, implement, PASS. Review and update the `tools/list` snapshot.
- [ ] **Step 5: Docs.** `docs/tools.md`: `inspect_target` section with an example report (trimmed). `README.md`: the authoring and inspect config.
- [ ] **Step 6: Commit** `git commit -m "Add inspect_target with suggestions and inspection jobs"`

---

### Task 12: Prompts and the full setup loop

**Files:**
- Create: `src/prompts/setup-checkout-tests.ts`, `src/prompts/create-scenario.ts`
- Modify: `src/server.ts` (`registerPrompt`), `README.md` ("Set up a new shop" section), `docs/tools.md` (prompts section)
- Test: `test/integration/prompts.test.ts`, `test/e2e/inspect.test.ts`

**Interfaces:**
- Produces:
  - Prompt `setup_checkout_tests`, `argsSchema: z.object({ target: z.string() })`. The text tells the agent, in order:
    1. Call `list_scenarios` and check the target exists.
    2. If the target has no `inspect.probe_checkout: true`, ask the user once to allow the probe, and list the side effects from the spec.
    3. Call `inspect_target` with a new key, and poll with the same key until `finished`.
    4. Report `blocked_hosts` and ask the user about payment hosts for `third_party_hosts` (config edit is the user's).
    5. Write fragments first (add-to-cart, guest start, address, pay), save each with `save_scenario`.
    6. Write test data if `test_data_dir_writable`, with a reserved email domain and the site's own city and district options.
    7. Write each **baseline** suggestion, save it with `validate_on`, poll `get_run_result`, read the failure, fix, and save again. Maximum 3 tries for each scenario.
    8. End with the summary table (scenario, what it proves, verdict, run id), then the offers and the missing inputs.
    - It also lists the house rules by id and the lessons from the Acme setup: wait for hydration with a `response` check before the first click on a page, exact role names for duplicated buttons, `url` checks with `regex` for paths, `body_regex` for server action bodies, `three_ds` as a boolean param when the provider decides.
  - Prompt `create_scenario`, `argsSchema: z.object({ target: z.string(), request: z.string() })`. Same loop for one scenario. It reuses fragments in `authoring.dir` and the latest finished inspection for the target (it tells the agent to call `inspect_target` with the key of the last setup, or a new key if none).
  - Export the prompt texts as constants so tests can check key sentences.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists both prompts with their arguments', async () => {
  const { prompts } = await client.listPrompts();
  expect(prompts.map((p) => p.name).sort()).toEqual(['create_scenario', 'setup_checkout_tests']);
});
it('setup prompt names the tools in order and the 3-try limit', async () => {
  const text = (await client.getPrompt({ name: 'setup_checkout_tests', arguments: { target: 'demo-local' } })).messages[0].content.text;
  expect(text.indexOf('inspect_target')).toBeLessThan(text.indexOf('save_scenario'));
  expect(text).toMatch(/3 tries/);
  expect(text).toContain('demo-local');
});
```

  E2E (the loop without a model): inspect the demo store, build a guest card scenario from the `demo-local-guest-card` suggestion with a small test helper that fills a template from the report, save it with `validate_on`, and expect `verdict: "passed"`. This proves that the report carries enough facts.
- [ ] **Steps 2 to 4:** FAIL, implement, PASS.
- [ ] **Step 5: Final check.** `npm run typecheck && npm run lint && npm test && npm run test:e2e && npm run schema && npm run smoke`. `git status` shows the regenerated schemas if the config schema is exported. Scan the diff: no card number outside `src/safety/test-cards.ts`, no real company host, no secret.
- [ ] **Step 6: Commit** `git commit -m "Add the setup and create scenario prompts"`

---

### Task 13: Acme acceptance run (manual, private data)

Not part of the public repo. Run after the PR merges.

- [ ] Add `authoring` and `acme-test.inspect` (with `source_dirs: [~/work/acme/acme-storefront]`, `probe_checkout: true`) to the local config. Point `authoring.dir` to a new folder in the private repo, for example `scenarios/acme/generated`.
- [ ] Run the `setup_checkout_tests` prompt for `acme-test` in a fresh Claude Code session.
- [ ] Expect: the baseline set (guest card, card declined, terms required, member card) passes, and the result matches the hand-written scenarios from 2026-11-24. Write down every place where the agent needed a human, and file each one as an issue.
