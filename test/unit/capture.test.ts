import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseScenario } from '../../src/scenarios/registry.js';
import { readJsonPath, renderCaptured, TemplateError } from '../../src/scenarios/template.js';

let dir: string;

const scenario = (steps: string, outcome = '') => `
schema_version: 1
id: s
title: T
summary: S
compatible_profiles: [p]
expected_outcome: custom
steps:
${steps}
${outcome}
`;

const SEND = `  - id: send
    title: Send code
    click: { role: button, name: Send }
    capture:
      - name: otp
        from_response: { url: "**/send-code" }
        json_path: data.code`;

const FILL = `  - id: fill
    title: Fill code
    fill: { label: Code }
    value: "{{captured.otp}}"`;

function load(text: string) {
  const file = path.join(dir, 'main.yaml');
  writeFileSync(file, text);
  return parseScenario(text, file, [dir]);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ctm-cap-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('capture at load time', () => {
  it('accepts a capture that an earlier step defines', () => {
    const { scenario: s } = load(
      scenario(`${SEND}\n${FILL}`, 'outcome:\n  - id: o\n    visible: { text: "{{captured.otp}}" }'),
    );
    expect(s.steps[0]?.capture?.[0]?.name).toBe('otp');
    expect(s.steps[1]?.value).toBe('{{captured.otp}}');
  });

  it('refuses a token before the capture step', () => {
    expect(() => load(scenario(`${FILL}\n${SEND}`))).toThrow(/not captured by an earlier step/);
  });

  it('refuses a token in the same step as the capture', () => {
    const same = `${SEND}\n    then:\n      - fill: { label: Code }\n        value: "{{captured.otp}}"`;
    expect(() => load(scenario(same))).toThrow(/not captured by an earlier step/);
  });

  it('refuses a name that two steps capture', () => {
    expect(() => load(scenario(`${SEND}\n${SEND.replace('id: send', 'id: send_again')}`))).toThrow(
      /defined twice/,
    );
  });

  it('refuses an outcome token that no step captures', () => {
    expect(() =>
      load(
        scenario(
          `  - id: a\n    title: A\n    goto: /`,
          'outcome:\n  - id: o\n    visible: { text: "{{captured.x}}" }',
        ),
      ),
    ).toThrow(/not captured by any step/);
  });

  it('refuses capture on an include step and a bad json_path', () => {
    writeFileSync(
      path.join(dir, 'f.yaml'),
      'schema_version: 1\nkind: fragment\nid: f\ndescription: d\nsteps:\n  - id: a\n    title: A\n    goto: /\n',
    );
    expect(() =>
      load(
        scenario(
          `  - id: i\n    title: I\n    include: f.yaml\n    capture:\n      - name: otp\n        from_response: { url: "**" }\n        json_path: a`,
        ),
      ),
    ).toThrow(/Remove: capture/);
    expect(() => load(scenario(SEND.replace('data.code', 'data[0].code')))).toThrow();
  });
});

describe('capture helpers', () => {
  it('reads dot paths with array indexes', () => {
    const json = { data: { otp_code: '12345', items: [{ code: 7 }] } };
    expect(readJsonPath(json, 'data.otp_code')).toBe('12345');
    expect(readJsonPath(json, 'data.items.0.code')).toBe(7);
    expect(readJsonPath(json, 'data.missing')).toBeUndefined();
    expect(readJsonPath(null, 'a')).toBeUndefined();
  });

  it('fills only captured tokens and refuses a missing value', () => {
    const step = { value: '{{captured.otp}}', note: 'keeps {{other}} text' };
    expect(renderCaptured(step, new Map([['otp', '54321']]))).toEqual({
      value: '54321',
      note: 'keeps {{other}} text',
    });
    expect(() => renderCaptured(step, new Map())).toThrow(TemplateError);
  });
});
