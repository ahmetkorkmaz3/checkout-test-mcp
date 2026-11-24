import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaPathFor } from '../../src/authoring/save.js';
import { parseConfig } from '../../src/config/load-config.js';
import { silentLogger } from '../../src/logger.js';
import type { ExecuteInput, ExecuteOutput } from '../../src/runner/executor.js';
import { RunManager } from '../../src/runs/manager.js';
import { RunStore } from '../../src/runs/store.js';
import { ScenarioRegistry } from '../../src/scenarios/registry.js';
import { createServer } from '../../src/server.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

let dir: string;
let client: Client | undefined;
let manager: RunManager | undefined;
let pending: Array<() => void> = [];

/** Fake runs stay queued or running until the test releases them. */
function fakeExecute(input: ExecuteInput): Promise<ExecuteOutput> {
  return new Promise((resolve) => {
    pending.push(() =>
      resolve({
        verdict: 'passed',
        failure: null,
        steps: input.steps.map((s) => ({ id: s.id, title: s.title, status: 'passed', duration_ms: 10 })),
        outcome_checks: input.outcome.map((o) => ({ id: o.id, status: 'passed' })),
        console_errors: [],
        network_failures: [],
        blocked_requests: [],
        screenshots: [],
        trace_path: null,
      }),
    );
  });
}

type Authoring = 'on' | 'off' | 'test-data';

async function setup(authoring: Authoring = 'on') {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ctm-save-'));
  // Copies, so the tests never write to the scenario files of the repo.
  await cp(path.join(ROOT, 'scenarios'), path.join(dir, 'scenarios'), { recursive: true });
  await cp(path.join(ROOT, 'test-data'), path.join(dir, 'test-data'), { recursive: true });
  const config = parseConfig(
    {
      runs_dir: path.join(dir, 'runs'),
      scenario_dirs: [path.join(dir, 'scenarios')],
      test_data_dir: path.join(dir, 'test-data'),
      targets: {
        'demo-local': {
          profile: 'demo-store',
          base_url: 'http://localhost:4173',
          allowed_hosts: ['localhost'],
        },
        'demo-local-two': {
          profile: 'demo-store',
          base_url: 'http://127.0.0.1:4173',
          allowed_hosts: ['127.0.0.1'],
        },
      },
      ...(authoring === 'off'
        ? {}
        : {
            authoring: {
              dir: path.join(dir, 'scenarios'),
              test_data_dir_writable: authoring === 'test-data',
            },
          }),
    },
    dir,
  );
  const registry = await ScenarioRegistry.load(config.scenario_dirs);
  const store = new RunStore(config.runs_dir);
  await store.init();
  manager = new RunManager({ config, registry, store, logger: silentLogger, execute: fakeExecute, env: {} });
  const server = createServer({ config, registry, manager, logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
}

// biome-ignore lint/suspicious/noExplicitAny: test helper over SDK result union
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  if (!client) throw new Error('call setup() first');
  return client.callTool({ name, arguments: args });
}

const scenarioFile = (rel: string) => path.join(dir, 'scenarios', rel);

beforeEach(() => {
  pending = [];
  client = undefined;
  manager = undefined;
});

afterEach(async () => {
  // Release the fake runs until the manager is idle, so no run writes after the folder is gone.
  let settled = false;
  const idle = manager?.idle().finally(() => {
    settled = true;
  });
  while (idle && !settled) {
    for (const done of pending.splice(0)) done();
    await new Promise((r) => setTimeout(r, 1));
  }
  await idle;
  await client?.close();
  await rm(dir, { recursive: true, force: true });
});

const VALID = `id: new-one
title: Open the product page
summary: Opens a product page, places an order, and checks the confirmation.
compatible_profiles: [demo-store]
expected_outcome: order_placed
params:
  product_path:
    type: string
    default: /products/ceramic-mug
    description: Path of the product page.
steps:
  - id: open_product
    title: Open the product page
    goto: "{{params.product_path}}"
outcome:
  - id: confirmation_shown
    visible: { role: heading, name: { matches: "thank you" } }
  - id: order_created
    response: { method: POST, url: "**/api/orders", status: 201 }
`;

const VALID_CHANGED = VALID.replace('"thank you"', '"order received"');

const WEAK_ORDER_SCENARIO = VALID.replace(/ {2}- id: order_created\n.*\n/, '');

const DUPLICATE_ID_SCENARIO = VALID.replace('id: new-one', 'id: card-success');

describe('save_scenario', () => {
  it('saves a valid scenario, swaps the registry, and starts a validation run', async () => {
    await setup();
    const res = await call('save_scenario', {
      kind: 'scenario',
      path: 'guest/new-one.yaml',
      yaml: VALID,
      validate_on: { target: 'demo-local' },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      path: 'guest/new-one.yaml',
      kind: 'scenario',
      written: true,
      unchanged: false,
      scenario_id: 'new-one',
      validation: { status: 'queued', reused_existing_run: false },
      next: { tool: 'get_run_result', arguments: { wait_s: 20 } },
    });
    expect(res.structuredContent.fixes_applied).toHaveLength(2);
    const text = await readFile(scenarioFile('guest/new-one.yaml'), 'utf8');
    expect(text).toMatch(/^# yaml-language-server: \$schema=\/.*schemas\/scenario\.schema\.json\n/);
    expect(text).toContain('schema_version: 1');
    const list = await call('list_scenarios', {});
    expect(list.structuredContent.scenarios.map((s: { id: string }) => s.id)).toContain('new-one');
  });

  it('same content twice is unchanged and reuses the run', async () => {
    await setup();
    const args = {
      kind: 'scenario',
      path: 'guest/new-one.yaml',
      yaml: VALID,
      validate_on: { target: 'demo-local' },
    };
    const first = await call('save_scenario', args);
    const second = await call('save_scenario', args);
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent).toMatchObject({
      written: false,
      unchanged: true,
      validation: { run_id: first.structuredContent.validation.run_id, reused_existing_run: true },
    });
  });

  it('a fixed file gets a new validation run', async () => {
    await setup();
    const first = await call('save_scenario', {
      kind: 'scenario',
      path: 'guest/new-one.yaml',
      yaml: VALID,
      validate_on: { target: 'demo-local' },
    });
    const second = await call('save_scenario', {
      kind: 'scenario',
      path: 'guest/new-one.yaml',
      yaml: VALID_CHANGED,
      overwrite: true,
      validate_on: { target: 'demo-local' },
    });
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent).toMatchObject({ written: true, unchanged: false });
    expect(second.structuredContent.validation.reused_existing_run).toBe(false);
    expect(second.structuredContent.validation.run_id).not.toBe(first.structuredContent.validation.run_id);
    expect(await readFile(scenarioFile('guest/new-one.yaml'), 'utf8')).toContain('order received');
  });

  it('the same file on two targets gives two runs', async () => {
    await setup();
    const save = (target: string) =>
      call('save_scenario', {
        kind: 'scenario',
        path: 'guest/new-one.yaml',
        yaml: VALID,
        validate_on: { target },
      });
    const first = await save('demo-local');
    const second = await save('demo-local-two');
    expect(second.isError).toBeFalsy();
    expect(second.structuredContent).toMatchObject({
      unchanged: true,
      validation: { reused_existing_run: false },
    });
    expect(second.structuredContent.validation.run_id).not.toBe(first.structuredContent.validation.run_id);
  });

  describe('secret check on a key with a template value', () => {
    const FRAGMENT = `kind: fragment
id: member-login
description: Fills the member password.
args:
  password:
    description: The member password, from a secret.
steps:
  - id: fill_password
    title: Fill the password
    fill: { label: Password }
    value: "{{args.password}}"
`;
    const withPassword = (value: string) =>
      VALID.replace(
        '    goto: "{{params.product_path}}"\n',
        `    goto: "{{params.product_path}}"\n  - id: login\n    title: Log in\n    include: member-login.yaml\n    with: { password: ${value} }\n`,
      );

    it('allows a key whose value is only a template', async () => {
      await setup();
      const frag = await call('save_scenario', {
        kind: 'fragment',
        path: 'guest/member-login.yaml',
        yaml: FRAGMENT,
      });
      expect(frag.structuredContent).toMatchObject({ written: true });
      const res = await call('save_scenario', {
        kind: 'scenario',
        path: 'guest/new-one.yaml',
        yaml: withPassword('"{{secrets.member_password}}"'),
      });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent.written).toBe(true);
    });

    it('refuses a literal secret on the line below its key', async () => {
      await setup();
      const res = await call('save_scenario', {
        kind: 'scenario',
        path: 'guest/new-one.yaml',
        yaml: `${VALID}# password:\n#   hunter2-literal\n`,
      });
      expect(res.structuredContent.error.code).toBe('SECRET_IN_ARGUMENTS');
    });

    it('refuses a literal secret-looking value', async () => {
      await setup();
      await call('save_scenario', { kind: 'fragment', path: 'guest/member-login.yaml', yaml: FRAGMENT });
      const res = await call('save_scenario', {
        kind: 'scenario',
        path: 'guest/new-one.yaml',
        yaml: withPassword('"hunter2-not-a-template"'),
      });
      expect(res.structuredContent.error.code).toBe('SECRET_IN_ARGUMENTS');
      expect(existsSync(scenarioFile('guest/new-one.yaml'))).toBe(false);
    });
  });

  it('returns warnings and no validation run without validate_on', async () => {
    await setup();
    const yaml = VALID.replace(
      '    goto: "{{params.product_path}}"\n',
      '    goto: "{{params.product_path}}"\n  - id: pay\n    title: Pay\n    click: { css: "#pay" }\n',
    );
    const res = await call('save_scenario', { kind: 'scenario', path: 'guest/new-one.yaml', yaml });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.validation).toBeNull();
    expect(res.structuredContent.next).toMatchObject({ tool: 'run_scenario' });
    expect(res.structuredContent.warnings.map((w: { rule: string }) => w.rule).sort()).toEqual([
      'payment-step-hint',
      'prefer-semantic-locator',
    ]);
  });

  it.each([
    ['AUTHORING_DISABLED', 'off', VALID, 'guest/x.yaml'],
    ['PATH_REFUSED', 'on', VALID, '../x.yaml'],
    ['SCENARIO_INVALID', 'on', WEAK_ORDER_SCENARIO, 'guest/x.yaml'],
    ['SCENARIO_INVALID', 'on', DUPLICATE_ID_SCENARIO, 'guest/x.yaml'],
    ['SCENARIO_INVALID', 'on', 'id: [not closed', 'guest/x.yaml'],
    ['REAL_CARD_DATA_REFUSED', 'on', `${VALID}\n# 4000 0000 0000 0002`, 'guest/x.yaml'],
    ['SECRET_IN_ARGUMENTS', 'on', `${VALID}\n# token=abcdef123456`, 'guest/x.yaml'],
  ] as const)('refuses with %s and writes nothing', async (code, authoring, yaml, p) => {
    await setup(authoring);
    const res = await call('save_scenario', { kind: 'scenario', path: p, yaml });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe(code);
    expect(res.structuredContent.error.next_actions.length).toBeGreaterThan(0);
    expect(existsSync(scenarioFile('guest/x.yaml'))).toBe(false);
    expect(existsSync(path.join(dir, 'x.yaml'))).toBe(false);
    // Refusals never echo a card number.
    expect(JSON.stringify(res)).not.toContain('4000 0000 0000 0002');
  });

  it('gives every rule issue in details.issues', async () => {
    await setup();
    const res = await call('save_scenario', {
      kind: 'scenario',
      path: 'guest/x.yaml',
      yaml: WEAK_ORDER_SCENARIO,
    });
    expect(res.structuredContent.error.details.issues).toEqual([
      expect.objectContaining({ rule: 'outcome-proves-order', severity: 'error', path: 'outcome' }),
    ]);
  });

  it('refuses SCENARIO_EXISTS for different content without overwrite and keeps the old file', async () => {
    await setup();
    await call('save_scenario', { kind: 'scenario', path: 'guest/x.yaml', yaml: VALID });
    const before = await readFile(scenarioFile('guest/x.yaml'), 'utf8');
    const res = await call('save_scenario', { kind: 'scenario', path: 'guest/x.yaml', yaml: VALID_CHANGED });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('SCENARIO_EXISTS');
    expect(await readFile(scenarioFile('guest/x.yaml'), 'utf8')).toBe(before);
  });

  it('refuses validate_on for a kind other than scenario', async () => {
    await setup('test-data');
    const res = await call('save_scenario', {
      kind: 'test_data',
      path: 'customers/x.yaml',
      yaml: 'email: a@example.test\n',
      validate_on: { target: 'demo-local' },
    });
    expect(res.structuredContent.error.code).toBe('INVALID_PARAMS');
    expect(existsSync(path.join(dir, 'test-data/customers/x.yaml'))).toBe(false);
  });

  it('refuses a fragment change that breaks an including scenario', async () => {
    await setup();
    const rel = 'demo-store/fragments/add-to-cart.yaml';
    const old = await readFile(scenarioFile(rel), 'utf8');
    // A new arg without a default breaks every scenario that includes the fragment without it.
    const broken = old.replace('args:\n', 'args:\n  sku:\n    description: Product SKU.\n');
    const res = await call('save_scenario', { kind: 'fragment', path: rel, yaml: broken, overwrite: true });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('SCENARIO_INVALID');
    const messages = res.structuredContent.error.details.issues.map((i: { message: string }) => i.message);
    expect(messages).toContain(
      'scenarios/demo-store/card-success.yaml: step "cart": fragment "demo-add-to-cart" needs arg "sku".',
    );
    expect(await readFile(scenarioFile(rel), 'utf8')).toBe(old);
  });

  it('saves a fragment change that keeps the including scenarios valid', async () => {
    await setup();
    const rel = 'demo-store/fragments/add-to-cart.yaml';
    const old = await readFile(scenarioFile(rel), 'utf8');
    const changed = old.replace('Open the product page', 'Open the product detail page');
    const res = await call('save_scenario', { kind: 'fragment', path: rel, yaml: changed, overwrite: true });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ kind: 'fragment', scenario_id: null, written: true });
    expect(await readFile(scenarioFile(rel), 'utf8')).toBe(changed);
  });

  it('writes test data only with the flag and a reserved email domain', async () => {
    const rel = 'customers/new-guest.yaml';
    const file = () => path.join(dir, 'test-data', rel);
    await setup('on');
    const off = await call('save_scenario', {
      kind: 'test_data',
      path: rel,
      yaml: 'email: a@example.test\n',
    });
    expect(off.structuredContent.error.code).toBe('AUTHORING_DISABLED');
    expect(off.structuredContent.error.next_actions[0].description).toContain('test_data_dir_writable');
    expect(existsSync(file())).toBe(false);
    await client?.close();
    await rm(dir, { recursive: true, force: true });

    await setup('test-data');
    const bad = await call('save_scenario', { kind: 'test_data', path: rel, yaml: 'email: a@gmail.com\n' });
    expect(bad.structuredContent.error.code).toBe('SCENARIO_INVALID');
    expect(bad.structuredContent.error.details.issues[0].rule).toBe('test-data-email-domain');
    expect(JSON.stringify(bad)).not.toContain('gmail');
    expect(existsSync(file())).toBe(false);

    const ok = await call('save_scenario', {
      kind: 'test_data',
      path: rel,
      yaml: 'email: a@example.test\nfull_name: Test Guest\n',
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ kind: 'test_data', written: true, fixes_applied: [] });
    // Test data gets no schema line.
    expect(await readFile(file(), 'utf8')).toBe('email: a@example.test\nfull_name: Test Guest\n');
  });

  it('says that the file was saved when the validation run does not start', async () => {
    await setup();
    const res = await call('save_scenario', {
      kind: 'scenario',
      path: 'guest/new-one.yaml',
      yaml: VALID,
      validate_on: { target: 'demo-locl' },
    });
    expect(res.structuredContent.error.code).toBe('UNKNOWN_TARGET');
    expect(res.structuredContent.error.message).toContain('was saved');
    expect(res.structuredContent.error.details).toMatchObject({ saved: true, path: 'guest/new-one.yaml' });
    expect(existsSync(scenarioFile('guest/new-one.yaml'))).toBe(true);
  });

  it('uses a relative schema path for a file inside the package', () => {
    expect(schemaPathFor('scenario', path.join(ROOT, 'scenarios/guest/a.yaml'))).toBe(
      '../../schemas/scenario.schema.json',
    );
    expect(schemaPathFor('fragment', '/elsewhere/a.yaml')).toBe(
      path.join(ROOT, 'schemas/fragment.schema.json'),
    );
  });

  it('refuses a path that leaves the folder through a symlink', async () => {
    await setup();
    await mkdir(path.join(dir, 'outside'));
    await symlink(path.join(dir, 'outside'), scenarioFile('escape'));
    const res = await call('save_scenario', { kind: 'scenario', path: 'escape/x.yaml', yaml: VALID });
    expect(res.structuredContent.error.code).toBe('PATH_REFUSED');
    expect(existsSync(path.join(dir, 'outside/x.yaml'))).toBe(false);
  });
});
