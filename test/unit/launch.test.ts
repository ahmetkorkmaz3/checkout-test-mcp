import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, LaunchOptions } from 'playwright';
import { describe, expect, it } from 'vitest';
import { classify } from '../../src/runner/classify.js';
import { launchBrowser } from '../../src/runner/launch.js';
import { RunStore } from '../../src/runs/store.js';
import { RunRecord } from '../../src/schemas/run.js';

const MISSING_CHROMIUM = "browserType.launch: Executable doesn't exist at /x/chromium";
const MISSING_CHROME = "browserType.launch: Chromium distribution 'chrome' is not found at /x/chrome";
const OPTIONS: LaunchOptions = {
  headless: true,
  proxy: { server: 'http://127.0.0.1:1', bypass: '<-loopback>' },
  args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
};

/** Each entry is a launch result: a version string, or an error message. */
function fakeLauncher(results: string[]) {
  const calls: LaunchOptions[] = [];
  return {
    calls,
    launch: async (o?: LaunchOptions) => {
      calls.push(o ?? {});
      const r = results[calls.length - 1] as string;
      if (r.startsWith('v:')) return { version: () => r.slice(2) } as unknown as Browser;
      throw new Error(r);
    },
  };
}

describe('launchBrowser', () => {
  it('auto starts Chromium first', async () => {
    const l = fakeLauncher(['v:140.0.1']);
    const r = await launchBrowser('auto', OPTIONS, l as never);
    expect(r.info).toEqual({ name: 'chromium', version: '140.0.1' });
    expect(l.calls).toHaveLength(1);
    expect(l.calls[0]?.channel).toBeUndefined();
  });

  it('auto falls back to Chrome when Chromium is missing, with the guard options', async () => {
    const l = fakeLauncher([MISSING_CHROMIUM, 'v:141.0.2']);
    const r = await launchBrowser('auto', OPTIONS, l as never);
    expect(r.info).toEqual({ name: 'chrome', version: '141.0.2' });
    expect(l.calls[1]).toEqual({ ...OPTIONS, channel: 'chrome' });
    expect(l.calls[0]).toEqual(OPTIONS);
  });

  it('auto does not fall back on another error', async () => {
    const l = fakeLauncher(['Target closed', 'v:1']);
    await expect(launchBrowser('auto', OPTIONS, l as never)).rejects.toThrow('Target closed');
    expect(l.calls).toHaveLength(1);
  });

  it('auto does not hide another Chrome error', async () => {
    const l = fakeLauncher([MISSING_CHROMIUM, 'Target closed']);
    await expect(launchBrowser('auto', OPTIONS, l as never)).rejects.toThrow('Target closed');
  });

  it('auto reports both fixes when nothing is installed', async () => {
    const l = fakeLauncher([MISSING_CHROMIUM, MISSING_CHROME]);
    const err = await launchBrowser('auto', OPTIONS, l as never).catch((e: Error) => e);
    expect((err as Error).message.startsWith('No browser found.')).toBe(true);
    expect((err as Error).message).toContain('npx playwright install chromium');
    expect((err as Error).message).toContain('Install Google Chrome');
    expect((err as Error).message).not.toContain('\n');
  });

  it('chromium never falls back', async () => {
    const l = fakeLauncher([MISSING_CHROMIUM, 'v:1']);
    await expect(launchBrowser('chromium', OPTIONS, l as never)).rejects.toThrow('No browser found.');
    expect(l.calls).toHaveLength(1);
  });

  it('chrome starts only Chrome and never falls back', async () => {
    const ok = fakeLauncher(['v:141.0.2']);
    expect((await launchBrowser('chrome', OPTIONS, ok as never)).info.name).toBe('chrome');
    expect(ok.calls[0]?.channel).toBe('chrome');
    const missing = fakeLauncher([MISSING_CHROME, 'v:1']);
    await expect(launchBrowser('chrome', OPTIONS, missing as never)).rejects.toThrow('No browser found.');
    expect(missing.calls).toHaveLength(1);
  });
});

describe('run record', () => {
  it('parses a v0.1 record without browser', () => {
    const v01 = {
      run_id: 'run_aaaaaaaaaaaaaaaa',
      idempotency_key: 'k-00000001',
      request_hash: 'h',
      scenario_id: 's',
      scenario_hash: 'x',
      target: 't',
      params: {},
      options: {},
      status: 'finished',
      verdict: 'passed',
      summary: '',
      created_at: '2026-11-22T00:00:00.000Z',
      started_at: null,
      finished_at: null,
      duration_ms: null,
      progress: { completed_steps: 0, total_steps: 0, current_step_id: null },
      failure: null,
      outcome_checks: [],
      steps: [],
      console_errors: [],
      network_failures: [],
      blocked_requests: [],
      artifacts: { run_dir: '/tmp', screenshots: [], trace_path: null },
    };
    const r = RunRecord.parse(v01);
    expect(r.browser).toBeNull();
  });
});

describe('RunStore with a v0.1 record', () => {
  it('loads a record without a browser field and sets browser to null', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ctm-v01-'));
    try {
      const runId = 'run_0123456789abcdef';
      const record = {
        run_id: runId,
        idempotency_key: 'v01-key-0001',
        request_hash: 'h',
        scenario_id: 's',
        scenario_hash: 'h',
        target: 't',
        params: {},
        options: {},
        status: 'finished',
        verdict: 'passed',
        summary: 'ok',
        created_at: '2026-11-22T10:00:00.000Z',
        started_at: null,
        finished_at: null,
        duration_ms: null,
        progress: { completed_steps: 0, total_steps: 0, current_step_id: null },
        failure: null,
        outcome_checks: [],
        steps: [],
        console_errors: [],
        network_failures: [],
        blocked_requests: [],
        artifacts: { run_dir: '/tmp', screenshots: [], trace_path: null },
      };
      await mkdir(path.join(dir, runId), { recursive: true });
      await writeFile(path.join(dir, runId, 'result.json'), JSON.stringify(record));
      const store = new RunStore(dir);
      await store.init();
      const loaded = store.get(runId);
      expect(loaded).toBeDefined();
      expect(loaded?.browser).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('classify browser_error', () => {
  const base = {
    category: 'browser_error' as const,
    scenarioId: 's',
    target: 't',
    stepId: 'setup',
    urlBefore: undefined,
    urlAfter: undefined,
    serverErrorsInStep: [],
    blockedInStep: [],
    hint: undefined,
    timeoutMultiplier: 1,
    isOutcomeCheck: false,
  };

  it('tells a human to install Chrome or run init', () => {
    const c = classify({ ...base, message: 'No browser found. Nothing is installed.' });
    const text = c.next_actions.map((a) => a.description).join(' ');
    expect(c.next_actions[0]?.kind).toBe('ask_human');
    expect(text).toContain('install Google Chrome');
    expect(text).toContain('npx checkout-test-mcp init');
  });

  it('keeps the hint for a missing executable', () => {
    const c = classify({ ...base, message: "Executable doesn't exist at /x" });
    expect(c.next_actions[0]?.description).toContain('npx playwright install chromium');
  });
});

describe('classify browser_error by mode', () => {
  const base = {
    category: 'browser_error' as const,
    scenarioId: 's',
    target: 't',
    stepId: 'setup',
    urlBefore: undefined,
    urlAfter: undefined,
    serverErrorsInStep: [],
    blockedInStep: [],
    hint: undefined,
    timeoutMultiplier: 1,
    isOutcomeCheck: false,
  };
  const text = async (mode: 'auto' | 'chromium' | 'chrome') => {
    const l = fakeLauncher([MISSING_CHROMIUM, MISSING_CHROME]);
    const err = (await launchBrowser(mode, OPTIONS, l as never).catch((e: Error) => e)) as Error;
    return classify({ ...base, message: err.message })
      .next_actions.map((a) => a.description)
      .join(' ');
  };

  it('chromium mode names only the init command', async () => {
    const t = await text('chromium');
    expect(t).toContain('npx checkout-test-mcp init');
    expect(t).not.toContain('Google Chrome');
  });

  it('chrome mode names only Google Chrome', async () => {
    const t = await text('chrome');
    expect(t).toContain('install Google Chrome');
    expect(t).not.toContain('npx checkout-test-mcp init');
  });

  it('auto mode names both', async () => {
    const t = await text('auto');
    expect(t).toContain('install Google Chrome');
    expect(t).toContain('npx checkout-test-mcp init');
  });
});
