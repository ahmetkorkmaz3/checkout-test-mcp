import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/load-config.js';
import type { ToolError } from '../../src/errors/tool-error.js';
import { silentLogger } from '../../src/logger.js';
import type { ExecuteInput, ExecuteOutput } from '../../src/runner/executor.js';
import { RunManager } from '../../src/runs/manager.js';
import { RunStore } from '../../src/runs/store.js';
import { ScenarioRegistry } from '../../src/scenarios/registry.js';

let dir: string;
let executions: ExecuteInput[];

const SCENARIO = `
schema_version: 1
id: login-matrix
title: Guest or member checkout
summary: One scenario for both customer types.
compatible_profiles: [demo-store]
expected_outcome: custom
params:
  customer_type: { type: enum, values: [guest, member], default: guest, description: Customer type. }
steps:
  - id: open
    title: Open
    goto: /
  - id: login
    title: Log in as member
    when: { param: customer_type, equals: member }
    include: fragments/login.yaml
  - id: guest
    title: Continue as guest
    when: { param: customer_type, equals: guest }
    click: { role: button, name: Continue as guest }
outcome:
  - id: member_badge
    when: { param: customer_type, equals: member }
    visible: { test_id: member-badge }
`;

const LOGIN = `
schema_version: 1
kind: fragment
id: login
description: Member login.
steps:
  - id: password
    title: Fill password
    fill: { label: Password }
    value: "{{secrets.member_password}}"
`;

function execute(input: ExecuteInput): Promise<ExecuteOutput> {
  executions.push(input);
  return Promise.resolve({
    verdict: 'passed',
    failure: null,
    steps: input.steps.map((s) => ({ id: s.id, title: s.title, status: 'passed' })),
    outcome_checks: input.outcome.map((o) => ({ id: o.id, status: 'passed' })),
    console_errors: [],
    network_failures: [],
    blocked_requests: [],
    screenshots: [],
    trace_path: null,
  });
}

async function manager(env: NodeJS.ProcessEnv): Promise<RunManager> {
  const config = parseConfig(
    {
      runs_dir: path.join(dir, 'runs'),
      scenario_dirs: [path.join(dir, 'scenarios')],
      test_data_dir: path.join(dir, 'data'),
      targets: {
        local: {
          profile: 'demo-store',
          base_url: 'http://localhost:4173',
          allowed_hosts: ['localhost'],
          secrets: { member_password: 'TEST_MEMBER_PASSWORD' },
        },
      },
    },
    dir,
  );
  const registry = await ScenarioRegistry.load(config.scenario_dirs);
  const store = new RunStore(config.runs_dir);
  await store.init();
  const m = new RunManager({ config, registry, store, logger: silentLogger, execute, env });
  managers.push(m);
  return m;
}

// Every manager that a test makes. afterEach waits until all of them are idle.
const managers: RunManager[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ctm-when-'));
  executions = [];
  mkdirSync(path.join(dir, 'scenarios/fragments'), { recursive: true });
  mkdirSync(path.join(dir, 'data'));
  writeFileSync(path.join(dir, 'scenarios/login-matrix.yaml'), SCENARIO);
  writeFileSync(path.join(dir, 'scenarios/fragments/login.yaml'), LOGIN);
});

afterEach(async () => {
  // The fake runner finishes at once. Wait for the background writes before the folder goes.
  await Promise.all(managers.splice(0).map((m) => m.idle()));
  rmSync(dir, { recursive: true, force: true });
});

const CAPTURE_SCENARIO = `
schema_version: 1
id: member-otp
title: Member OTP
summary: Reads the SMS code only for members.
compatible_profiles: [demo-store]
expected_outcome: custom
params:
  customer_type: { type: enum, values: [guest, member], default: guest, description: Customer type. }
steps:
  - id: send
    title: Send code
    when: { param: customer_type, equals: member }
    click: { role: button, name: Send }
    capture:
      - name: otp
        from_response: { url: "**/send-code" }
        json_path: data.code
  - id: fill
    title: Fill code
    fill: { label: Code }
    value: "{{captured.otp}}"
`;

describe('capture in a run', () => {
  it('refuses a run that uses a capture from a skipped step', async () => {
    writeFileSync(path.join(dir, 'scenarios/member-otp.yaml'), CAPTURE_SCENARIO);
    const m = await manager({});
    await expect(
      m.start({ target: 'local', scenario_id: 'member-otp', params: {}, idempotency_key: 'cap-guest-01' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' } satisfies Partial<ToolError>);
    expect(executions).toHaveLength(0);
  });

  it('passes the captured token to the runner unchanged', async () => {
    writeFileSync(path.join(dir, 'scenarios/member-otp.yaml'), CAPTURE_SCENARIO);
    const m = await manager({});
    await m.start({
      target: 'local',
      scenario_id: 'member-otp',
      params: { customer_type: 'member' },
      idempotency_key: 'cap-member-01',
    });
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    expect(executions[0]?.steps[1]?.value).toBe('{{captured.otp}}');
    await m.idle();
  });
});

describe('when filter in a run', () => {
  it('runs only guest steps for a guest and needs no member secret', async () => {
    const m = await manager({});
    const { record } = await m.start({
      target: 'local',
      scenario_id: 'login-matrix',
      params: {},
      idempotency_key: 'when-guest-01',
    });
    expect(record.steps.map((s) => s.id)).toEqual(['open', 'guest']);
    expect(record.outcome_checks).toEqual([]);
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    expect(executions[0]?.steps.map((s) => s.id)).toEqual(['open', 'guest']);
    await m.idle();
  });

  it('runs member steps with the fragment and asks for the member secret', async () => {
    const without = await manager({});
    await expect(
      without.start({
        target: 'local',
        scenario_id: 'login-matrix',
        params: { customer_type: 'member' },
        idempotency_key: 'when-member-01',
      }),
    ).rejects.toMatchObject({ code: 'MISSING_ENV_SECRET' } satisfies Partial<ToolError>);

    const m = await manager({ TEST_MEMBER_PASSWORD: 'test-only-password' });
    const { record } = await m.start({
      target: 'local',
      scenario_id: 'login-matrix',
      params: { customer_type: 'member' },
      idempotency_key: 'when-member-02',
    });
    expect(record.steps.map((s) => s.id)).toEqual(['open', 'login__password']);
    expect(record.outcome_checks.map((o) => o.id)).toEqual(['member_badge']);
    expect(JSON.stringify(record)).not.toContain('test-only-password');
    await m.idle();
  });
});
