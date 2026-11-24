import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyFixes, checkHouseRules, checkTestData, type RuleIssue } from '../../src/authoring/rules.js';
import { parseScenario } from '../../src/scenarios/registry.js';
import { Fragment, Scenario } from '../../src/schemas/scenario.js';

const DIR = path.resolve('/virtual');

function scenario(over: { head?: string; params?: string; steps?: string; outcome?: string } = {}): string {
  return `
schema_version: 1
id: ${over.head ?? 'my-scenario'}
title: T
summary: S
compatible_profiles: [p]
expected_outcome: order_placed
params:
${over.params ?? '  p: { type: string, default: a, description: d }'}
steps:
${over.steps ?? '  - { id: open, title: Open, goto: /cart }'}
outcome:
${
  over.outcome ??
  `  - { id: conf_url, url: { regex: "/thanks" } }
  - { id: conf_text, visible: { role: heading, name: Thanks } }`
}
`;
}

function check(text: string, files: Record<string, string> = {}): RuleIssue[] {
  const file = path.join(DIR, 'a.yaml');
  const read = (f: string) => {
    const t = files[path.relative(DIR, f)];
    if (t === undefined) throw new Error(`no file ${f}`);
    return t;
  };
  const expanded = parseScenario(text, file, [DIR], read).scenario;
  return checkHouseRules({ kind: 'scenario', raw: Scenario.parse(parse(text)), expanded });
}

const rules = (issues: RuleIssue[]) => issues.map((i) => i.rule);

describe('param-described', () => {
  it('passes with description and default', () => {
    expect(rules(check(scenario()))).not.toContain('param-described');
  });
  it('fails on a fragment arg without description', () => {
    const f = Fragment.parse({
      schema_version: 1,
      kind: 'fragment',
      id: 'f',
      description: 'd',
      args: { a: { description: 'x' } },
      steps: [{ id: 's', title: 'S', goto: '/' }],
    });
    f.args.a = { description: ' ' };
    const issues = checkHouseRules({ kind: 'fragment', raw: f });
    expect(issues.find((i) => i.rule === 'param-described')?.path).toBe('args.a.description');
  });
  it('fails on a param without default and required (checked on the raw object)', () => {
    const s = Scenario.parse(parse(scenario()));
    s.params.p = { type: 'string', description: 'd' };
    const issues = checkHouseRules({ kind: 'scenario', raw: s, expanded: s });
    expect(issues.find((i) => i.rule === 'param-described')?.path).toBe('params.p.default');
  });
  it('fails on an empty description', () => {
    const s = Scenario.parse(parse(scenario()));
    s.params.p = { type: 'string', description: ' ', default: 'a' };
    const issues = checkHouseRules({ kind: 'scenario', raw: s, expanded: s });
    expect(issues.find((i) => i.rule === 'param-described')?.path).toBe('params.p.description');
  });
});

describe('outcome-proves-order', () => {
  it('passes with a url check and a visible check', () => {
    expect(rules(check(scenario()))).not.toContain('outcome-proves-order');
  });
  it('fails without a visible or text check', () => {
    const issues = check(scenario({ outcome: '  - { id: conf_url, url: { regex: "/thanks" } }' }));
    expect(issues.filter((i) => i.rule === 'outcome-proves-order')).toHaveLength(1);
  });
  it('a when-guarded check does not count', () => {
    const issues = check(
      scenario({
        outcome: `  - { id: w, when: { param: p, equals: a }, url: { regex: "/ok" } }
  - { id: conf_text, visible: { role: heading, name: Thanks } }`,
      }),
    );
    expect(rules(issues)).toContain('outcome-proves-order');
  });
});

describe('outcome-proves-no-success', () => {
  const declined = (outcome: string) =>
    scenario({ outcome }).replace('expected_outcome: order_placed', 'expected_outcome: payment_declined');
  it('passes with a hidden check', () => {
    const t = declined('  - { id: no_conf, hidden: { role: heading, name: Thanks } }');
    expect(rules(check(t))).not.toContain('outcome-proves-no-success');
  });
  it('passes with a no_response check', () => {
    const t = declined('  - { id: no_order, no_response: { url: "**/order" } }');
    expect(rules(check(t))).not.toContain('outcome-proves-no-success');
  });
  it('fails with only a visible check', () => {
    const t = declined('  - { id: err, visible: { role: alert } }');
    expect(rules(check(t))).toContain('outcome-proves-no-success');
  });
  it('fails for validation_error when the hidden check has a when', () => {
    const t = scenario({
      outcome: '  - { id: h, when: { param: p, equals: a }, hidden: { role: alert } }',
    }).replace('expected_outcome: order_placed', 'expected_outcome: validation_error');
    expect(rules(check(t))).toContain('outcome-proves-no-success');
  });
});

describe('no-literal-personal-data', () => {
  const stepsWith = (action: string) => `  - { id: s1, title: S, ${action} }`;
  it('passes with templates', () => {
    const t = scenario({
      steps: stepsWith('fill: { label: Email }, value: "{{secrets.shop_email}}"'),
    });
    expect(rules(check(t))).not.toContain('no-literal-personal-data');
  });
  it('fails on a literal email in fill', () => {
    const t = scenario({ steps: stepsWith('fill: { label: Email }, value: "a@b.co"') });
    const i = check(t).find((x) => x.rule === 'no-literal-personal-data');
    expect(i?.path).toBe('steps.0.value');
    expect(i?.message).not.toContain('a@b.co');
  });
  it('fails on a literal phone in fill', () => {
    const t = scenario({ steps: stepsWith('fill: { label: Phone }, value: "+90 (532) 123-45-67"') });
    expect(rules(check(t))).toContain('no-literal-personal-data');
  });
  it('does not flag a short number', () => {
    const t = scenario({ steps: stepsWith('fill: { label: Qty }, value: "12345"') });
    expect(rules(check(t))).not.toContain('no-literal-personal-data');
  });
  it('fails on a literal value in a password field', () => {
    const t = scenario({ steps: stepsWith('fill: { label: Şifre }, value: "hunter2"') });
    expect(rules(check(t))).toContain('no-literal-personal-data');
  });
  it('fails on a fill_form email and a password test id', () => {
    const t = scenario({
      steps: `  - id: s1
    title: S
    fill_form:
      - { field: { label: Mail }, value: "x@y.invalid" }
      - { field: { test_id: password-input }, value: "abc" }
      - { field: { label: Name }, value: "Ada" }`,
    });
    const paths = check(t)
      .filter((x) => x.rule === 'no-literal-personal-data')
      .map((x) => x.path);
    expect(paths).toEqual(['steps.0.fill_form.0.value', 'steps.0.fill_form.1.value']);
  });
  it('fails on an email param default', () => {
    const t = scenario({ params: '  email: { type: string, default: "u@example.com", description: d }' });
    expect(check(t).find((x) => x.rule === 'no-literal-personal-data')?.path).toBe('params.email.default');
  });
  it('fails on a with value', () => {
    const frag = `
schema_version: 1
kind: fragment
id: login
description: d
args:
  user: { description: u }
steps:
  - { id: type_user, title: T, fill: { label: User }, value: "{{args.user}}" }
`;
    const t = scenario({
      steps: '  - { id: do_login, title: L, include: fragments/login.yaml, with: { user: "a@b.co" } }',
    });
    const issues = check(t, { 'fragments/login.yaml': frag }).filter(
      (x) => x.rule === 'no-literal-personal-data',
    );
    expect(issues.map((x) => x.path)).toEqual(['steps.0.with.user']);
  });
  it('a literal in a fragment step shows on the include step', () => {
    const frag = `
schema_version: 1
kind: fragment
id: login
description: d
steps:
  - { id: type_user, title: T, fill: { label: User }, value: "a@b.co" }
`;
    const t = scenario({ steps: '  - { id: do_login, title: L, include: fragments/login.yaml }' });
    const issues = check(t, { 'fragments/login.yaml': frag }).filter(
      (x) => x.rule === 'no-literal-personal-data',
    );
    expect(issues.map((x) => x.path)).toEqual(['steps.0.include']);
    expect(issues[0]?.message).toContain('do_login__type_user');
  });
});

describe('id-format', () => {
  it('passes with kebab-case and snake_case', () => {
    expect(rules(check(scenario()))).not.toContain('id-format');
  });
  it('fails on a scenario id with an underscore', () => {
    // The zod regex allows only dashes, so build the object by hand.
    const s = Scenario.parse(parse(scenario()));
    s.id = 'my_scenario';
    expect(rules(checkHouseRules({ kind: 'scenario', raw: s, expanded: s }))).toContain('id-format');
  });
  it('fails on a double dash in the id', () => {
    const s = Scenario.parse(parse(scenario()));
    s.id = 'my--scenario';
    expect(rules(checkHouseRules({ kind: 'scenario', raw: s, expanded: s }))).toContain('id-format');
  });
  it('fails on a step id with a double underscore', () => {
    const t = scenario({ steps: '  - { id: a__b, title: T, goto: / }' });
    expect(check(t).find((x) => x.rule === 'id-format')?.path).toBe('steps.0.id');
  });
});

describe('prefer-semantic-locator', () => {
  it('passes with a role locator', () => {
    const t = scenario({ steps: '  - { id: s1, title: T, click: { role: button, name: Go } }' });
    expect(rules(check(t))).not.toContain('prefer-semantic-locator');
  });
  it('warns on a css locator', () => {
    const t = scenario({ steps: '  - { id: s1, title: T, click: { css: ".go" } }' });
    const i = check(t).find((x) => x.rule === 'prefer-semantic-locator');
    expect(i).toMatchObject({ severity: 'warning', path: 'steps.0.click.css' });
  });
});

describe('payment-step-hint', () => {
  const pay = (extra: string) =>
    scenario({
      steps: `  - { id: pay, title: Complete payment, click: { role: button, name: "Güvenli Öde" }${extra} }`,
    });
  it('warns on a pay step without a hint', () => {
    expect(check(pay(''))).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'payment-step-hint', severity: 'warning' })]),
    );
  });
  it('passes with a hint', () => {
    expect(rules(check(pay(', on_failure: { hint: "3DS frame missing" }')))).not.toContain(
      'payment-step-hint',
    );
  });
  it('matches the title alone', () => {
    const t = scenario({ steps: '  - { id: s1, title: Place order, click: { role: button, name: Go } }' });
    expect(rules(check(t))).toContain('payment-step-hint');
  });
  it('does not match unrelated words', () => {
    const t = scenario({ steps: '  - { id: s1, title: Open the payload page, goto: /x }' });
    expect(rules(check(t))).not.toContain('payment-step-hint');
  });
});

describe('url-glob-query', () => {
  it('passes with a regex url check', () => {
    const t = scenario({
      outcome:
        '  - { id: u, url: { regex: "^https?://[^/]+/thanks/?(?.*)?$" } }\n  - { id: v, visible: { role: alert } }',
    });
    expect(rules(check(t))).not.toContain('url-glob-query');
  });
  it('warns on a glob that ends with **', () => {
    const t = scenario({
      outcome: '  - { id: u, url: { matches: "**/sepet**" } }\n  - { id: v, visible: { role: alert } }',
    });
    const i = check(t).find((x) => x.rule === 'url-glob-query');
    expect(i).toMatchObject({ severity: 'warning', path: 'outcome.0.url.matches' });
    expect(i?.message).toContain('/sepet');
    expect(i?.fix).toContain('^https?://[^/]+/path/?(\\?.*)?$');
  });
  it('warns in a step expect list', () => {
    const t = scenario({
      steps: '  - { id: s1, title: T, goto: /, expect: [{ url: { matches: "**/cart/**" } }] }',
    });
    expect(check(t).find((x) => x.rule === 'url-glob-query')?.path).toBe('steps.0.expect.0.url.matches');
  });
});

describe('checkTestData', () => {
  it('passes with reserved domains', () => {
    const text = 'a: x@example.test\nb: y@shop.example.com\nc: z@mail.invalid\nd: w@example.org\n';
    expect(checkTestData(text)).toEqual([]);
  });
  it('fails on a real domain without echoing the email', () => {
    const issues = checkTestData('a: x@example.test\nb: someone@gmail.com\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: 'test-data-email-domain', severity: 'error', path: 'line 2' });
    expect(JSON.stringify(issues)).not.toContain('someone');
  });
  it('does not accept a look-alike domain', () => {
    expect(rules(checkTestData('a: x@notexample.com\n'))).toContain('test-data-email-domain');
  });
  it('fails on a card-like number without echoing it', () => {
    const issues = checkTestData('card: "4242 4242 4242 4242"\n');
    expect(issues[0]).toMatchObject({ rule: 'test-data-card', path: 'line 1' });
    expect(JSON.stringify(issues)).not.toMatch(/4242/);
  });
  it('passes with a short number', () => {
    expect(checkTestData('zip: "34000"\nphone_ext: 1234\n')).toEqual([]);
  });
});

describe('applyFixes', () => {
  it('adds the schema line and schema_version, keeps comments', () => {
    const { text, fixes } = applyFixes('# keep\nid: a\n', 'scenario', '../schemas/scenario.schema.json');
    expect(text.startsWith('# yaml-language-server: $schema=../schemas/scenario.schema.json\n')).toBe(true);
    expect(text).toContain('# keep');
    expect(text).toContain('schema_version: 1');
    expect(fixes).toHaveLength(2);
  });
  it('puts schema_version first among the keys, after the comments', () => {
    const { text } = applyFixes('# keep\nid: a\ntitle: T # why\n', 'scenario', 's.json');
    expect(text).toBe(
      '# yaml-language-server: $schema=s.json\n# keep\nschema_version: 1\nid: a\ntitle: T # why\n',
    );
  });
  it('changes nothing when both exist', () => {
    const input = '# yaml-language-server: $schema=x.json\nschema_version: 1\nid: a\n';
    expect(applyFixes(input, 'fragment', 's.json')).toEqual({ text: input, fixes: [] });
  });
  it('adds only the missing piece', () => {
    const { text, fixes } = applyFixes('schema_version: 1\nid: a\n', 'fragment', 's.json');
    expect(text).toBe('# yaml-language-server: $schema=s.json\nschema_version: 1\nid: a\n');
    expect(fixes).toHaveLength(1);
  });
});

describe('fix round 1', () => {
  const fragmentOf = (over: Record<string, unknown>) =>
    Fragment.parse({
      schema_version: 1,
      kind: 'fragment',
      id: 'f',
      description: 'd',
      steps: [{ id: 's', title: 'S', goto: '/' }],
      ...over,
    });
  const frag = (over: Record<string, unknown>) =>
    checkHouseRules({ kind: 'fragment', raw: fragmentOf(over) });
  const withSteps = (steps: string) => scenario({ steps });

  it('fragment arg default: email, phone, password name', () => {
    const a = (name: string, d: string | number) => ({ args: { [name]: { description: 'x', default: d } } });
    expect(frag(a('email', 'someone@gmail.com'))[0]).toMatchObject({
      rule: 'no-literal-personal-data',
      path: 'args.email.default',
    });
    expect(rules(frag(a('phone', 5321234567)))).toContain('no-literal-personal-data');
    expect(rules(frag(a('password', 'hunter2')))).toContain('no-literal-personal-data');
    expect(rules(frag(a('qty', 2)))).toEqual([]);
  });
  it('password check covers css and role targets', () => {
    const fill = withSteps(
      '  - { id: s1, title: S, fill: { css: \'input[name="password"]\' }, value: "hunter2" }',
    );
    expect(check(fill).find((x) => x.rule === 'no-literal-personal-data')?.path).toBe('steps.0.value');
    const form = withSteps(
      '  - { id: s1, title: S, fill_form: [{ field: { css: \'input[name="password"]\' }, value: "hunter2" }] }',
    );
    expect(check(form).find((x) => x.rule === 'no-literal-personal-data')?.path).toBe(
      'steps.0.fill_form.0.value',
    );
    const role = withSteps('  - { id: s1, title: S, fill: { role: textbox, name: "Parola" }, value: "x1" }');
    expect(rules(check(role))).toContain('no-literal-personal-data');
  });
  it('css pay words do not count for the pay hint', () => {
    const t = withSteps('  - { id: s1, title: Open, click: { css: ".pay" } }');
    expect(rules(check(t))).not.toContain('payment-step-hint');
  });
  it('Turkish uppercase: ŞİFRE and SİPARİŞİ TAMAMLA', () => {
    const pw = withSteps('  - { id: s1, title: S, fill: { label: "ŞİFRE" }, value: "hunter2" }');
    expect(rules(check(pw))).toContain('no-literal-personal-data');
    const pay = withSteps('  - { id: s1, title: "SİPARİŞİ TAMAMLA", click: { role: button, name: Go } }');
    expect(rules(check(pay))).toContain('payment-step-hint');
  });
  it('flow map root stays valid YAML', () => {
    const { text, fixes } = applyFixes('{id: a, title: T}\n', 'scenario', 's.json');
    const parsed = parse(text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ schema_version: 1, id: 'a', title: 'T' });
    expect(fixes).toHaveLength(2);
  });
  it('scalar or sequence root gets no schema_version', () => {
    expect(applyFixes('- a\n- b\n', 'scenario', 's.json').fixes).toHaveLength(1);
    expect(applyFixes('just text\n', 'scenario', 's.json').text).not.toContain('schema_version');
  });
  it('number param default that looks like a phone', () => {
    const t = scenario({ params: '  phone: { type: integer, default: 5321234567, description: d }' });
    expect(check(t).find((x) => x.rule === 'no-literal-personal-data')?.path).toBe('params.phone.default');
  });
  it('url-glob-query: any ** glob, also a leading one', () => {
    const t = scenario({
      outcome: '  - { id: u, url: { matches: "**/sepet" } }\n  - { id: v, visible: { role: alert } }',
    });
    expect(rules(check(t))).toContain('url-glob-query');
    const ok = scenario({
      outcome:
        '  - { id: u, url: { matches: "https://x.test/sepet" } }\n  - { id: v, visible: { role: alert } }',
    });
    expect(rules(check(ok))).not.toContain('url-glob-query');
  });
  it('fragment kind: id-format, css, pay hint', () => {
    const f = fragmentOf({
      steps: [
        { id: 'a__b', title: 'Pay now', click: { css: '.go' } },
        {
          id: 'ok_step',
          title: 'Pay now',
          click: { role: 'button', name: 'Pay' },
          on_failure: { hint: 'h' },
        },
      ],
    });
    f.id = 'Bad_Id';
    const issues = checkHouseRules({ kind: 'fragment', raw: f });
    const at = (r: string) => issues.filter((i) => i.rule === r).map((i) => i.path);
    expect(at('id-format')).toEqual(['id', 'steps.0.id']);
    expect(at('prefer-semantic-locator')).toEqual(['steps.0.click.css']);
    expect(at('payment-step-hint')).toEqual(['steps.0']);
  });
  it('then-nested fill values', () => {
    const t = withSteps(
      '  - { id: s1, title: S, click: { role: button, name: Go }, then: [{ fill: { label: Mail }, value: "a@b.co" }] }',
    );
    expect(check(t).find((x) => x.rule === 'no-literal-personal-data')?.path).toBe('steps.0.then.0.value');
  });
});

describe('secret keywords match the secret patterns', () => {
  const fragWith = (name: string, d: string) =>
    checkHouseRules({
      kind: 'fragment',
      raw: Fragment.parse({
        schema_version: 1,
        kind: 'fragment',
        id: 'f',
        description: 'd',
        args: { [name]: { description: 'A value.', default: d } },
        steps: [{ id: 's', title: 'S', goto: '/' }],
      }),
    });

  it('refuses a literal default of a token param', () => {
    const issues = check(
      scenario({ params: '  token: { type: string, default: abc123literal, description: Shop key. }' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ rule: 'no-literal-personal-data', path: 'params.token.default' }),
    );
  });

  it('allows a template default of a token param', () => {
    const issues = check(
      scenario({
        params: '  token: { type: string, default: "{{secrets.shop_token}}", description: Shop key. }',
      }),
    );
    expect(rules(issues)).not.toContain('no-literal-personal-data');
  });

  it.each(['api_key', 'apikey', 'secret', 'pwd', 'passwd', 'parola'])(
    'refuses a literal default of a fragment arg named %s',
    (name) => {
      expect(rules(fragWith(name, 'abc123literal'))).toContain('no-literal-personal-data');
    },
  );

  it('allows a template default of an api_key fragment arg', () => {
    expect(rules(fragWith('api_key', '{{secrets.api_key}}'))).toEqual([]);
  });

  it('refuses a literal "with" value for a token arg', () => {
    const issues = check(
      scenario({ steps: '  - { id: inc, title: I, include: f.yaml, with: { token: abc123literal } }' }),
      {
        'f.yaml':
          'schema_version: 1\nkind: fragment\nid: f\ndescription: d\nargs:\n  token: { description: t }\nsteps:\n  - { id: s, title: S, goto: "/{{args.token}}" }\n',
      },
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ rule: 'no-literal-personal-data', path: 'steps.0.with.token' }),
    );
  });
});

describe('secret words in free text', () => {
  const param = (name: string, def: string, description: string) =>
    check(
      scenario({ params: `  ${name}: { type: string, default: ${def}, description: "${description}" }` }),
    );
  const fillLabel = (label: string) =>
    check(scenario({ steps: `  - { id: s1, title: S, fill: { label: "${label}" }, value: SAVE10 }` }));

  it.each([['Discount token.'], ['Gift card token'], ['Secret Santa offer']])(
    'allows a literal default with the description %s',
    (description) => {
      expect(rules(param('code', 'SAVE10', description))).not.toContain('no-literal-personal-data');
    },
  );

  it('allows a literal fill value for a "Promo token" label', () => {
    expect(rules(fillLabel('Promo token'))).not.toContain('no-literal-personal-data');
  });

  it.each([['Account password'], ['Your API key'], ['Store secret key'], ['Yeni şifre'], ['PAROLA']])(
    'refuses a literal default with the description %s',
    (description) => {
      expect(rules(param('code', 'SAVE10', description))).toContain('no-literal-personal-data');
    },
  );

  it('refuses a literal fill value for a "Password" label', () => {
    expect(rules(fillLabel('Password'))).toContain('no-literal-personal-data');
  });

  it('refuses a literal default of a token param name', () => {
    expect(rules(param('token', 'SAVE10', 'Discount code.'))).toContain('no-literal-personal-data');
  });

  it('refuses a literal fill value for a test id or css with a keyword', () => {
    const steps = (loc: string) =>
      check(scenario({ steps: `  - { id: s1, title: S, fill: ${loc}, value: SAVE10 }` }));
    expect(rules(steps('{ test_id: promo-token }'))).toContain('no-literal-personal-data');
    expect(rules(steps(`{ css: "input[name='api_key']" }`))).toContain('no-literal-personal-data');
  });
});
