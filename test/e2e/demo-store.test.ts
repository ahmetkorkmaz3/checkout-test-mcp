import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS example without types
import { startDemoStore } from '../../examples/demo-store/server.mjs';
import { parseConfig } from '../../src/config/load-config.js';
import { InspectionManager } from '../../src/inspect/manager.js';
import { silentLogger } from '../../src/logger.js';
import { RunManager } from '../../src/runs/manager.js';
import { RunStore } from '../../src/runs/store.js';
import { parseScenario, ScenarioRegistry } from '../../src/scenarios/registry.js';
import { createServer } from '../../src/server.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

let dir: string;
let store: {
  url: string;
  port: number;
  setBugs(b: string[]): void;
  close(): Promise<void>;
  stats: { orders: number };
  issuedOtps: string[];
};
let client: Client;

// biome-ignore lint/suspicious/noExplicitAny: test helper over SDK result union
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  return res;
}

// biome-ignore lint/suspicious/noExplicitAny: test helper
async function runToEnd(args: Record<string, unknown>): Promise<any> {
  const started = await call('run_scenario', args);
  expect(started.isError, JSON.stringify(started.structuredContent)).toBeFalsy();
  const runId = started.structuredContent.run_id as string;
  for (let i = 0; i < 12; i++) {
    const res = await call('get_run_result', { run_id: runId, wait_s: 20, detail: 'full' });
    if (res.structuredContent.status === 'finished') return res;
  }
  throw new Error('run did not finish');
}

const BLOCKED_SCENARIO = `
schema_version: 1
id: blocked-host-check
title: Opens a host outside the allowlist
summary: Safety test. Must end with verdict blocked.
compatible_profiles: [demo-store]
expected_outcome: custom
steps:
  - id: open_external
    title: Open an external page
    goto: https://example.com/
`;

const POPUP_SCENARIO = `
schema_version: 1
id: blocked-popup-check
title: Clicks a link that opens a blocked host in a new tab
summary: Safety test. The guard blocks the popup, and the run goes on.
compatible_profiles: [demo-store]
expected_outcome: custom
steps:
  - id: open
    title: Open the phone check page
    goto: /account/verify-phone
  - id: open_help
    title: Open the help center in a new tab
    click: { role: link, name: Help center }
  - id: still_here
    title: The run page stays usable
    click: { role: button, name: Send code }
    expect:
      - visible: { role: heading, name: Verify your phone }
`;

const NO_MATCH_SCENARIO = `
schema_version: 1
id: capture-regex-no-match
title: body_regex that no body matches
summary: Runner test. The capture step must fail with unexpected_response.
compatible_profiles: [demo-store]
expected_outcome: custom
steps:
  - id: open
    title: Open the page
    goto: /account/verify-phone-text
  - id: send_code
    title: Send the code
    click: { role: button, name: Send code }
    timeout_ms: 3000
    capture:
      - name: otp_code
        from_response: { method: POST, url: "**/api/otp/send-code-text**" }
        body_regex: 'Code=(\\d{5})'
`;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ctm-e2e-'));
  store = await startDemoStore({ port: 0 });
  const config = parseConfig(
    {
      runs_dir: path.join(dir, 'runs'),
      scenario_dirs: [path.join(ROOT, 'scenarios/demo-store')],
      test_data_dir: path.join(ROOT, 'test-data'),
      targets: { 'demo-local': { profile: 'demo-store', base_url: store.url, allowed_hosts: ['localhost'] } },
    },
    dir,
  );
  const loaded = await ScenarioRegistry.load(config.scenario_dirs);
  const registry = ScenarioRegistry.fromLoaded([
    ...loaded.list(),
    parseScenario(BLOCKED_SCENARIO, 'inline.yaml'),
    parseScenario(NO_MATCH_SCENARIO, 'inline-no-match.yaml'),
    parseScenario(POPUP_SCENARIO, 'inline-popup.yaml'),
  ]);
  const runStore = new RunStore(config.runs_dir);
  await runStore.init();
  const manager = new RunManager({ config, registry, store: runStore, logger: silentLogger });
  const server = createServer({
    config,
    registry,
    manager,
    inspections: new InspectionManager({ config, logger: silentLogger }),
    logger: silentLogger,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(ct);
});

afterAll(async () => {
  await client?.close();
  await store?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('demo store', () => {
  it('card-success places an order', async () => {
    const before = store.stats.orders;
    const res = await runToEnd({
      target: 'demo-local',
      scenario_id: 'card-success',
      idempotency_key: 'e2e-success-01',
    });
    expect(res.structuredContent.failure, res.structuredContent.summary).toBeNull();
    expect(res.structuredContent.verdict).toBe('passed');
    expect(res.structuredContent.outcome_checks.every((o: { status: string }) => o.status === 'passed')).toBe(
      true,
    );
    expect(store.stats.orders).toBe(before + 1);
  });

  let baselineId = '';
  it('card-3ds-challenge-fail passes when the store declines after a failed challenge', async () => {
    const before = store.stats.orders;
    const res = await runToEnd({
      target: 'demo-local',
      scenario_id: 'card-3ds-challenge-fail',
      idempotency_key: 'e2e-3ds-base-01',
    });
    expect(res.structuredContent.failure, res.structuredContent.summary).toBeNull();
    expect(res.structuredContent.verdict).toBe('passed');
    expect(store.stats.orders).toBe(before);
    baselineId = res.structuredContent.run_id;
  });

  it('detects a skipped 3DS challenge as a regression, with screenshot and next actions', async () => {
    store.setBugs(['skip-3ds']);
    try {
      const res = await runToEnd({
        target: 'demo-local',
        scenario_id: 'card-3ds-challenge-fail',
        idempotency_key: 'e2e-3ds-cand-01',
        options: { timeout_multiplier: 1 },
      });
      const out = res.structuredContent;
      expect(out.verdict).toBe('failed');
      expect(out.failure.step_id).toBe('submit_payment');
      expect(out.failure.category).toBe('element_not_found');
      expect(out.failure.page_url).toContain('/checkout/success');
      expect(out.failure.likely_causes.join(' ')).toMatch(/flow|3DS/);
      expect(out.failure.next_actions[0].kind).toBe('treat_as_regression');
      expect(existsSync(out.failure.screenshot)).toBe(true);
      expect(res.content.some((c: { type: string }) => c.type === 'image')).toBe(true);
      expect(JSON.stringify(out)).not.toContain('4000000000003220');

      const cmp = await call('compare_runs', { baseline_run_id: baselineId, candidate_run_id: out.run_id });
      expect(cmp.structuredContent.verdict).toBe('regression');
      expect(cmp.structuredContent.regressions[0]).toMatchObject({
        kind: 'step_failed',
        step_id: 'submit_payment',
      });
    } finally {
      store.setBugs([]);
    }
  });

  it('phone-otp-capture reads the SMS code from the response and never shows it', async () => {
    const res = await runToEnd({
      target: 'demo-local',
      scenario_id: 'phone-otp-capture',
      idempotency_key: 'e2e-otp-capture-01',
    });
    const out = res.structuredContent;
    expect(out.verdict, JSON.stringify(out.failure)).toBe('passed');
    expect(out.outcome_checks).toEqual([{ id: 'phone_verified', status: 'passed' }]);
    expect(store.issuedOtps).toHaveLength(1);
    const code = store.issuedOtps[0] as string;
    expect(JSON.stringify(res)).not.toContain(code);
    const runDir = path.join(dir, 'runs', out.run_id);
    const { readdir, readFile } = await import('node:fs/promises');
    for (const f of await readdir(runDir)) {
      if (f.endsWith('.json')) expect(await readFile(path.join(runDir, f), 'utf8')).not.toContain(code);
    }
  });

  it('phone-otp-capture-text reads the code from a text body with body_regex', async () => {
    const before = store.issuedOtps.length;
    const res = await runToEnd({
      target: 'demo-local',
      scenario_id: 'phone-otp-capture-text',
      idempotency_key: 'e2e-otp-capture-text-01',
    });
    const out = res.structuredContent;
    expect(out.verdict, JSON.stringify(out.failure)).toBe('passed');
    expect(store.issuedOtps).toHaveLength(before + 1);
    const code = store.issuedOtps.at(-1) as string;
    expect(JSON.stringify(res)).not.toContain(code);
    const runDir = path.join(dir, 'runs', out.run_id);
    const { readdir, readFile } = await import('node:fs/promises');
    for (const f of await readdir(runDir)) {
      if (f.endsWith('.json')) expect(await readFile(path.join(runDir, f), 'utf8')).not.toContain(code);
    }
  });

  it('fails a body_regex capture when no body matches, without showing the body', async () => {
    const res = await runToEnd({
      target: 'demo-local',
      scenario_id: 'capture-regex-no-match',
      idempotency_key: 'e2e-capture-no-match-01',
    });
    const out = res.structuredContent;
    expect(out.verdict).toBe('failed');
    expect(out.failure.step_id).toBe('send_code');
    expect(out.failure.category).toBe('unexpected_response');
    expect(out.failure.message).toMatch(/no body of .* matched body_regex/);
    expect(JSON.stringify(out)).not.toContain('Kod:');
  });

  it('blocks navigation to a host outside the allowlist', async () => {
    const res = await runToEnd({
      target: 'demo-local',
      scenario_id: 'blocked-host-check',
      idempotency_key: 'e2e-blocked-01',
    });
    expect(res.structuredContent.verdict).toBe('blocked');
    expect(res.structuredContent.failure.category).toBe('blocked_by_safety');
    expect(res.structuredContent.blocked_requests[0].url).toContain('example.com');
  });

  it('lists a blocked popup and does not stop the run', async () => {
    const res = await runToEnd({
      target: 'demo-local',
      scenario_id: 'blocked-popup-check',
      idempotency_key: 'e2e-blocked-popup-01',
    });
    const out = res.structuredContent;
    expect(out.verdict, JSON.stringify(out.failure)).toBe('passed');
    expect(out.blocked_requests).toContainEqual(
      expect.objectContaining({ url: expect.stringContaining('example.com/help'), step_id: 'open_help' }),
    );
  });
});
