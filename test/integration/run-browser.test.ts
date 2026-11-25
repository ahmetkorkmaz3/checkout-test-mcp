import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load-config.js';
import { silentLogger } from '../../src/logger.js';
import type { ExecuteInput, ExecuteOutput } from '../../src/runner/executor.js';
import { RunManager } from '../../src/runs/manager.js';
import { RunStore } from '../../src/runs/store.js';
import { ScenarioRegistry } from '../../src/scenarios/registry.js';

const SCENARIO = `
schema_version: 1
id: simple
title: Simple
summary: One step.
compatible_profiles: [demo-store]
expected_outcome: custom
steps:
  - id: open
    title: Open
    goto: /
`;

let dir: string;
let managers: RunManager[];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ctm-browser-'));
  managers = [];
  mkdirSync(path.join(dir, 'scenarios'));
  mkdirSync(path.join(dir, 'data'));
  writeFileSync(path.join(dir, 'scenarios/simple.yaml'), SCENARIO);
});

afterEach(async () => {
  await Promise.all(managers.map((m) => m.idle()));
  rmSync(dir, { recursive: true, force: true });
});

async function setup(execute: (i: ExecuteInput) => Promise<ExecuteOutput>) {
  const config = parseConfig(
    {
      runs_dir: path.join(dir, 'runs'),
      scenario_dirs: [path.join(dir, 'scenarios')],
      test_data_dir: path.join(dir, 'data'),
      targets: {
        local: { profile: 'demo-store', base_url: 'http://localhost:4173', allowed_hosts: ['localhost'] },
      },
    },
    dir,
  );
  const registry = await ScenarioRegistry.load(config.scenario_dirs);
  const store = new RunStore(config.runs_dir);
  await store.init();
  const m = new RunManager({ config, registry, store, logger: silentLogger, execute, env: {} });
  managers.push(m);
  return { m, store };
}

describe('browser on the run record', () => {
  it('shows the browser while the run is still running, and after a crash', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { m, store } = await setup(async (input) => {
      input.onBrowser?.({ name: 'chrome', version: '141.0.2' });
      await gate;
      throw new Error('Target closed');
    });
    const { record } = await m.start({
      target: 'local',
      scenario_id: 'simple',
      params: {},
      idempotency_key: 'browser-01',
    });
    expect(record.browser).toBeNull();
    await vi.waitFor(() => {
      const r = store.get(record.run_id);
      expect(r?.status).toBe('running');
      expect(r?.browser).toEqual({ name: 'chrome', version: '141.0.2' });
    });
    release();
    await m.idle();
    const done = store.get(record.run_id);
    expect(done?.verdict).toBe('error');
    expect(done?.browser).toEqual({ name: 'chrome', version: '141.0.2' });
  });
});
