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

  describe('production targets', () => {
    const prod = (over: Record<string, unknown> = {}) => ({
      profile: 'p',
      environment: 'production',
      base_url: 'https://www.shop.example',
      allowed_hosts: ['www.shop.example'],
      ...over,
    });

    it('accepts a production target with hosts in production_hosts', () => {
      const cfg = parseConfig({ production_hosts: ['www.shop.example'], targets: { live: prod() } }, '/tmp');
      expect(cfg.targets.live?.environment).toBe('production');
      expect(cfg.targets.live?.live_cards).toEqual({});
    });

    it('accepts a production target with an unlabeled host and empty production_hosts', () => {
      expect(() => parseConfig({ targets: { live: prod() } }, '/tmp')).not.toThrow();
    });

    it('refuses a test target with a host in production_hosts', () => {
      const raw = {
        production_hosts: ['www.shop.example'],
        targets: { t: prod({ environment: 'test' }) },
      };
      expect(() => parseConfig(raw, '/tmp')).toThrow(/is in production_hosts/);
    });

    describe('test target hosts that belong to a production target', () => {
      const live = prod({
        allowed_hosts: ['www.shop.example', 'api.shop.example'],
        third_party_hosts: ['js.pay.test'],
      });
      const test = (over: Record<string, unknown> = {}) => ({
        profile: 'p',
        base_url: 'http://shop.test',
        allowed_hosts: ['shop.test'],
        allow_unlabeled_host: true,
        ...over,
      });
      const config = (t: Record<string, unknown>) => ({
        production_hosts: ['example.org'],
        targets: { live, t },
      });

      it('refuses a production host in allowed_hosts of a test target', () => {
        const raw = config(test({ allowed_hosts: ['shop.test', 'api.shop.example'] }));
        expect(() => parseConfig(raw, '/tmp')).toThrow(
          'Target "t": host "api.shop.example" belongs to production target "live".',
        );
      });

      it('refuses a production host in third_party_hosts of a test target', () => {
        const raw = config(test({ third_party_hosts: ['www.shop.example'] }));
        expect(() => parseConfig(raw, '/tmp')).toThrow(
          'Target "t": host "www.shop.example" belongs to production target "live".',
        );
      });

      it('refuses a wildcard overlap in both directions', () => {
        const wide = config(test({ third_party_hosts: ['*.shop.example'] }));
        expect(() => parseConfig(wide, '/tmp')).toThrow(
          'Target "t": host "*.shop.example" belongs to production target "live".',
        );
        const prodWide = {
          production_hosts: ['example.org'],
          targets: {
            live: prod({ allowed_hosts: ['www.shop.example', '*.cdn.shop.example'] }),
            t: test({ third_party_hosts: ['img.cdn.shop.example'] }),
          },
        };
        expect(() => parseConfig(prodWide, '/tmp')).toThrow(
          'Target "t": host "img.cdn.shop.example" belongs to production target "live".',
        );
      });

      it('accepts a third-party host that the production target shares', () => {
        const raw = config(test({ third_party_hosts: ['js.pay.test'] }));
        expect(() => parseConfig(raw, '/tmp')).not.toThrow();
      });
    });

    it('refuses live_cards on a test target', () => {
      const card = {
        number_env: 'LIVE_NUMBER',
        expiry_env: 'LIVE_EXPIRY',
        cvc_env: 'LIVE_CVC',
        behaviour: 'success',
        description: 'My own card.',
      };
      const raw = { targets: { local: { ...base.targets.local, live_cards: { mine: card } } } };
      expect(() => parseConfig(raw, '/tmp')).toThrow(
        /Target "local": live_cards needs environment: production/,
      );
    });
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

    it('refuses authoring.dir in a sibling folder that shares a scenario dir prefix', () => {
      expect(() =>
        parseConfig({ ...base, scenario_dirs: ['./scenarios'], authoring: { dir: './scenarios-x' } }, dir),
      ).toThrow(/authoring.dir must be inside one of scenario_dirs/);
    });

    it.each([
      ['start_paths', '//other.test/x'],
      ['start_paths', '/\\other.test/x'],
      ['product_paths', '//other.test/x'],
      ['product_paths', '/\\other.test/x'],
      ['product_paths', 'products/x'],
    ])('refuses inspect.%s entry %j, which can leave the target host', (key, value) => {
      expect(() =>
        parseConfig({ ...base, targets: { t: { ...target, inspect: { [key]: [value] } } } }, dir),
      ).toThrow(ConfigError);
    });

    it('accepts inspect paths with a query', () => {
      const c = parseConfig(
        { ...base, targets: { t: { ...target, inspect: { start_paths: ['/', '/search?q=mug'] } } } },
        dir,
      );
      expect(c.targets.t?.inspect?.start_paths).toEqual(['/', '/search?q=mug']);
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
