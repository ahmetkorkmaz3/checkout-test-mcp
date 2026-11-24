import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../server.js';
import {
  CONFIG_CHANGES_TEXT,
  configFacts,
  FORMAT_TEXT,
  fillTarget,
  fragmentsText,
  HOUSE_RULES_TEXT,
  hasTarget,
  productionText,
  SECRETS_TEXT,
  unknownTargetText,
  WRITING_RULES_TEXT,
} from './setup-checkout-tests.js';

export const CREATE_SCENARIO_DESCRIPTION = [
  'Writes one new checkout test scenario that the user asks for, on a configured test target.',
  'The agent reuses the fragments in the authoring folder and the latest inspection of the target, saves and runs the scenario, and fixes failures (3 tries).',
  'It asks the user only for what the inspection cannot answer.',
].join(' ');

export const CREATE_SCENARIO_INTRO = [
  'You write one new checkout test scenario for the target "{target}" of the checkout-test MCP server.',
  'Do the steps below in order.',
  'Ask the user only for what the request and the inspection report cannot answer, and put all questions in one message.',
].join(' ');

export const CREATE_SCENARIO_STEPS: readonly string[] = [
  [
    '1. Call `list_scenarios`. Make sure that "{target}" is in `targets`. If it is not, show the user the target names and stop.',
    'When a scenario already does what the user asks, tell the user its id and offer to run it with `run_scenario`. Do not write a copy.',
  ].join(' '),
  // Step 2 depends on the inspections on disk. inspectionStep() writes it.
  '2. Get the facts about the site from an inspection.',
  [
    '3. Find what the scenario needs that the request and the report cannot answer, for example a test account, a gift card test number, or a payment host for `third_party_hosts`.',
    'When the request needs the checkout pages, the report has no payment step, and the checkout probe is off, add the probe to the same question. Tell the user the side effects on the test site: a guest account with an example.test email, an address, an unpaid order draft, and a cart item. To allow it, the user sets `inspect.probe_checkout: true` under the target.',
    'Ask the user once for all of it, in one message. Follow the "Secrets" rules below. The user edits the config. Never edit the config yourself.',
    'After a config change, wait for the server restart (see "Config changes"). Inspect again with a new key when the change affects the site facts.',
  ].join(' '),
  [
    '4. Reuse the fragments in the list above for the parts that they cover, such as add to cart, the address form, and pay.',
    'Write a new fragment only for steps that no fragment has, and save it with `save_scenario` and kind "fragment" first.',
    'Take every button name, label, and option text from the report.',
  ].join(' '),
  [
    '5. Write the scenario. Give it a kebab-case id that starts with "{target}-", and the `expected_outcome` that the request needs.',
    'Save it with `save_scenario`, kind "scenario", and `validate_on: { target: "{target}" }`.',
    'Then call `get_run_result` with `validation.run_id` and wait_s 20 until `status` is "finished".',
    'When the verdict is not "passed", read the failing step, the category, the likely causes, and the screenshot. Fix the YAML and save again with `overwrite: true`.',
    'You have 3 tries. One try is one save with a validation run. A save that `SCENARIO_INVALID` refuses is not a try: fix every issue in `details.issues` at once.',
    'A "blocked" verdict that names a host is a config fix, not a try. Ask the user to add the host, wait for the restart, and run again.',
    'After 3 failed tries, stop and tell the user that the scenario needs a human, with the last failure.',
  ].join(' '),
  [
    '6. End with one table for the user:',
    '| Scenario | What it proves | Verdict | Run id |',
    '|---|---|---|---|',
    'Then list the missing inputs, the test orders that the validation runs placed, and the paths that you saved. The user commits the files.',
  ].join('\n'),
];

const PAGING =
  'When a warning says that the result is cut, call `inspect_target` again with the same target, key, and scope, plus `section` (for example "pages") and `offset` 0. Then send `slice.next_offset` as the offset until it is null.';

function inspectionStep(
  target: string,
  latest: { idempotency_key: string; scope: string } | undefined,
): string {
  if (latest) {
    return [
      `Call \`inspect_target\` with target "${target}", idempotency_key "${latest.idempotency_key}", and scope "${latest.scope}".`,
      'This is the latest finished inspection of the target. The call returns its report at once and starts no new inspection.',
      'Read `checkout_probe`, `site.pages`, `site.api_calls`, `suggested_scenarios`, and `warnings`.',
      PAGING,
    ].join(' ');
  }
  return [
    `No finished inspection exists for "${target}".`,
    `Call \`inspect_target\` with target "${target}", scope "both", and a new idempotency_key, for example "scenario-${target}-<today as YYYYMMDD>".`,
    'While `status` is not "finished", call it again with the same target, key, and scope, and wait_s 20. Never use a new key to see the progress.',
    'When the checkout probe is off, this inspection reads the site only. Step 3 asks about the probe.',
    PAGING,
  ].join(' ');
}

export async function createScenarioText(deps: ServerDeps, target: string, request: string): Promise<string> {
  if (!hasTarget(deps, target)) return unknownTargetText(deps, target);
  const latest = await deps.inspections.latestFinished(target);
  const steps = CREATE_SCENARIO_STEPS.map((s) =>
    s.startsWith('2. ') ? `${s} ${inspectionStep(target, latest)}` : s,
  );
  // The request is user text. fillTarget does not touch it.
  return [
    fillTarget(CREATE_SCENARIO_INTRO, target),
    `The request of the user:\n"""\n${request.trim()}\n"""`,
    fillTarget(
      [
        configFacts(deps, target),
        ...productionText(deps, target),
        await fragmentsText(deps),
        'Steps:',
        ...steps,
        CONFIG_CHANGES_TEXT,
        SECRETS_TEXT,
        FORMAT_TEXT,
        WRITING_RULES_TEXT,
        HOUSE_RULES_TEXT,
      ].join('\n\n'),
      target,
    ),
  ].join('\n\n');
}

export function registerCreateScenario(server: McpServer, deps: ServerDeps): void {
  server.registerPrompt(
    'create_scenario',
    {
      title: 'Create one checkout test scenario',
      description: CREATE_SCENARIO_DESCRIPTION,
      argsSchema: z.object({
        target: z
          .string()
          .min(1)
          .describe('Target name from the config, for example "my-staging". Never a URL.'),
        request: z
          .string()
          .min(1)
          .max(2000)
          .describe(
            'What the scenario must prove, in plain words, for example "a gift card pays the full order".',
          ),
      }),
    },
    async ({ target, request }) => ({
      messages: [
        { role: 'user', content: { type: 'text', text: await createScenarioText(deps, target, request) } },
      ],
    }),
  );
}
