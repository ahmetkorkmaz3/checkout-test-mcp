import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load-config.js';
import { InspectionManager } from '../../src/inspect/manager.js';
import type { InspectionRecord } from '../../src/inspect/report.js';
import { silentLogger } from '../../src/logger.js';
import { CREATE_SCENARIO_STEPS } from '../../src/prompts/create-scenario.js';
import {
  CONFIG_CHANGES_TEXT,
  FORMAT_TEXT,
  HOUSE_RULES_TEXT,
  SETUP_CHECKOUT_TESTS_STEPS,
  SUMMARY_TEXT,
  WRITING_RULES_TEXT,
} from '../../src/prompts/setup-checkout-tests.js';
import { RunManager } from '../../src/runs/manager.js';
import { RunStore } from '../../src/runs/store.js';
import { ScenarioRegistry } from '../../src/scenarios/registry.js';
import { createServer } from '../../src/server.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

let dir = '';
let client: Client | undefined;
let inspections: InspectionManager | undefined;

interface SetupOptions {
  probe?: boolean;
  authoring?: boolean;
  testData?: boolean;
  records?: InspectionRecord[];
  /** Files for a temporary authoring folder. Without it, the authoring folder is scenarios/demo-store. */
  authoringFiles?: Record<string, string>;
}

async function setup(opts: SetupOptions = {}) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ctm-prompts-'));
  const localDir = path.join(dir, 'scenarios/local');
  for (const [rel, text] of Object.entries(opts.authoringFiles ?? {})) {
    await mkdir(path.dirname(path.join(localDir, rel)), { recursive: true });
    await writeFile(path.join(localDir, rel), text, 'utf8');
  }
  const config = parseConfig(
    {
      runs_dir: path.join(dir, 'runs'),
      scenario_dirs: [
        path.join(ROOT, 'scenarios'),
        ...(opts.authoringFiles ? [path.join(dir, 'scenarios')] : []),
      ],
      targets: {
        'demo-local': {
          profile: 'demo-store',
          base_url: 'http://localhost:4173',
          allowed_hosts: ['localhost'],
          third_party_hosts: ['sandbox-pay.example.test'],
          secrets: { member_email: 'DEMO_MEMBER_EMAIL', member_password: 'DEMO_MEMBER_PASSWORD' },
          ...(opts.probe === undefined ? {} : { inspect: { probe_checkout: opts.probe } }),
        },
      },
      ...(opts.authoring === false
        ? {}
        : {
            authoring: {
              dir: opts.authoringFiles ? localDir : path.join(ROOT, 'scenarios/demo-store'),
              test_data_dir_writable: opts.testData === true,
            },
          }),
    },
    dir,
  );
  const inspectionsDir = path.join(config.runs_dir, 'inspections');
  await mkdir(inspectionsDir, { recursive: true });
  for (const r of opts.records ?? []) {
    await writeFile(path.join(inspectionsDir, `${r.inspection_id}.json`), JSON.stringify(r), 'utf8');
  }
  const registry = await ScenarioRegistry.load(config.scenario_dirs);
  const store = new RunStore(config.runs_dir);
  await store.init();
  const manager = new RunManager({ config, registry, store, logger: silentLogger, env: {} });
  inspections = new InspectionManager({ config, logger: silentLogger });
  await inspections.init();
  const server = createServer({ config, registry, manager, inspections, logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

afterEach(async () => {
  await inspections?.idle();
  await client?.close();
  client = undefined;
  inspections = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function promptText(c: Client, name: string, args: Record<string, string>): Promise<string> {
  const res = await c.getPrompt({ name, arguments: args });
  expect(res.messages).toHaveLength(1);
  const content = res.messages[0]?.content;
  if (content?.type !== 'text') throw new Error('expected a text message');
  return content.text;
}

function record(over: Partial<InspectionRecord>): InspectionRecord {
  return {
    inspection_id: 'insp_AAAAAAAAAAAAAAAA',
    target: 'demo-local',
    status: 'finished',
    interrupted: false,
    progress: 'Finished.',
    site: null,
    checkout_probe: null,
    code: null,
    suggested_scenarios: [],
    warnings: [],
    side_effects: [],
    report_path: path.join(dir, 'runs/inspections/insp_AAAAAAAAAAAAAAAA.json'),
    idempotency_key: 'setup-demo-local-20261120',
    request_hash: 'x'.repeat(32),
    scope: 'both',
    created_at: '2026-11-20T10:00:00.000Z',
    finished_at: '2026-11-20T10:05:00.000Z',
    ...over,
  };
}

describe('prompts', () => {
  it('lists both prompts with their arguments', async () => {
    const c = await setup();
    const { prompts } = await c.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['create_scenario', 'setup_checkout_tests']);
    const args = Object.fromEntries(prompts.map((p) => [p.name, p.arguments?.map((a) => a.name).sort()]));
    expect(args).toEqual({ setup_checkout_tests: ['target'], create_scenario: ['request', 'target'] });
    for (const p of prompts) expect(p.description?.length).toBeGreaterThan(40);
  });

  it('setup prompt names the tools in order and the 3-try limit', async () => {
    const c = await setup({ probe: true });
    const text = await promptText(c, 'setup_checkout_tests', { target: 'demo-local' });
    const order = ['list_scenarios', 'inspect_target', 'save_scenario', 'get_run_result'].map((t) =>
      text.indexOf(t),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toMatch(/3 tries/);
    expect(text).toContain('demo-local');
    expect(text).toContain('needs a human');
    expect(text).toContain('validate_on');
  });

  it('setup prompt has every step in order and the summary table', async () => {
    const c = await setup({ probe: true });
    const text = await promptText(c, 'setup_checkout_tests', { target: 'demo-local' });
    let last = -1;
    for (const step of SETUP_CHECKOUT_TESTS_STEPS) {
      const at = text.indexOf(step.replaceAll('{target}', 'demo-local'));
      expect(at, step.slice(0, 60)).toBeGreaterThan(last);
      last = at;
    }
    expect(text).toContain('| Scenario | What it proves | Verdict | Run id |');
    expect(text).toContain(SUMMARY_TEXT);
  });

  it('asks once for the probe and lists its side effects only when the probe is off', async () => {
    const off = await promptText(await setup({ probe: false }), 'setup_checkout_tests', {
      target: 'demo-local',
    });
    expect(off).toContain('Checkout probe: off');
    for (const effect of ['guest account', 'example.test', 'address', 'unpaid order draft', 'cart item']) {
      expect(off).toContain(effect);
    }
    expect(off).toContain('inspect.probe_checkout: true');
    expect(off).toMatch(/The user edits the config/);
    await client?.close();
    await rm(dir, { recursive: true, force: true });

    const on = await promptText(await setup({ probe: true }), 'setup_checkout_tests', {
      target: 'demo-local',
    });
    expect(on).toContain('Checkout probe: on');
  });

  it('carries the house rules and the writing rules', async () => {
    const text = await promptText(await setup({ probe: true }), 'setup_checkout_tests', {
      target: 'demo-local',
    });
    for (const id of [
      'param-described',
      'outcome-proves-order',
      'outcome-proves-no-success',
      'no-literal-personal-data',
      'id-format',
      'prefer-semantic-locator',
      'payment-step-hint',
      'url-glob-query',
      'test-data-email-domain',
      'test-data-card',
    ]) {
      expect(HOUSE_RULES_TEXT).toContain(`\`${id}\``);
    }
    expect(text).toContain(HOUSE_RULES_TEXT);
    expect(text).toContain(WRITING_RULES_TEXT);
    expect(text).toContain(FORMAT_TEXT);
    // The lessons from the first hand-made setup.
    expect(WRITING_RULES_TEXT).toMatch(/`response` check/);
    expect(WRITING_RULES_TEXT).toContain('exact: true');
    expect(WRITING_RULES_TEXT).toContain('url: { regex: "^https?://[^/]+/path/?(\\\\?.*)?$" }');
    expect(WRITING_RULES_TEXT).toContain('body_regex');
    expect(WRITING_RULES_TEXT).toContain('json_path');
    expect(WRITING_RULES_TEXT).toContain('three_ds');
    expect(WRITING_RULES_TEXT).toContain('combobox');
    expect(WRITING_RULES_TEXT).toMatch(/test card select/);
    expect(WRITING_RULES_TEXT).toContain('third_party_hosts');
  });

  it('names secret names and env vars, and never asks for a password in the chat', async () => {
    const text = await promptText(await setup({ probe: true }), 'setup_checkout_tests', {
      target: 'demo-local',
    });
    expect(text).toContain('member_email (env DEMO_MEMBER_EMAIL)');
    expect(text).toContain('member_password (env DEMO_MEMBER_PASSWORD)');
    expect(text).toMatch(/Never ask the user to paste a password/);
    expect(text).toContain('sandbox-pay.example.test');
  });

  it('tells the agent when the authoring folder or test data writes are off', async () => {
    const off = await promptText(await setup({ probe: true, authoring: false }), 'setup_checkout_tests', {
      target: 'demo-local',
    });
    expect(off).toContain('Authoring folder: not set');
    expect(off).toContain('AUTHORING_DISABLED');
    expect(off).toContain('Test data writes: off');
    await client?.close();
    await rm(dir, { recursive: true, force: true });

    const on = await promptText(await setup({ probe: true, testData: true }), 'setup_checkout_tests', {
      target: 'demo-local',
    });
    expect(on).toMatch(/Authoring folder: \S*scenarios\/demo-store\. /);
    expect(on).toContain('Test data writes: on');
  });

  it('returns only the stop text for an unknown target, also for an Object prototype name', async () => {
    const c = await setup({ probe: true });
    for (const target of ['no-such-shop', 'constructor', '__proto__', 'toString']) {
      for (const [name, extra] of [
        ['setup_checkout_tests', {}],
        ['create_scenario', { request: 'Pay with a card.' }],
      ] as const) {
        const text = await promptText(c, name, { target, ...extra });
        expect(text, `${name} ${target}`).toBe(
          `The config has no target "${target}". The targets are: demo-local. Show the user these names and stop. The user adds a target to the config and restarts the server.`,
        );
      }
    }
  });

  it('lists the fragments of the authoring folder with their args', async () => {
    const c = await setup({
      probe: true,
      authoringFiles: {
        'fragments/add-to-cart.yaml': `schema_version: 1
kind: fragment
id: local-add-to-cart
description: >-
  Opens a product page and adds
  the product to the cart.
args:
  product_path:
    description: Path of the product page.
  quantity:
    description: Number of units.
    default: 1
steps:
  - id: open
    title: Open the product
    goto: "{{args.product_path}}"
`,
        'pay.yaml': `schema_version: 1
kind: fragment
id: local-pay
description: Accepts the terms and pays.
steps:
  - id: pay
    title: Pay
    click: { role: button, name: Pay }
`,
      },
    });
    // The prompt reads the folder when it runs. A file that does not parse is left out.
    await writeFile(
      path.join(dir, 'scenarios/local/broken.yaml'),
      'kind: fragment\nid: [not valid\n',
      'utf8',
    );
    for (const [name, extra] of [
      ['setup_checkout_tests', {}],
      ['create_scenario', { request: 'Pay with a card.' }],
    ] as const) {
      const text = await promptText(c, name, { target: 'demo-local', ...extra });
      expect(text).toContain(
        '- fragments/add-to-cart.yaml (id local-add-to-cart): Opens a product page and adds the product to the cart. Args: product_path (Path of the product page.); quantity (Number of units. Default: 1.).',
      );
      expect(text).toContain('- pay.yaml (id local-pay): Accepts the terms and pays. No args.');
      expect(text).not.toContain('broken.yaml');
    }
  });

  it('says that the fragments are unknown without an authoring folder', async () => {
    const text = await promptText(await setup({ probe: true, authoring: false }), 'setup_checkout_tests', {
      target: 'demo-local',
    });
    expect(text).toContain('Fragments in the authoring folder: unknown');
  });

  it('tells the agent about restarts, cut results, blocked verdicts, and old reports', async () => {
    const text = await promptText(await setup({ probe: true }), 'setup_checkout_tests', {
      target: 'demo-local',
    });
    expect(text).toContain(CONFIG_CHANGES_TEXT);
    expect(text).toMatch(/works only after the user restarts the server/);
    expect(text).toMatch(/Wait until the user restarts the server before you run card scenarios/);
    expect(text).toMatch(/A "blocked" verdict that names a host is a config fix, not a try/);
    expect(text).toContain('`section`');
    expect(text).toContain('`slice.next_offset`');
    expect(text).not.toContain('report_path');
    expect(text).toContain('`reused_existing_inspection`');
    expect(text).toContain('setup-demo-local-<YYYYMMDD>-2');
    expect(text).toMatch(/When the verdict is not "passed"/);
    expect(text).toMatch(/test orders that the validation runs of `order_placed` scenarios placed/);
    expect(WRITING_RULES_TEXT).toContain('"**" plus `path_pattern`');
    expect(WRITING_RULES_TEXT).toMatch(/`wait_for` step with a `visible` check/);
    expect(WRITING_RULES_TEXT).toContain(`within: { frame: { css: "iframe[title='<title>']" } }`);
    expect(WRITING_RULES_TEXT).toContain('card_fields');
  });

  it('tells the agent in the server instructions to ask for the setup prompt', async () => {
    const c = await setup();
    expect(c.getInstructions()).toMatch(/ask the user to run the setup_checkout_tests prompt/i);
  });

  it('create_scenario reuses the latest finished inspection of the target', async () => {
    const c = await setup({
      probe: true,
      records: [
        record({}),
        record({
          inspection_id: 'insp_BBBBBBBBBBBBBBBB',
          idempotency_key: 'setup-demo-local-20261123',
          finished_at: '2026-11-23T10:05:00.000Z',
          checkout_probe: {
            reached: 'payment',
            stopped_reason: 'payment_step_reached',
            steps: [],
            dialogs: [],
            guest_option: true,
            payment: null,
            side_effects: [],
          },
        }),
        // Newer, but its probe did not reach the payment step.
        record({
          inspection_id: 'insp_EEEEEEEEEEEEEEEE',
          idempotency_key: 'setup-demo-local-20261123b',
          finished_at: '2026-11-23T12:05:00.000Z',
        }),
        // Newer, but code only: it has no site facts.
        record({
          inspection_id: 'insp_FFFFFFFFFFFFFFFF',
          idempotency_key: 'code-demo-local-20261124',
          scope: 'code',
          finished_at: '2026-11-24T12:05:00.000Z',
        }),
        // Newer, but interrupted: it has only part of the facts.
        record({
          inspection_id: 'insp_CCCCCCCCCCCCCCCC',
          idempotency_key: 'setup-demo-local-20261124',
          interrupted: true,
          finished_at: '2026-11-24T10:05:00.000Z',
        }),
        record({
          inspection_id: 'insp_DDDDDDDDDDDDDDDD',
          target: 'other-shop',
          idempotency_key: 'setup-other-shop-20261124',
          finished_at: '2026-11-24T11:05:00.000Z',
        }),
      ],
    });
    const text = await promptText(c, 'create_scenario', {
      target: 'demo-local',
      request: 'Pay with a gift card and check the remaining balance.',
    });
    expect(text).toContain('Pay with a gift card and check the remaining balance.');
    expect(text).toContain('idempotency_key "setup-demo-local-20261123"');
    expect(text).toMatch(/3 tries/);
    expect(text).toContain('fragment');
    expect(text).toContain(WRITING_RULES_TEXT);
    expect(text).toContain(HOUSE_RULES_TEXT);
    let last = -1;
    for (const step of CREATE_SCENARIO_STEPS) {
      const at = text.indexOf(step.replaceAll('{target}', 'demo-local'));
      expect(at, step.slice(0, 60)).toBeGreaterThan(last);
      last = at;
    }
  });

  it('create_scenario asks for a new inspection key when the target has none', async () => {
    const text = await promptText(await setup({ probe: true }), 'create_scenario', {
      target: 'demo-local',
      request: 'Check that a declined card shows an error.',
    });
    expect(text).toContain('No finished inspection exists for "demo-local"');
    expect(text).toContain('scenario-demo-local-');
    // One question: the probe question is part of step 3, not of the inspection step.
    const step2 = text.slice(text.indexOf('2. Get the facts'), text.indexOf('3. Find what'));
    const step3 = text.slice(text.indexOf('3. Find what'), text.indexOf('4. Reuse'));
    expect(step2).not.toMatch(/ask the user/i);
    expect(step3).toContain('inspect.probe_checkout: true');
    expect(step3).toContain('unpaid order draft');
    expect(step3).toMatch(/Ask the user once for all of it, in one message/);
  });
});
