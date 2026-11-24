import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { listFragments, MAX_LISTED_FRAGMENTS } from '../authoring/fragments.js';
import { isProductionTarget } from '../safety/hosts.js';
import { PRODUCTION_WARNING } from '../safety/production.js';
import type { ServerDeps } from '../server.js';

/*
 * The prompt texts are product design. An agent in any MCP client follows them to set up
 * a scenario set for an unknown shop with no human help. Treat a change like a UI change.
 * "{target}" in a constant is the target name. The builders replace it.
 */

export const SETUP_CHECKOUT_TESTS_DESCRIPTION = [
  'First setup of checkout tests for a configured test target.',
  'The agent inspects the target, writes fragments and the baseline scenarios, saves and runs each scenario, fixes failures (3 tries for each scenario), and ends with a summary table.',
  'It asks the user only for what the tools cannot answer.',
].join(' ');

export const SETUP_INTRO = [
  'You set up checkout tests for the target "{target}" of the checkout-test MCP server.',
  'Do the steps below in order.',
  'Ask the user only for what the tools cannot answer, and put all questions of one step in one message.',
  'Do not ask the user to pick scenarios. The first setup writes, saves, and runs the baseline scenarios with no question, and then shows a summary.',
].join(' ');

export const SETUP_CHECKOUT_TESTS_STEPS: readonly string[] = [
  [
    '1. Call `list_scenarios`. Make sure that "{target}" is in `targets`.',
    'If it is not, show the user the target names and stop.',
    'Note the scenarios that already exist for the profile of "{target}". Do not write a second scenario for the same flow.',
  ].join(' '),
  [
    '2. Read the config facts above. Collect the config changes that the setup needs, and ask the user once, in one message. When the setup needs no change, ask nothing.',
    'When the checkout probe is off, ask the user to allow it. Tell the user the side effects on the test site: a guest account with an example.test email, an address, an unpaid order draft, and a cart item.',
    'To allow it, the user sets `inspect.probe_checkout: true` under the target.',
    'When the authoring folder is not set, ask the user to add the `authoring` block with a `dir` inside one of the scenario folders. Without it, the server refuses every save with AUTHORING_DISABLED.',
    'When test data writes are off, ask the user to set `authoring.test_data_dir_writable: true`, or to give a customer data file.',
    'The user edits the config. Never edit the config yourself. See "Config changes" below: each change needs a server restart.',
    'When the user says no to the probe, go on without it. The report then has no payment step, so most baseline scenarios cannot be written.',
  ].join(' '),
  [
    '3. Call `inspect_target` with target "{target}", scope "both", and a new idempotency_key, for example "setup-{target}-<today as YYYYMMDD>".',
    'While `status` is not "finished", call `inspect_target` again with the same target, key, and scope, and wait_s 20.',
    'Never use a new key to see the progress. A new key starts a second inspection.',
    'When `reused_existing_inspection` is true and the config changed after that inspection, the report is old. Add a counter to the key, for example "setup-{target}-<YYYYMMDD>-2", and inspect again.',
    'Read `warnings`, `checkout_probe` (reached, stopped_reason, steps, dialogs, payment with card_frames and card_fields), `site.pages`, `site.api_calls`, `suggested_scenarios` (baseline, missing, card_source), and `side_effects`.',
    'When a warning says that the result is cut, call `inspect_target` again with the same target, key, and scope, plus `section` (for example "pages") and `offset` 0. Then send `slice.next_offset` as the offset until it is null.',
  ].join(' '),
  [
    '4. Show the user `site.blocked_hosts`.',
    'A payment or 3D Secure host must be in the target `third_party_hosts` before card scenarios can pass. Ask the user to add each such host to the config.',
    'Analytics, tag manager, and ad hosts stay blocked. Do not ask about them.',
    'When the probe stopped at a login (`stopped_reason: login_required`), or the member suggestion misses secrets, tell the user the secret names and env vars to set (see "Secrets" below).',
    'Wait until the user restarts the server before you run card scenarios. Go on with the fragments while the user edits the config.',
  ].join(' '),
  [
    '5. Write the fragments first: add to cart, start a guest checkout, the contact and address form, and pay (card form, terms, pay button).',
    'Save each with `save_scenario` and kind "fragment", before the scenarios that include them.',
    'When the fragment list below already has a fragment for a part, include it and do not write a second one.',
    'Take every button name, label, and option text from the report: `checkout_probe.steps`, `checkout_probe.payment`, and `site.pages`.',
  ].join(' '),
  [
    '6. When test data writes are on, write one customer file and save it with `save_scenario` and kind "test_data", for example path "customers/guest.yaml".',
    'Use a fictional name and phone, and an email on a reserved domain such as example.test.',
    "Use the site's own city and district option texts from `site.pages[].selects`. The probe chose the first options.",
    'A scenario reads the file with `data: { customer: customers/guest.yaml }` and `{{data.customer.email}}`.',
    'When test data writes are off and no customer file exists, put the file text in the summary for the user.',
  ].join(' '),
  [
    '7. For each suggestion with `baseline: true`, write one scenario. Use the suggestion id as the scenario id, and its `expected_outcome`.',
    'Save it with `save_scenario`, kind "scenario", and `validate_on: { target: "{target}" }`.',
    'Then call `get_run_result` with `validation.run_id` and wait_s 20 until `status` is "finished".',
    'When the verdict is not "passed", read the failing step, the category, the likely causes, and the screenshot. Fix the YAML and save again with `overwrite: true`.',
    'You have 3 tries for each scenario. One try is one save with a validation run. A save that `SCENARIO_INVALID` refuses is not a try: fix every issue in `details.issues` at once.',
    'A "blocked" verdict that names a host is a config fix, not a try. Ask the user to add the host, wait for the restart, and run again.',
    'After 3 failed tries, stop work on that scenario. List it as "needs a human" with the last failure, and go to the next scenario.',
    'Do not write the suggestions with `baseline: false`. They are offers for the summary.',
  ].join(' '),
  [
    '8. End with the summary for the user, in this form:',
    '| Scenario | What it proves | Verdict | Run id |',
    '|---|---|---|---|',
    'One row for each scenario that you saved, also for each scenario that needs a human.',
  ].join('\n'),
];

export const SUMMARY_TEXT = [
  'After the table, give these lists:',
  '- Needs a human: each scenario that failed 3 tries, with its last failing step and category.',
  '- Offers: each suggestion with `baseline: false`, with its `why`. Tell the user to ask for one with the `create_scenario` prompt.',
  '- Missing inputs: everything from `suggested_scenarios[].missing` and from your questions that the user did not answer, for example member secrets, a gift card test number, or a payment host for `third_party_hosts`.',
  '- Side effects: the `side_effects` of the inspection on the test site, and the test orders that the validation runs of `order_placed` scenarios placed.',
  '- Files: the paths that you saved. The server does not commit them. The user commits them.',
].join('\n');

export const CONFIG_CHANGES_TEXT = [
  'Config changes:',
  '- The server reads the config once, at start. A change to the `authoring` block, an `inspect` block, `third_party_hosts`, or `secrets` works only after the user restarts the server.',
  '- After a restart, call `list_scenarios` to check that the server is back. Inspect again with a new key when the change affects the site facts, for example the probe or a new third-party host.',
].join('\n');

export const SECRETS_TEXT = [
  'Secrets:',
  '- Secrets come only from env vars that the target `secrets` map names. A scenario reads them as `{{secrets.<name>}}`.',
  '- Never ask the user to paste a password, a member email, or a token into the chat. Never write one in a file or a tool argument.',
  '- For a member scenario, tell the user to map `member_email` and `member_password` under the target `secrets` to env vars, for example SHOP_MEMBER_EMAIL and SHOP_MEMBER_PASSWORD, to set the env vars, and to restart the server.',
].join('\n');

export const WRITING_RULES_TEXT = [
  'Writing rules (from earlier setups):',
  '- Use only target-relative paths in `goto`, for example "/products/mug". Tool arguments take target names, never URLs.',
  '- After a step opens a page, add an expect `response` check for a client-side call of that page before the first click. A click before hydration does nothing. Take the call from `site.api_calls` for the page kind, and write its url as "**" plus `path_pattern`, for example "**/api/products/*". When no call exists for the page kind, add a `wait_for` step with a `visible` check of the element that you click next.',
  '- When a page has duplicated buttons (a sticky bar, desktop and mobile copies), use role locators with `exact: true`.',
  '- Check a path with `url: { regex: "^https?://[^/]+/path/?(\\\\?.*)?$" }`, not with a `**` glob. A glob also matches a return query such as `?return=/path`.',
  '- Read a one-time code with `capture`. For a Next.js server action body (text/x-component), use `body_regex`, for example `"Kod: (\\\\d{5})"`. For a JSON body, use `json_path`.',
  '- When the payment provider decides about 3D Secure, add a boolean param `three_ds` and put the 3D Secure fragment behind `when: { param: three_ds, equals: true }`.',
  '- For a custom combobox (role combobox with a listbox), click the combobox, then click the option by its exact name. The option text case can differ from the label, for example "KADIKÖY" for "Kadıköy".',
  '- When the site has a test card select (`card_source.kind: site_select`), select the option with `option: <card_source.value>` when `value` is set. Else use `option: <card_source.option>`. An option text with "<card>" hides a card number: never select by that text, and never write a card number.',
  '- When `card_source.kind` is "registry", add one `test_card` param with `card_source.card_id` as the default, and fill the card form with `{{card.number}}`, `{{card.expiry}}`, and `{{card.cvc}}`.',
  '- Card fields in a frame (`checkout_probe.payment.card_frames`): use `within: { frame: { css: "iframe[title=\'<title>\']" } }` and `fill_form` with the labels or placeholders from `card_fields`. The `prefer-semantic-locator` warning is expected there. When a warning says that the card fields are unknown, the frame host is blocked: the user adds it to `third_party_hosts`, restarts the server, and you inspect again.',
  '- A payment or 3D Secure host in `site.blocked_hosts` must go into the target `third_party_hosts`. The user does this. Analytics and ad hosts stay blocked.',
  '- Close each dialog in `checkout_probe.dialogs` with a step. Reject a cookie banner, never accept it.',
  '- The probe never pays, so the report cannot show the success page. Write the first order checks from common signals, for example a heading that matches "thank you|order received" and a `url` regex with "success" or "confirm". Fix them from the first run.',
  '- Add `on_failure.hint` to each payment step and to each step where the cause of a failure is not obvious.',
].join('\n');

export const FORMAT_TEXT = [
  'Scenario format (short form):',
  '- Scenario keys: `id`, `title`, `summary`, `tags`, `compatible_profiles` (the target profile), `expected_outcome` (`order_placed`, `payment_declined`, `validation_error`, or `custom`), `params`, `data` (name: test data path), `steps`, `outcome`.',
  '- Param: `type` (`string`, `integer`, `number`, `boolean`, `enum` with `values`, `test_card` with `constraints.behaviour`), `description`, and `default` or `required: true`.',
  '- Step: `id` (snake_case), `title`, and one of `goto` (path), `click`, `fill` + `value`, `select` + `option`, `check`, `uncheck`, `press` + `key`, `fill_form` (list of `{ field, value }` or `{ field, select }`), `wait_for`, `include` + `with`.',
  '- Step options: `within: { frame: <locator> }`, `then` (more actions), `expect` (list), `timeout_ms`, `on_failure: { hint }`, `when: { param, equals | not_equals | in }`, `capture`.',
  '- Capture: a list of `{ name, from_response: { method, url, status }, json_path | body_regex, pattern }`. `pattern` is optional. A later step uses `{{captured.<name>}}`.',
  '- Locator: `{ role, name, exact }`, `{ test_id }`, `{ label }`, `{ placeholder }`, `{ text }`, or `{ css }` as a fallback. A name can be `{ matches: "<regex>" }`, case-insensitive.',
  '- Expectation: `visible`, `hidden`, `text: { <locator>, equals | contains | matches }`, `url: { regex | equals | matches }`, `response: { method, url, status }`, `no_response: { method, url, status }`. Response urls are globs, for example "**/api/orders".',
  '- An element in a frame: `visible: { within: { frame: <locator> }, locator: <locator> }`. The same shape works for `hidden`.',
  '- Outcome check: `{ id, <one expectation>, timeout_ms, when }`. `timeout_ms` and `when` are optional.',
  '- Fragment: `kind: fragment`, `id`, `description`, `args` (each with `description`, optional `default`), `steps`. Use `{{args.<name>}}` inside it. An include path is relative to the including file.',
  '- Templates: `{{params.<name>}}`, `{{data.<name>.<field>}}`, `{{card.number}}`, `{{card.expiry}}`, `{{card.cvc}}`, `{{secrets.<name>}}`, `{{captured.<name>}}`.',
].join('\n');

export const HOUSE_RULES_TEXT = [
  '`save_scenario` checks these house rules. An error refuses the save. A warning does not.',
  '- `param-described` (error): every param has a `description`, and a `default` or `required: true`. Every fragment arg has a `description`.',
  '- `outcome-proves-order` (error): `expected_outcome: order_placed` needs one `response` or `url` outcome check and one `visible` or `text` outcome check, without `when`.',
  '- `outcome-proves-no-success` (error): `payment_declined` and `validation_error` need one `hidden` or `no_response` outcome check without `when`.',
  '- `no-literal-personal-data` (error): no literal email, phone, or password in a fill value, a default, or a `with` value. Use `{{secrets.*}}`, `{{data.*}}`, or `{{params.*}}`.',
  '- `id-format` (error): the scenario id is kebab-case. Step ids are snake_case.',
  '- `prefer-semantic-locator` (warning): use role, test id, label, placeholder, or text, not css.',
  '- `payment-step-hint` (warning): a payment step needs `on_failure.hint`.',
  '- `url-glob-query` (warning): a `url.matches` glob with `**` also matches a query string. Use `regex`.',
  '- `test-data-email-domain` (error, test data): every email uses a reserved domain such as example.test.',
  '- `test-data-card` (error, test data): no card-like number.',
].join('\n');

export const PRODUCTION_TEXT = [
  'Production target:',
  `- "{target}" is a production target. ${PRODUCTION_WARNING}`,
  '- Show this warning to the user before each `run_scenario` call. Name the scenario and the params, and ask for a yes for that one run.',
  '- Only after the user says yes, call `run_scenario` with `confirm_production: true`. One yes is good for one run. Never set `confirm_production` without the yes of the user in this conversation.',
  '- `save_scenario` with `validate_on` cannot start a run on a production target. It saves the file and returns PRODUCTION_CONFIRMATION_REQUIRED. Then ask the user and call `run_scenario` with the scenario id.',
  '- A `test_card` param takes a live card id, "live/<name>", from `targets[].live_cards` of `list_scenarios`. The number comes from env vars. Never ask the user for a card number.',
  '- The checkout probe of `inspect_target` never pays. On a production target it can still make a guest account, an address, and an unpaid order draft on the live site. Tell the user before you inspect.',
].join('\n');

/** The production text for a production target. Empty for a test target. */
export function productionText(deps: ServerDeps, target: string): string[] {
  const t = hasTarget(deps, target) ? deps.config.targets[target] : undefined;
  return t && isProductionTarget(t) ? [PRODUCTION_TEXT] : [];
}

/** Text for an unknown target. The prompt then holds only this. */
export function unknownTargetText(deps: ServerDeps, target: string): string {
  const names = Object.keys(deps.config.targets);
  return [
    `The config has no target "${target}". The targets are: ${names.join(', ') || 'none'}.`,
    'Show the user these names and stop. The user adds a target to the config and restarts the server.',
  ].join(' ');
}

export function hasTarget(deps: ServerDeps, target: string): boolean {
  return Object.hasOwn(deps.config.targets, target);
}

/** Facts from the config that the tools do not show. The agent then asks the user only for the rest. */
export function configFacts(deps: ServerDeps, target: string): string {
  const { config } = deps;
  const t = config.targets[target];
  if (!t || !hasTarget(deps, target)) return unknownTargetText(deps, target);
  const authoringDir = config.authoring ? shownPath(config.config_dir, config.authoring.dir) : undefined;
  const secrets = Object.entries(t.secrets).map(([name, env]) => `${name} (env ${env})`);
  const sourceDirs = t.inspect?.source_dirs.length ?? 0;
  return [
    'Config facts (from the server, not from a tool):',
    `- Target "${target}": profile "${t.profile}".`,
    `- Environment: ${isProductionTarget(t) ? 'production. See "Production target" below' : 'test'}.`,
    `- Checkout probe: ${t.inspect?.probe_checkout === true ? 'on' : 'off'}.`,
    `- Code scan: ${sourceDirs > 0 ? `${sourceDirs} source folder(s)` : 'no source folders. The report has no code facts'}.`,
    authoringDir
      ? `- Authoring folder: ${authoringDir}. Save paths are relative to it.`
      : '- Authoring folder: not set. The server refuses every save with AUTHORING_DISABLED.',
    `- Test data writes: ${config.authoring?.test_data_dir_writable === true ? 'on' : 'off'}.`,
    `- Secret names: ${secrets.length > 0 ? secrets.join(', ') : 'none'}.`,
    `- Third-party hosts: ${t.third_party_hosts.length > 0 ? t.third_party_hosts.join(', ') : 'none'}.`,
  ].join('\n');
}

/** The fragments in the authoring folder. An agent with only the MCP tools cannot read the folder. */
export async function fragmentsText(deps: ServerDeps): Promise<string> {
  const dir = deps.config.authoring?.dir;
  if (!dir) return 'Fragments in the authoring folder: unknown, because the authoring folder is not set.';
  const fragments = await listFragments(dir);
  if (fragments.length === 0) return 'Fragments in the authoring folder: none.';
  const lines = fragments.map((f) => {
    const args = f.args.map(
      (a) => `${a.name} (${a.description}${a.default !== undefined ? ` Default: ${a.default}.` : ''})`,
    );
    return `- ${f.path} (id ${f.id}): ${f.description}${args.length > 0 ? ` Args: ${args.join('; ')}.` : ' No args.'}`;
  });
  return [
    'Fragments in the authoring folder. The paths are relative to the folder. An include path is relative to the including file.',
    ...lines,
    ...(fragments.length >= MAX_LISTED_FRAGMENTS
      ? [`The list stops at ${MAX_LISTED_FRAGMENTS} fragments.`]
      : []),
  ].join('\n');
}

/** Relative to the config folder when the path is inside it. */
function shownPath(configDir: string, dir: string): string {
  const rel = path.relative(configDir, dir);
  if (rel === '') return '.';
  return rel.startsWith('..') || path.isAbsolute(rel) ? dir : rel;
}

export function fillTarget(text: string, target: string): string {
  return text.replaceAll('{target}', target);
}

export async function setupCheckoutTestsText(deps: ServerDeps, target: string): Promise<string> {
  if (!hasTarget(deps, target)) return unknownTargetText(deps, target);
  return fillTarget(
    [
      SETUP_INTRO,
      configFacts(deps, target),
      ...productionText(deps, target),
      await fragmentsText(deps),
      'Steps:',
      ...SETUP_CHECKOUT_TESTS_STEPS,
      SUMMARY_TEXT,
      CONFIG_CHANGES_TEXT,
      SECRETS_TEXT,
      FORMAT_TEXT,
      WRITING_RULES_TEXT,
      HOUSE_RULES_TEXT,
    ].join('\n\n'),
    target,
  );
}

export function registerSetupCheckoutTests(server: McpServer, deps: ServerDeps): void {
  server.registerPrompt(
    'setup_checkout_tests',
    {
      title: 'Set up checkout tests for a target',
      description: SETUP_CHECKOUT_TESTS_DESCRIPTION,
      argsSchema: z.object({
        target: z
          .string()
          .min(1)
          .describe('Target name from the config, for example "my-staging". Never a URL.'),
      }),
    },
    async ({ target }) => ({
      messages: [
        { role: 'user', content: { type: 'text', text: await setupCheckoutTestsText(deps, target) } },
      ],
    }),
  );
}
