import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load-config.js';
import type { SiteReport } from '../../src/inspect/crawl.js';
import { InspectionManager } from '../../src/inspect/manager.js';
import { silentLogger } from '../../src/logger.js';
import type { GuardedContext } from '../../src/runner/browser.js';
import type { ExecuteInput, ExecuteOutput } from '../../src/runner/executor.js';
import { BrowserSlots } from '../../src/runs/browser-slots.js';
import { RunManager } from '../../src/runs/manager.js';
import { RunStore } from '../../src/runs/store.js';
import { PRODUCTION_WARNING } from '../../src/safety/production.js';
import { ScenarioRegistry } from '../../src/scenarios/registry.js';
import { createServer } from '../../src/server.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

// The registered Stripe test number stands in for a live number. No new card literal enters the repo.
const LIVE_NUMBER = '4242424242424242';
const LIVE_ENV = { LIVE_VISA_NUMBER: LIVE_NUMBER, LIVE_VISA_EXPIRY: '12 / 34', LIVE_VISA_CVC: '123' };

let dir: string;
let client: Client | undefined;
let executions: ExecuteInput[];
let runs: RunManager | undefined;
let inspections: InspectionManager | undefined;

function execute(input: ExecuteInput): Promise<ExecuteOutput> {
  executions.push(input);
  return Promise.resolve({
    verdict: 'passed',
    failure: null,
    steps: input.steps.map((s) => ({ id: s.id, title: s.title, status: 'passed' })),
    outcome_checks: [],
    console_errors: [],
    network_failures: [],
    blocked_requests: [],
    screenshots: [],
    trace_path: null,
  });
}

const SITE: SiteReport = { pages: [], api_calls: [], blocked_hosts: [] };

async function setup() {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ctm-prod-'));
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
        // A production target on a local host. No test calls a real host.
        // A test target never shares a host with a production target, so this one is not "localhost".
        'demo-live': {
          profile: 'demo-store',
          environment: 'production',
          base_url: 'http://live.localhost:4173',
          allowed_hosts: ['live.localhost'],
          live_cards: {
            'company-visa': {
              number_env: 'LIVE_VISA_NUMBER',
              expiry_env: 'LIVE_VISA_EXPIRY',
              cvc_env: 'LIVE_VISA_CVC',
              behaviour: 'success',
              description: 'Company card for live checks.',
            },
          },
        },
      },
    },
    dir,
  );
  const registry = await ScenarioRegistry.load(config.scenario_dirs);
  const store = new RunStore(config.runs_dir);
  await store.init();
  const slots = new BrowserSlots(config.max_parallel_runs);
  runs = new RunManager({
    config,
    registry,
    store,
    logger: silentLogger,
    execute,
    env: { ...LIVE_ENV },
    slots,
  });
  inspections = new InspectionManager({
    config,
    logger: silentLogger,
    slots,
    phases: {
      openContext: async () =>
        ({ browser: {}, context: {}, close: async () => {} }) as unknown as GuardedContext,
      crawl: async () => SITE,
    },
  });
  await inspections.init();
  const server = createServer({ config, registry, manager: runs, inspections, logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { store, config };
}

// biome-ignore lint/suspicious/noExplicitAny: test helper over SDK result union
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  if (!client) throw new Error('call setup() first');
  return client.callTool({ name, arguments: args });
}

afterEach(async () => {
  await runs?.idle();
  await inspections?.idle();
  await client?.close();
  client = undefined;
  runs = undefined;
  inspections = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('run_scenario on a production target', () => {
  const args = {
    target: 'demo-live',
    scenario_id: 'card-success',
    params: { card: 'live/company-visa' },
    idempotency_key: 'prod-run-0001',
  };

  it('refuses a new run without confirm_production and writes no run record', async () => {
    const { store, config } = await setup();
    const res = await call('run_scenario', args);
    expect(res.isError).toBe(true);
    const error = res.structuredContent.error;
    expect(error.code).toBe('PRODUCTION_CONFIRMATION_REQUIRED');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain(PRODUCTION_WARNING);
    expect(error.next_actions).toContainEqual(expect.objectContaining({ kind: 'ask_human' }));
    expect(error.next_actions).toContainEqual(
      expect.objectContaining({
        kind: 'change_argument',
        tool: 'run_scenario',
        arguments: { confirm_production: true },
      }),
    );
    const change = error.next_actions.find((a: { kind: string }) => a.kind === 'change_argument');
    expect(change.description).toBe(
      'After the user agrees, call run_scenario for target "demo-live" and scenario "card-success" with confirm_production: true.',
    );
    expect(store.getKey(args.idempotency_key)).toBeUndefined();
    const entries = await readdir(config.runs_dir).catch(() => [] as string[]);
    expect(entries.filter((e) => e.startsWith('run_'))).toEqual([]);
    expect(executions).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain(LIVE_NUMBER);
  });

  it('starts a run with confirm_production and shows the warning', async () => {
    await setup();
    const res = await call('run_scenario', { ...args, confirm_production: true });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      environment: 'production',
      warning: PRODUCTION_WARNING,
      reused_existing_run: false,
    });
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    expect(JSON.stringify(res)).not.toContain(LIVE_NUMBER);
  });

  it('returns the existing run for the same key without the flag', async () => {
    await setup();
    const first = await call('run_scenario', { ...args, confirm_production: true });
    const again = await call('run_scenario', args);
    expect(again.isError).toBeFalsy();
    expect(again.structuredContent).toMatchObject({
      run_id: first.structuredContent.run_id,
      reused_existing_run: true,
      environment: 'production',
      warning: PRODUCTION_WARNING,
    });
    await vi.waitFor(() => expect(executions).toHaveLength(1));
  });

  it('keeps the flag out of the request hash', async () => {
    await setup();
    const first = await call('run_scenario', { ...args, confirm_production: true });
    const again = await call('run_scenario', { ...args, confirm_production: false });
    expect(again.isError).toBeFalsy();
    expect(again.structuredContent.run_id).toBe(first.structuredContent.run_id);
  });

  it('checks the target before the flag', async () => {
    await setup();
    const res = await call('run_scenario', { ...args, target: 'demo-liv' });
    expect(res.structuredContent.error.code).toBe('UNKNOWN_TARGET');
  });
});

describe('run_scenario on a test target', () => {
  it('ignores confirm_production and has no warning', async () => {
    await setup();
    for (const [flag, key] of [
      [true, 'test-run-flag-01'],
      [false, 'test-run-flag-02'],
    ] as const) {
      const res = await call('run_scenario', {
        target: 'demo-local',
        scenario_id: 'card-success',
        idempotency_key: key,
        confirm_production: flag,
      });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent.environment).toBe('test');
      expect(res.structuredContent).not.toHaveProperty('warning');
    }
  });

  it('refuses a live card id on a test target', async () => {
    await setup();
    const res = await call('run_scenario', {
      target: 'demo-local',
      scenario_id: 'card-success',
      params: { card: 'live/company-visa' },
      idempotency_key: 'test-run-live-01',
      confirm_production: true,
    });
    expect(res.structuredContent.error.code).toBe('INVALID_PARAMS');
  });
});

describe('list_scenarios with a production target', () => {
  it('lists the environment, the warning, and the live cards without digits', async () => {
    await setup();
    const res = await call('list_scenarios', {});
    expect(res.isError).toBeFalsy();
    const targets = res.structuredContent.targets;
    expect(targets.find((t: { name: string }) => t.name === 'demo-live')).toEqual({
      name: 'demo-live',
      description: '',
      profile: 'demo-store',
      base_url: 'http://live.localhost:4173',
      environment: 'production',
      warning: PRODUCTION_WARNING,
      live_cards: [
        { id: 'live/company-visa', behaviour: 'success', description: 'Company card for live checks.' },
      ],
    });
    const test = targets.find((t: { name: string }) => t.name === 'demo-local');
    expect(test).toMatchObject({ environment: 'test', live_cards: [] });
    expect(test).not.toHaveProperty('warning');
    expect(JSON.stringify(res)).not.toContain(LIVE_NUMBER);
  });
});

describe('inspect_target on a production target', () => {
  it('starts and puts the production warning first', async () => {
    await setup();
    const res = await call('inspect_target', {
      target: 'demo-live',
      idempotency_key: 'inspect-live-01',
      scope: 'site',
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.status).toBe('finished');
    expect(res.structuredContent.warnings[0]).toBe(PRODUCTION_WARNING);
    expect(res.structuredContent.warnings.slice(1)).not.toContain(PRODUCTION_WARNING);

    const slice = await call('inspect_target', {
      target: 'demo-live',
      idempotency_key: 'inspect-live-01',
      scope: 'site',
      section: 'pages',
    });
    expect(slice.isError).toBeFalsy();
    expect(slice.structuredContent.warnings[0]).toBe(PRODUCTION_WARNING);
  });

  it('has no production warning on a test target', async () => {
    await setup();
    const res = await call('inspect_target', {
      target: 'demo-local',
      idempotency_key: 'inspect-test-01',
      scope: 'site',
    });
    expect(res.structuredContent.warnings).not.toContain(PRODUCTION_WARNING);
  });
});

describe('RunManager.start on a production target', () => {
  it('refuses before prepare reads the live card env', async () => {
    const config = parseConfig(
      {
        runs_dir: path.join(os.tmpdir(), 'unused-runs'),
        scenario_dirs: [path.join(ROOT, 'scenarios')],
        test_data_dir: path.join(ROOT, 'test-data'),
        targets: {
          'demo-live': {
            profile: 'demo-store',
            environment: 'production',
            base_url: 'http://localhost:4173',
            allowed_hosts: ['localhost'],
            live_cards: {
              'company-visa': {
                number_env: 'LIVE_VISA_NUMBER',
                expiry_env: 'LIVE_VISA_EXPIRY',
                cvc_env: 'LIVE_VISA_CVC',
                behaviour: 'success',
              },
            },
          },
        },
      },
      ROOT,
    );
    dir = await mkdtemp(path.join(os.tmpdir(), 'ctm-prod-'));
    const store = new RunStore(path.join(dir, 'runs'));
    await store.init();
    const reads: string[] = [];
    const env = new Proxy({ ...LIVE_ENV } as NodeJS.ProcessEnv, {
      get(target, key) {
        if (typeof key === 'string' && key.startsWith('LIVE_')) reads.push(key);
        return target[key as string];
      },
    });
    const registry = await ScenarioRegistry.load(config.scenario_dirs);
    const m = new RunManager({ config, registry, store, logger: silentLogger, execute, env });
    await expect(
      m.start({
        target: 'demo-live',
        scenario_id: 'card-success',
        params: { card: 'live/company-visa' },
        idempotency_key: 'prod-unit-0001',
      }),
    ).rejects.toMatchObject({ code: 'PRODUCTION_CONFIRMATION_REQUIRED' });
    expect(reads).toEqual([]);
    expect(store.getKey('prod-unit-0001')).toBeUndefined();
  });
});
