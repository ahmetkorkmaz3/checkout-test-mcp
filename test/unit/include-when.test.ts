import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conditionsPass } from '../../src/scenarios/expand.js';
import { parseScenario, ScenarioRegistry } from '../../src/scenarios/registry.js';

let dir: string;

function write(rel: string, text: string): string {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

const head = (steps: string, extra = '') => `
schema_version: 1
id: s
title: T
summary: S
compatible_profiles: [p]
expected_outcome: custom
params:
  customer_type: { type: enum, values: [guest, member], default: guest, description: c }
${extra}
steps:
${steps}
`;

const fragment = (id: string, steps: string, args = '') => `
schema_version: 1
kind: fragment
id: ${id}
description: d
${args}
steps:
${steps}
`;

function load(stepsYaml: string, extra = ''): ReturnType<typeof parseScenario> {
  const file = write('main.yaml', head(stepsYaml, extra));
  return parseScenario(head(stepsYaml, extra), file, [dir]);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ctm-inc-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('include', () => {
  it('expands a fragment with args and prefixed step ids', () => {
    write(
      'frag/login.yaml',
      fragment(
        'login',
        `  - id: open
    title: Open login
    goto: "{{args.path}}"
  - id: user
    title: Fill user
    fill: { label: Email }
    value: "{{args.email}}"`,
        `args:
  path: { description: p, default: /giris }
  email: { description: e }`,
      ),
    );
    const { scenario } = load(`  - id: login
    title: Log in
    include: frag/login.yaml
    with: { email: "{{data.user.email}}" }
  - id: done
    title: Done
    goto: /`);
    expect(scenario.steps.map((s) => s.id)).toEqual(['login__open', 'login__user', 'done']);
    expect(scenario.steps[0]?.goto).toBe('/giris');
    expect(scenario.steps[1]?.value).toBe('{{data.user.email}}');
  });

  it('supports nested includes and merges when conditions', () => {
    write('frag/inner.yaml', fragment('inner', `  - id: a\n    title: A\n    goto: /a`));
    write(
      'frag/outer.yaml',
      fragment(
        'outer',
        `  - id: nested
    title: N
    include: inner.yaml
    when: { param: customer_type, equals: member }`,
      ),
    );
    const { scenario } = load(`  - id: o
    title: O
    include: frag/outer.yaml
    when: { param: customer_type, in: [guest, member] }`);
    expect(scenario.steps.map((s) => s.id)).toEqual(['o__nested__a']);
    expect(scenario.steps[0]?.when).toHaveLength(2);
  });

  it('refuses a missing arg, an unknown arg, and args outside a fragment', () => {
    write(
      'f.yaml',
      fragment('f', `  - id: a\n    title: A\n    goto: "{{args.x}}"`, 'args:\n  x: { description: x }'),
    );
    expect(() => load(`  - id: i\n    title: I\n    include: f.yaml`)).toThrow(/needs arg "x"/);
    expect(() => load(`  - id: i\n    title: I\n    include: f.yaml\n    with: { x: 1, y: 2 }`)).toThrow(
      /no arg "y"/,
    );
    expect(() => load(`  - id: a\n    title: A\n    goto: "{{args.x}}"`)).toThrow(/only inside a fragment/);
  });

  it('refuses a cycle, a path outside the roots, and a missing file', () => {
    write('a.yaml', fragment('a', `  - id: x\n    title: X\n    include: b.yaml`));
    write('b.yaml', fragment('b', `  - id: y\n    title: Y\n    include: a.yaml`));
    expect(() => load(`  - id: i\n    title: I\n    include: a.yaml`)).toThrow(/cycle/);
    expect(() => load(`  - id: i\n    title: I\n    include: ../outside.yaml`)).toThrow(
      /outside the scenario folders/,
    );
    expect(() => load(`  - id: i\n    title: I\n    include: nope.yaml`)).toThrow(/does not exist/);
  });

  it('refuses a card number inside a fragment', () => {
    write(
      'f.yaml',
      fragment('f', `  - id: a\n    title: A\n    fill: { label: X }\n    value: "4242424242424242"`),
    );
    expect(() => load(`  - id: i\n    title: I\n    include: f.yaml`)).toThrow(/card number/);
  });

  it('refuses action keys on an include step', () => {
    write('f.yaml', fragment('f', `  - id: a\n    title: A\n    goto: /`));
    expect(() => load(`  - id: i\n    title: I\n    include: f.yaml\n    goto: /x`)).toThrow(
      /allows only id, title, include/,
    );
  });

  it('refuses duplicate ids after expansion and conditions on unknown params', () => {
    write('f.yaml', fragment('f', `  - id: a\n    title: A\n    goto: /`));
    expect(() =>
      load(`  - id: i\n    title: I\n    include: f.yaml\n  - id: i__a\n    title: Dup\n    goto: /`),
    ).toThrow(/Duplicate step/);
    expect(() => load(`  - id: a\n    title: A\n    goto: /\n    when: { param: nope, equals: 1 }`)).toThrow(
      /unknown param "nope"/,
    );
  });

  it('skips fragment files when it loads a scenario folder', async () => {
    write('frag/f.yaml', fragment('f', `  - id: a\n    title: A\n    goto: /`));
    write('main.yaml', head(`  - id: i\n    title: I\n    include: frag/f.yaml`));
    const reg = await ScenarioRegistry.load([dir]);
    expect(reg.ids()).toEqual(['s']);
  });

  it('changes the scenario hash when a fragment changes', () => {
    write('f.yaml', fragment('f', `  - id: a\n    title: A\n    goto: /one`));
    const one = load(`  - id: i\n    title: I\n    include: f.yaml`).hash;
    write('f.yaml', fragment('f', `  - id: a\n    title: A\n    goto: /two`));
    const two = load(`  - id: i\n    title: I\n    include: f.yaml`).hash;
    expect(one).not.toBe(two);
  });
});

describe('when', () => {
  it('evaluates equals, not_equals, in, and lists', () => {
    const v = { customer_type: 'member', quantity: 2 };
    expect(conditionsPass(undefined, v)).toBe(true);
    expect(conditionsPass({ param: 'customer_type', equals: 'member' }, v)).toBe(true);
    expect(conditionsPass({ param: 'quantity', not_equals: 1 }, v)).toBe(true);
    expect(conditionsPass({ param: 'quantity', equals: '2' }, v)).toBe(true);
    expect(conditionsPass({ param: 'customer_type', in: ['guest'] }, v)).toBe(false);
    expect(
      conditionsPass(
        [
          { param: 'customer_type', equals: 'member' },
          { param: 'quantity', equals: 1 },
        ],
        v,
      ),
    ).toBe(false);
  });

  it('refuses a condition with two operators', () => {
    expect(() =>
      load(
        `  - id: a\n    title: A\n    goto: /\n    when: { param: customer_type, equals: guest, in: [guest] }`,
      ),
    ).toThrow(/exactly one of: equals, not_equals, in/);
  });
});
