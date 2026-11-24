import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load-config.js';
import type { ToolError } from '../../src/errors/tool-error.js';
import { type Logger, silentLogger } from '../../src/logger.js';
import type { ExecuteInput, ExecuteOutput } from '../../src/runner/executor.js';
import { RunManager } from '../../src/runs/manager.js';
import { RunStore } from '../../src/runs/store.js';
import { ScenarioRegistry } from '../../src/scenarios/registry.js';

let dir: string;
let executions: ExecuteInput[];
const managers: RunManager[] = [];

const SCENARIO = `
schema_version: 1
id: pay
title: Pay
summary: Pays with a card.
compatible_profiles: [shop]
expected_outcome: custom
params:
  card: { type: test_card, default: stripe/visa-success, description: Card., constraints: { behaviour: success } }
steps:
  - id: open
    title: Open
    goto: /
  - id: number
    title: Fill the card number
    fill: { label: Card number }
    value: "{{card.number}}"
`;

// The registered Stripe test number stands in for a live number. No new card literal enters the repo.
const LIVE_ENV = {
  LIVE_VISA_NUMBER: '4242424242424242',
  LIVE_VISA_EXPIRY: '12 / 34',
  LIVE_VISA_CVC: '123',
};

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

async function manager(
  env: NodeJS.ProcessEnv,
  opts: { execute?: typeof execute; logger?: Logger } = {},
): Promise<RunManager> {
  const config = parseConfig(
    {
      runs_dir: path.join(dir, 'runs'),
      scenario_dirs: [path.join(dir, 'scenarios')],
      test_data_dir: path.join(dir, 'data'),
      production_hosts: ['www.shop.example'],
      targets: {
        live: {
          profile: 'shop',
          environment: 'production',
          base_url: 'https://www.shop.example',
          allowed_hosts: ['www.shop.example'],
          live_cards: {
            'company-visa': {
              number_env: 'LIVE_VISA_NUMBER',
              expiry_env: 'LIVE_VISA_EXPIRY',
              cvc_env: 'LIVE_VISA_CVC',
              behaviour: 'success',
            },
            unused: {
              number_env: 'UNUSED_NUMBER',
              expiry_env: 'UNUSED_EXPIRY',
              cvc_env: 'UNUSED_CVC',
              behaviour: 'success',
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
  const m = new RunManager({
    config,
    registry,
    store,
    logger: opts.logger ?? silentLogger,
    execute: opts.execute ?? execute,
    env,
  });
  managers.push(m);
  return m;
}

function errorText(err: unknown): string {
  const e = err as ToolError;
  return JSON.stringify({ m: e.message, c: e.likelyCause, n: e.nextActions, d: e.details });
}

async function startError(m: RunManager, params: Record<string, string>, key: string): Promise<ToolError> {
  try {
    await m.start({
      target: 'live',
      confirm_production: true,
      scenario_id: 'pay',
      params,
      idempotency_key: key,
    });
  } catch (err) {
    return err as ToolError;
  }
  throw new Error('start did not fail');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ctm-live-'));
  executions = [];
  mkdirSync(path.join(dir, 'scenarios'), { recursive: true });
  mkdirSync(path.join(dir, 'data'));
  writeFileSync(path.join(dir, 'scenarios/pay.yaml'), SCENARIO);
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.idle()));
  rmSync(dir, { recursive: true, force: true });
});

describe('live cards in a run', () => {
  it('prepares a run with a live card and redacts its number and expiry', async () => {
    const m = await manager({ ...LIVE_ENV });
    const { record } = await m.start({
      target: 'live',
      confirm_production: true,
      scenario_id: 'pay',
      params: { card: 'live/company-visa' },
      idempotency_key: 'live-ok-01',
    });
    expect(record.params.card).toBe('live/company-visa');
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    const input = executions[0] as ExecuteInput;
    expect(input.steps[1]?.value).toBe(LIVE_ENV.LIVE_VISA_NUMBER);
    expect([...input.allowedCardNumbers]).toEqual([LIVE_ENV.LIVE_VISA_NUMBER]);
    const redacted = input.redactor.redact(`n=${LIVE_ENV.LIVE_VISA_NUMBER} e=${LIVE_ENV.LIVE_VISA_EXPIRY}`);
    expect(redacted).not.toContain(LIVE_ENV.LIVE_VISA_NUMBER);
    expect(redacted).not.toContain(LIVE_ENV.LIVE_VISA_EXPIRY);
    await m.idle();
  });

  it('passes no allowed numbers for a run with a test card', async () => {
    const m = await manager({});
    await m.start({
      target: 'live',
      confirm_production: true,
      scenario_id: 'pay',
      params: {},
      idempotency_key: 'live-test-card-01',
    });
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    expect(executions[0]?.allowedCardNumbers.size).toBe(0);
    await m.idle();
  });

  it('refuses a missing live card env var and names only the env var', async () => {
    const m = await manager({ LIVE_VISA_NUMBER: LIVE_ENV.LIVE_VISA_NUMBER, LIVE_VISA_EXPIRY: '12 / 34' });
    const err = await startError(m, { card: 'live/company-visa' }, 'live-missing-01');
    expect(err).toMatchObject({ code: 'MISSING_ENV_SECRET' });
    expect(err.details?.missing).toEqual(['live/company-visa (env LIVE_VISA_CVC)']);
    expect(errorText(err)).not.toContain(LIVE_ENV.LIVE_VISA_NUMBER);
    expect(errorText(err)).not.toContain('12 / 34');
    expect(executions).toHaveLength(0);
  });

  it('refuses an env number that is not a valid card number and never shows the value', async () => {
    const m = await manager({ ...LIVE_ENV, LIVE_VISA_NUMBER: '1234' });
    const err = await startError(m, { card: 'live/company-visa' }, 'live-bad-number-01');
    expect(err).toMatchObject({ code: 'MISSING_ENV_SECRET' });
    expect(err.message).toMatch(/not a valid card number/);
    expect(errorText(err)).not.toContain('1234');
    expect(executions).toHaveLength(0);
  });

  it('does not read the env of a live card that the params do not name', async () => {
    const env = new Proxy({ ...LIVE_ENV } as NodeJS.ProcessEnv, {
      get(target, key) {
        if (typeof key === 'string' && key.startsWith('UNUSED_')) throw new Error(`read ${key}`);
        return target[key as string];
      },
    });
    const m = await manager(env);
    await m.start({
      target: 'live',
      confirm_production: true,
      scenario_id: 'pay',
      params: { card: 'live/company-visa' },
      idempotency_key: 'live-unused-01',
    });
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    await m.idle();
  });

  it('refuses an unknown live card name', async () => {
    const m = await manager({ ...LIVE_ENV });
    const err = await startError(m, { card: 'live/nope' }, 'live-unknown-01');
    expect(err).toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('refuses trace on a production target, also without a live card', async () => {
    const m = await manager({ ...LIVE_ENV });
    for (const [params, key] of [
      [{ card: 'live/company-visa' }, 'live-trace-01'],
      [{}, 'live-trace-02'],
    ] as const) {
      try {
        await m.start({
          target: 'live',
          confirm_production: true,
          scenario_id: 'pay',
          params,
          idempotency_key: key,
          options: { trace: true },
        });
        throw new Error('start did not fail');
      } catch (err) {
        expect(err).toMatchObject({ code: 'INVALID_PARAMS' });
        expect((err as ToolError).nextActions).toContainEqual(
          expect.objectContaining({ kind: 'change_argument', arguments: { options: { trace: false } } }),
        );
      }
    }
    expect(executions).toHaveLength(0);
  });

  it('redacts formatted forms of the live number and expiry', async () => {
    const m = await manager({ ...LIVE_ENV });
    await m.start({
      target: 'live',
      confirm_production: true,
      scenario_id: 'pay',
      params: { card: 'live/company-visa' },
      idempotency_key: 'live-format-01',
    });
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    const r = (executions[0] as ExecuteInput).redactor;
    expect(r.redact('4242 4242 4242 4242 | 4242-4242-4242-4242 | 12/34')).toBe(
      '[REDACTED] | [REDACTED] | [REDACTED]',
    );
    expect(r.redactFailureText('cvc 123')).toBe('cvc [REDACTED]');
    await m.idle();
  });

  it('redacts formatted forms of a test card of the run too', async () => {
    const m = await manager({});
    await m.start({
      target: 'live',
      confirm_production: true,
      scenario_id: 'pay',
      params: {},
      idempotency_key: 'live-format-02',
    });
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    const r = (executions[0] as ExecuteInput).redactor;
    expect(r.redact('4242-4242-4242-4242 12/2034')).toBe('[REDACTED] [REDACTED]');
    await m.idle();
  });

  it('redacts the error of a crashed run in the log', async () => {
    const logged: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      error: (msg, data) => logged.push(JSON.stringify({ msg, data })),
    };
    const crash = (): Promise<ExecuteOutput> =>
      Promise.reject(new Error(`boom ${LIVE_ENV.LIVE_VISA_NUMBER} and 4242 4242 4242 4242`));
    const m = await manager({ ...LIVE_ENV }, { execute: crash, logger });
    await m.start({
      target: 'live',
      confirm_production: true,
      scenario_id: 'pay',
      params: { card: 'live/company-visa' },
      idempotency_key: 'live-crash-01',
    });
    await m.idle();
    expect(logged.some((l) => l.includes('run crashed'))).toBe(true);
    expect(logged.join('\n')).not.toMatch(/4242/);
  });
});
