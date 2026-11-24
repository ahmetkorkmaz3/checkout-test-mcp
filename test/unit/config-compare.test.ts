import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareRuns } from '../../src/compare/compare.js';
import { ConfigError, parseConfig } from '../../src/config/load-config.js';
import type { RunRecord } from '../../src/schemas/run.js';

describe('config', () => {
  const base = {
    targets: {
      local: { profile: 'demo-store', base_url: 'http://localhost:4173', allowed_hosts: ['localhost'] },
    },
  };

  it('accepts a local target and resolves paths', () => {
    const cfg = parseConfig(base, '/tmp/proj');
    expect(cfg.runs_dir).toBe('/tmp/proj/.checkout-test-mcp/runs');
    expect(cfg.targets.local?.test_id_attribute).toBe('data-testid');
  });

  it('refuses a production-looking host', () => {
    const raw = {
      targets: { prod: { profile: 'p', base_url: 'https://www.shop.com', allowed_hosts: ['www.shop.com'] } },
    };
    expect(() => parseConfig(raw, '/tmp')).toThrow(ConfigError);
  });

  it('refuses allow_unlabeled_host without production_hosts', () => {
    const raw = {
      targets: {
        x: {
          profile: 'p',
          base_url: 'https://checkout.shop.com',
          allowed_hosts: ['checkout.shop.com'],
          allow_unlabeled_host: true,
        },
      },
    };
    expect(() => parseConfig(raw, '/tmp')).toThrow(/production_hosts/);
  });

  it('refuses a base_url host outside allowed_hosts', () => {
    const raw = {
      targets: { x: { profile: 'p', base_url: 'http://localhost:1', allowed_hosts: ['shop.test'] } },
    };
    expect(() => parseConfig(raw, '/tmp')).toThrow(/not in allowed_hosts/);
  });

  it('refuses unknown keys', () => {
    expect(() => parseConfig({ ...base, typo_key: 1 }, '/tmp')).toThrow(ConfigError);
  });

  describe('authoring and inspect blocks', () => {
    const dir = '/tmp/proj';
    const target = base.targets.local;

    it('refuses authoring.dir outside scenario_dirs', () => {
      expect(() => parseConfig({ ...base, authoring: { dir: '/tmp/elsewhere' } }, dir)).toThrow(
        /authoring.dir must be inside one of scenario_dirs/,
      );
    });

    it('accepts authoring.dir inside a scenario dir and resolves it', () => {
      const c = parseConfig({ ...base, scenario_dirs: ['./s'], authoring: { dir: './s/local' } }, dir);
      expect(c.authoring?.dir).toBe(path.join(dir, 's/local'));
      expect(c.authoring?.test_data_dir_writable).toBe(false);
    });

    it('defaults the inspect block and keeps the probe off', () => {
      const c = parseConfig({ ...base, targets: { t: { ...target, inspect: {} } } }, dir);
      expect(c.targets.t?.inspect).toMatchObject({
        start_paths: ['/'],
        max_pages: 25,
        probe_checkout: false,
      });
    });

    it('resolves inspect.source_dirs to absolute paths', () => {
      const c = parseConfig(
        { ...base, targets: { t: { ...target, inspect: { source_dirs: ['./src-x'] } } } },
        dir,
      );
      expect(c.targets.t?.inspect?.source_dirs).toEqual([path.join(dir, 'src-x')]);
    });

    it('refuses inspect.max_pages above 100', () => {
      expect(() =>
        parseConfig({ ...base, targets: { t: { ...target, inspect: { max_pages: 101 } } } }, dir),
      ).toThrow(ConfigError);
    });
  });
});

function record(over: Partial<RunRecord>): RunRecord {
  return {
    run_id: 'run_aaaaaaaaaaaaaaaa',
    idempotency_key: 'k-00000001',
    request_hash: 'h',
    scenario_id: 's',
    scenario_hash: 'x',
    target: 't',
    params: {},
    options: { timeout_multiplier: 1, capture: 'failure_only', trace: false },
    status: 'finished',
    verdict: 'passed',
    summary: '',
    created_at: '2026-11-22T00:00:00.000Z',
    started_at: '2026-11-22T00:00:00.000Z',
    finished_at: '2026-11-22T00:00:10.000Z',
    duration_ms: 10000,
    progress: { completed_steps: 2, total_steps: 2, current_step_id: null },
    failure: null,
    outcome_checks: [{ id: 'o', status: 'passed' }],
    steps: [
      { id: 'a', title: 'A', status: 'passed', duration_ms: 1000 },
      { id: 'b', title: 'B', status: 'passed', duration_ms: 1000 },
    ],
    console_errors: [],
    network_failures: [],
    blocked_requests: [],
    artifacts: { run_dir: '/tmp', screenshots: [], trace_path: null },
    ...over,
  };
}

describe('compare', () => {
  it('reports no_change for equal runs', () => {
    const r = compareRuns(record({}), record({ run_id: 'run_bbbbbbbbbbbbbbbb' }), 50);
    expect(r.verdict).toBe('no_change');
    expect(r.regressions).toEqual([]);
  });

  it('reports a failed outcome check as a regression', () => {
    const cand = record({
      run_id: 'run_bbbbbbbbbbbbbbbb',
      verdict: 'failed',
      outcome_checks: [{ id: 'o', status: 'failed', message: 'forbidden response' }],
    });
    const r = compareRuns(record({}), cand, 50);
    expect(r.verdict).toBe('regression');
    expect(r.regressions[0]).toMatchObject({ kind: 'outcome_failed', step_id: 'o' });
  });

  it('reports slow steps and new network failures', () => {
    const cand = record({
      run_id: 'run_bbbbbbbbbbbbbbbb',
      steps: [
        { id: 'a', title: 'A', status: 'passed', duration_ms: 5000 },
        { id: 'b', title: 'B', status: 'passed', duration_ms: 1000 },
      ],
      network_failures: [
        {
          method: 'GET',
          url: 'https://x.test/api/1',
          status: 500,
          resource_type: 'fetch',
          step_id: 'a',
          relevant: true,
        },
      ],
    });
    const r = compareRuns(record({}), cand, 50);
    expect(r.regressions.map((x) => x.kind).sort()).toEqual(['new_network_failure', 'slower']);
  });

  it('is inconclusive when a run did not test the site', () => {
    const r = compareRuns(record({}), record({ run_id: 'run_bbbbbbbbbbbbbbbb', verdict: 'error' }), 50);
    expect(r.verdict).toBe('inconclusive');
  });

  it('refuses runs of different scenarios and unfinished runs', () => {
    expect(() => compareRuns(record({}), record({ scenario_id: 'other' }), 50)).toThrow(
      /different scenarios/,
    );
    expect(() => compareRuns(record({}), record({ status: 'running', verdict: null }), 50)).toThrow(
      /still running/,
    );
  });
});
