import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load-config.js';
import { silentLogger } from '../../src/logger.js';
import type { ExecuteInput, ExecuteOutput } from '../../src/runner/executor.js';
import { RunManager } from '../../src/runs/manager.js';
import { RunStore } from '../../src/runs/store.js';
import { ScenarioRegistry } from '../../src/scenarios/registry.js';
import { createServer } from '../../src/server.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

let dir: string;
let client: Client;
let executions: ExecuteInput[];
let release: () => void;
let releaseAll: Array<() => void> = [];
let activeManager: RunManager | undefined;

function fakeExecute(input: ExecuteInput): Promise<ExecuteOutput> {
  executions.push(input);
  return new Promise((resolve) => {
    const done = () =>
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
      });
    releaseAll.push(done);
    // release() finishes every pending fake run.
    release = () => {
      for (const r of releaseAll.splice(0)) r();
    };
  });
}

async function setup(env: NodeJS.ProcessEnv = {}) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ctm-'));
  executions = [];
  const config = parseConfig(
    {
      runs_dir: path.join(dir, 'runs'),
      scenario_dirs: [path.join(ROOT, 'scenarios')],
      test_data_dir: path.join(ROOT, 'test-data'),
      targets: {
        'demo-local': {
          profile: 'demo-store',
          base_url: 'http://localhost:4173',
          allowed_hosts: ['localhost'],
        },
        saucedemo: {
          profile: 'saucedemo',
          base_url: 'https://www.saucedemo.com',
          allowed_hosts: ['www.saucedemo.com'],
          allow_unlabeled_host: true,
          secrets: { username: 'SD_USER', password: 'SD_PASS' },
        },
      },
      production_hosts: ['saucelabs.com'],
    },
    dir,
  );
  const registry = await ScenarioRegistry.load(config.scenario_dirs);
  const store = new RunStore(config.runs_dir);
  await store.init();
  const manager = new RunManager({
    config,
    registry,
    store,
    logger: silentLogger,
    execute: fakeExecute,
    env,
  });
  const server = createServer({ config, registry, manager, logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { manager, store, config, registry };
}

// biome-ignore lint/suspicious/noExplicitAny: test helper over SDK result union
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  return client.callTool({ name, arguments: args });
}

beforeEach(() => {
  releaseAll = [];
  release = () => {};
  activeManager = undefined;
});

afterEach(async () => {
  release();
  // Background runs write to the runs dir. Wait for them before the folder is removed.
  await activeManager?.idle();
  await client?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('tools/list', () => {
  it('exposes the expected tools with descriptions and schemas', async () => {
    await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'compare_runs',
      'get_run_result',
      'list_scenarios',
      'run_scenario',
      'save_scenario',
    ]);
    for (const t of tools) {
      expect(t.description?.length ?? 0).toBeGreaterThan(100);
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema?.type).toBe('object');
    }
    const run = tools.find((t) => t.name === 'run_scenario');
    expect(run?.inputSchema.required).toEqual(
      expect.arrayContaining(['target', 'scenario_id', 'idempotency_key']),
    );
    expect(run?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    await expect(JSON.stringify(tools, null, 2)).toMatchFileSnapshot('./__snapshots__/tools-list.json');
  });
});

describe('list_scenarios', () => {
  it('returns targets, scenarios, and test cards without card numbers', async () => {
    await setup();
    const res = await call('list_scenarios', { target: 'demo-local' });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent;
    expect(out.scenarios.map((s: { id: string }) => s.id).sort()).toEqual([
      'card-3ds-challenge-fail',
      'card-success',
      'phone-otp-capture',
      'phone-otp-capture-text',
    ]);
    expect(out.test_cards.length).toBeGreaterThan(3);
    expect(JSON.stringify(out)).not.toMatch(/4242424242424242/);
  });
});

describe('run_scenario and get_run_result', () => {
  it('starts a run, returns run_id at once, and reports the verdict', async () => {
    const { manager } = await setup();
    const res = await call('run_scenario', {
      target: 'demo-local',
      scenario_id: 'card-3ds-challenge-fail',
      idempotency_key: 'test-run-0001',
    });
    expect(res.isError).toBeFalsy();
    const runId = res.structuredContent.run_id;
    expect(runId).toMatch(/^run_/);
    expect(res.structuredContent.next).toMatchObject({
      tool: 'get_run_result',
      arguments: { run_id: runId },
    });

    // Card number is rendered into the steps for the browser, but never into stored params.
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    expect(JSON.stringify(executions[0]?.steps)).toContain('4000000000003220');
    expect(JSON.stringify(manager.get(runId).params)).not.toContain('4000000000003220');

    const pending = await call('get_run_result', { run_id: runId });
    expect(pending.structuredContent.status).toBe('running');
    expect(pending.structuredContent.verdict).toBeNull();

    release();
    const done = await call('get_run_result', { run_id: runId, wait_s: 5 });
    expect(done.structuredContent).toMatchObject({ status: 'finished', verdict: 'passed' });
    expect(done.structuredContent.summary).toMatch(/passed/);
  });

  it('returns the same run for the same idempotency key and never starts a second one', async () => {
    await setup();
    const args = { target: 'demo-local', scenario_id: 'card-success', idempotency_key: 'same-key-0001' };
    const [a, b] = await Promise.all([call('run_scenario', args), call('run_scenario', args)]);
    const c = await call('run_scenario', args);
    expect(a.structuredContent.run_id).toBe(b.structuredContent.run_id);
    expect(c.structuredContent.run_id).toBe(a.structuredContent.run_id);
    expect(c.structuredContent.reused_existing_run).toBe(true);
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(executions).toHaveLength(1);
  });

  it('keeps the idempotency key after a restart', async () => {
    const { config, registry } = await setup();
    const args = { target: 'demo-local', scenario_id: 'card-success', idempotency_key: 'restart-key-01' };
    const first = await call('run_scenario', args);
    release();
    await new Promise((r) => setTimeout(r, 50));

    const store2 = new RunStore(config.runs_dir);
    await store2.init();
    const manager2 = new RunManager({
      config,
      registry,
      store: store2,
      logger: silentLogger,
      execute: fakeExecute,
    });
    const again = await manager2.start({ ...args, params: {} });
    expect(again.reused).toBe(true);
    expect(again.record.run_id).toBe(first.structuredContent.run_id);
    expect(executions).toHaveLength(1);
  });

  it('marks a run that was running during a restart as error and does not repeat it', async () => {
    const { config, registry } = await setup();
    const first = await call('run_scenario', {
      target: 'demo-local',
      scenario_id: 'card-success',
      idempotency_key: 'crash-key-001',
    });
    await new Promise((r) => setTimeout(r, 50));
    const store2 = new RunStore(config.runs_dir);
    const interrupted = await store2.init();
    const manager2 = new RunManager({
      config,
      registry,
      store: store2,
      logger: silentLogger,
      execute: fakeExecute,
    });
    await manager2.recover(interrupted);
    const r = manager2.get(first.structuredContent.run_id);
    expect(r).toMatchObject({ status: 'finished', verdict: 'error' });
    expect(r.failure?.category).toBe('server_restarted');
    expect(executions).toHaveLength(1);
  });
});

describe('structured errors', () => {
  it('suggests the closest target for a typo', async () => {
    await setup();
    const res = await call('run_scenario', {
      target: 'demo-locl',
      scenario_id: 'card-success',
      idempotency_key: 'err-key-0001',
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({
      code: 'UNKNOWN_TARGET',
      retryable: false,
      details: { closest_match: 'demo-local' },
    });
    expect(res.structuredContent.error.next_actions[0]).toMatchObject({
      kind: 'change_argument',
      arguments: { target: 'demo-local' },
    });
  });

  it('refuses a card number in params without echoing it', async () => {
    await setup();
    const res = await call('run_scenario', {
      target: 'demo-local',
      scenario_id: 'card-success',
      params: { product_path: '/p/4111111111111111' },
      idempotency_key: 'err-key-0002',
    });
    expect(res.structuredContent.error.code).toBe('REAL_CARD_DATA_REFUSED');
    expect(JSON.stringify(res)).not.toContain('4111111111111111');
  });

  it('refuses secrets in arguments', async () => {
    await setup();
    const res = await call('run_scenario', {
      target: 'demo-local',
      scenario_id: 'card-success',
      params: { product_path: 'password=hunter2' },
      idempotency_key: 'err-key-0003',
    });
    expect(res.structuredContent.error.code).toBe('SECRET_IN_ARGUMENTS');
  });

  it('refuses an incompatible scenario and a wrong card behaviour', async () => {
    await setup();
    const a = await call('run_scenario', {
      target: 'saucedemo',
      scenario_id: 'card-success',
      idempotency_key: 'err-key-0004',
    });
    expect(a.structuredContent.error.code).toBe('SCENARIO_NOT_COMPATIBLE');
    const b = await call('run_scenario', {
      target: 'demo-local',
      scenario_id: 'card-3ds-challenge-fail',
      params: { card: 'stripe/visa-success' },
      idempotency_key: 'err-key-0005',
    });
    expect(b.structuredContent.error.code).toBe('INVALID_PARAMS');
    expect(b.structuredContent.error.likely_cause).toContain('stripe/3ds2-challenge-required');
  });

  it('reports missing env secrets', async () => {
    await setup();
    const res = await call('run_scenario', {
      target: 'saucedemo',
      scenario_id: 'saucedemo-guest-checkout',
      idempotency_key: 'err-key-0006',
    });
    expect(res.structuredContent.error.code).toBe('MISSING_ENV_SECRET');
    expect(res.structuredContent.error.next_actions[0].kind).toBe('ask_human');
  });

  it('refuses a reused key with other arguments', async () => {
    await setup();
    await call('run_scenario', {
      target: 'demo-local',
      scenario_id: 'card-success',
      idempotency_key: 'conflict-key-1',
    });
    const res = await call('run_scenario', {
      target: 'demo-local',
      scenario_id: 'card-success',
      params: { quantity: 2 },
      idempotency_key: 'conflict-key-1',
    });
    expect(res.structuredContent.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('reports an unknown run and an unfinished compare', async () => {
    await setup();
    const a = await call('get_run_result', { run_id: 'run_zzzzzzzzzzzzzzzz' });
    expect(a.structuredContent.error.code).toBe('RUN_NOT_FOUND');
    const started = await call('run_scenario', {
      target: 'demo-local',
      scenario_id: 'card-success',
      idempotency_key: 'compare-key-1',
    });
    const id = started.structuredContent.run_id;
    const b = await call('compare_runs', { baseline_run_id: id, candidate_run_id: id });
    expect(b.structuredContent.error.code).toBe('RUN_NOT_FINISHED');
  });

  it('rejects a bad run_id format at the schema level', async () => {
    await setup();
    const res = await call('get_run_result', { run_id: 'nope' });
    expect(res.isError).toBe(true);
  });
});
