import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors/tool-error.js';
import { globToRegExp, statusMatches } from '../../src/runner/match.js';
import { resolveParams } from '../../src/scenarios/params.js';
import { parseScenario, ScenarioRegistry } from '../../src/scenarios/registry.js';
import { collectTokens, renderDeep, renderString, TemplateError } from '../../src/scenarios/template.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('shipped scenarios', () => {
  it('all load and validate', async () => {
    const reg = await ScenarioRegistry.load([path.join(ROOT, 'scenarios')]);
    expect(reg.ids().sort()).toEqual([
      'card-3ds-challenge-fail',
      'card-success',
      'phone-otp-capture',
      'phone-otp-capture-text',
      'saucedemo-guest-checkout',
    ]);
  });
});

const MINIMAL = `
schema_version: 1
id: s
title: T
summary: S
compatible_profiles: [p]
expected_outcome: custom
params:
  qty: { type: integer, default: 1, minimum: 1, maximum: 3, description: q }
  card: { type: test_card, default: stripe/visa-success, description: c, constraints: { behaviour: success } }
steps:
  - id: a
    title: A
    goto: /
`;

describe('scenario schema', () => {
  it('refuses a step with two actions', () => {
    const bad = MINIMAL.replace('goto: /', 'goto: /\n    click: { css: a }');
    expect(() => parseScenario(bad, 'x.yaml')).toThrow(/exactly one action/);
  });

  it('refuses a locator with two kinds', () => {
    const bad = MINIMAL.replace('goto: /', 'click: { css: a, role: button }');
    expect(() => parseScenario(bad, 'x.yaml')).toThrow(/exactly one of/);
  });

  it('refuses a card number in the YAML', () => {
    expect(() => parseScenario(`${MINIMAL}\n# 4242424242424242`, 'x.yaml')).toThrow(/card number/);
  });

  it('refuses a param without default or required', () => {
    const bad = MINIMAL.replace('default: 1, ', '');
    expect(() => parseScenario(bad, 'x.yaml')).toThrow(/needs a default/);
  });
});

describe('params', () => {
  const { scenario } = parseScenario(MINIMAL, 'x.yaml');

  it('applies defaults and resolves cards', () => {
    const r = resolveParams(scenario, {});
    expect(r.values).toEqual({ qty: 1, card: 'stripe/visa-success' });
    expect(r.cards.card?.number).toBe('4242424242424242');
  });

  it('coerces numeric strings and checks ranges', () => {
    expect(resolveParams(scenario, { qty: '2' }).values.qty).toBe(2);
    expect(() => resolveParams(scenario, { qty: 9 })).toThrow(ToolError);
  });

  it('refuses unknown params and wrong card behaviour', () => {
    expect(() => resolveParams(scenario, { nope: 1 })).toThrow(/has no param "nope"/);
    expect(() => resolveParams(scenario, { card: 'stripe/declined-generic' })).toThrow(/needs "success"/);
  });
});

describe('template', () => {
  it('renders tokens and refuses unknown ones', () => {
    expect(renderString('{{params.a}}-{{ data.c.d }}', { params: { a: 1 }, data: { c: { d: 'x' } } })).toBe(
      '1-x',
    );
    expect(() => renderString('{{params.nope}}', { params: {} })).toThrow(TemplateError);
  });

  it('renders deep values and collects tokens', () => {
    expect(renderDeep({ a: ['{{x.y}}'] }, { x: { y: 'z' } })).toEqual({ a: ['z'] });
    expect([...collectTokens({ a: '{{secrets.pw}} {{params.q}}' })].sort()).toEqual([
      'params.q',
      'secrets.pw',
    ]);
  });
});

describe('match helpers', () => {
  it('matches URL globs', () => {
    expect(globToRegExp('**/api/products/*').test('http://localhost:4173/api/products/ceramic-mug')).toBe(
      true,
    );
    expect(globToRegExp('**/api/products/*').test('http://localhost:4173/api/products/a/b')).toBe(false);
    expect(globToRegExp('**/checkout/**').test('http://x.test/checkout/payment')).toBe(true);
  });

  it('matches status classes', () => {
    expect(statusMatches(201, '2xx')).toBe(true);
    expect(statusMatches(402, '2xx')).toBe(false);
    expect(statusMatches(201, 201)).toBe(true);
  });
});

describe('registry trial load and swap', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'reg-'));
  const fragFile = path.join(tmp, 'frag', 'f.yaml');
  mkdirSync(path.dirname(fragFile));
  writeFileSync(
    fragFile,
    'schema_version: 1\nkind: fragment\nid: f\ndescription: d\nsteps:\n  - id: g\n    title: G\n    goto: /\n',
  );
  writeFileSync(
    path.join(tmp, 'inc.yaml'),
    MINIMAL.replace('id: s', 'id: inc').replace('goto: /', 'include: frag/f.yaml'),
  );

  it('trial load uses override text and a new file', async () => {
    const file = path.join(tmp, 'new.yaml');
    const reg = await ScenarioRegistry.load([tmp], {
      overrides: new Map([[file, MINIMAL.replace('id: s', 'id: added')]]),
    });
    expect(reg.ids()).toContain('added');
    expect(existsSync(file)).toBe(false);
  });

  it('trial load sees a broken fragment override in an including scenario', async () => {
    await expect(
      ScenarioRegistry.load([tmp], { overrides: new Map([[fragFile, 'kind: fragment\nsteps: 7']]) }),
    ).rejects.toThrow(/invalid fragment/);
  });

  it('trial load drops a file with a null override', async () => {
    const reg = await ScenarioRegistry.load([tmp], {
      overrides: new Map([[path.join(tmp, 'inc.yaml'), null]]),
    });
    expect(reg.ids()).not.toContain('inc');
  });

  const FRAG = (goto: string) =>
    `schema_version: 1\nkind: fragment\nid: f\ndescription: d\nsteps:\n  - id: g\n    title: G\n    goto: ${goto}\n`;
  const gotoOf = (reg: ScenarioRegistry, id: string) =>
    (reg.get(id)?.scenario.steps[0] as { goto?: string } | undefined)?.goto;

  it('a valid fragment override changes the including scenario and its hash', async () => {
    const plain = await ScenarioRegistry.load([tmp]);
    const reg = await ScenarioRegistry.load([tmp], { overrides: new Map([[fragFile, FRAG('/other')]]) });
    expect(gotoOf(plain, 'inc')).toBe('/');
    expect(gotoOf(reg, 'inc')).toBe('/other');
    expect(reg.get('inc')?.hash).not.toBe(plain.get('inc')?.hash);
  });

  it('an including scenario loads a fragment that exists only in overrides', async () => {
    const newFrag = path.join(tmp, 'frag', 'only.yaml');
    const user = path.join(tmp, 'user.yaml');
    const reg = await ScenarioRegistry.load([tmp], {
      overrides: new Map([
        [newFrag, FRAG('/new')],
        [user, MINIMAL.replace('id: s', 'id: user').replace('goto: /', 'include: frag/only.yaml')],
      ]),
    });
    expect(gotoOf(reg, 'user')).toBe('/new');
    expect(existsSync(newFrag)).toBe(false);
  });

  it('a null fragment override makes the include fail', async () => {
    await expect(ScenarioRegistry.load([tmp], { overrides: new Map([[fragFile, null]]) })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('matches overrides when the dir is relative', async () => {
    const rel = path.relative(process.cwd(), tmp);
    const reg = await ScenarioRegistry.load([rel], {
      overrides: new Map([[path.join(tmp, 'inc.yaml'), MINIMAL.replace('id: s', 'id: renamed')]]),
    });
    expect(reg.ids()).toContain('renamed');
    expect(reg.ids()).not.toContain('inc');
  });

  it('swap changes what an existing holder sees', async () => {
    const reg = await ScenarioRegistry.load([tmp]);
    reg.swap(ScenarioRegistry.fromLoaded([]));
    expect(reg.ids()).toEqual([]);
  });
});
