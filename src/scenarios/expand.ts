import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { containsCardNumber } from '../safety/cards.js';
import type { ParamValue } from '../schemas/common.js';
import { type Condition, Fragment, type Scenario, type Step, type When } from '../schemas/scenario.js';

const MAX_INCLUDE_DEPTH = 5;
const ARG_TOKEN = /\{\{\s*args\.([a-z][a-z0-9_]*)\s*\}\}/g;

export class ExpandError extends Error {
  override name = 'ExpandError';
}

export interface ExpandOptions {
  /** Fragment files must be inside one of these folders. */
  roots: readonly string[];
  readFile?: (file: string) => string;
}

export interface Expanded {
  scenario: Scenario;
  /** Fragment files and their text, in load order. Used for the scenario hash. */
  fragments: Array<{ file: string; text: string }>;
}

export function toConditions(when: When | undefined): Condition[] {
  if (!when) return [];
  return Array.isArray(when) ? when : [when];
}

/** True when every condition passes for the resolved params. */
export function conditionsPass(when: When | undefined, values: Record<string, ParamValue>): boolean {
  return toConditions(when).every((c) => {
    const actual = values[c.param];
    if (actual === undefined) return false;
    const same = (v: ParamValue) => String(v) === String(actual);
    if (c.equals !== undefined) return same(c.equals);
    if (c.not_equals !== undefined) return !same(c.not_equals);
    return (c.in ?? []).some(same);
  });
}

function substituteArgs<T>(value: T, args: Record<string, string | number>, where: string): T {
  if (typeof value === 'string') {
    return value.replace(ARG_TOKEN, (_m, name: string) => {
      const v = args[name];
      if (v === undefined) throw new ExpandError(`${where}: unknown fragment arg "{{args.${name}}}".`);
      return String(v);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => substituteArgs(v, args, where)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteArgs(v, args, where);
    return out as T;
  }
  return value;
}

function isInside(file: string, roots: readonly string[]): boolean {
  return roots.some((r) => {
    const rel = path.relative(path.resolve(r), file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/**
 * Replaces every "include" step with the fragment steps.
 * Expanded step ids get the include step id as prefix: "<include_id>__<step_id>".
 * The include step "when" applies to every expanded step.
 */
export function expandScenario(scenario: Scenario, file: string, opts: ExpandOptions): Expanded {
  const read = opts.readFile ?? ((f: string) => readFileSync(f, 'utf8'));
  const fragments: Expanded['fragments'] = [];

  const expandSteps = (
    steps: Step[],
    fromFile: string,
    prefix: string,
    inherited: Condition[],
    stack: string[],
  ): Step[] => {
    const out: Step[] = [];
    for (const step of steps) {
      const when = [...inherited, ...toConditions(step.when)];
      if (step.include === undefined) {
        const { when: _drop, ...rest } = step;
        out.push({ ...rest, id: `${prefix}${step.id}`, ...(when.length ? { when } : {}) });
        continue;
      }
      const where = `${fromFile}: step "${step.id}"`;
      if (stack.length >= MAX_INCLUDE_DEPTH) {
        throw new ExpandError(`${where}: includes are nested more than ${MAX_INCLUDE_DEPTH} levels.`);
      }
      const target = path.resolve(path.dirname(fromFile), step.include);
      if (!isInside(target, opts.roots)) {
        throw new ExpandError(`${where}: fragment "${step.include}" is outside the scenario folders.`);
      }
      if (stack.includes(target)) {
        throw new ExpandError(
          `${where}: include cycle: ${[...stack, target].map((f) => path.basename(f)).join(' -> ')}.`,
        );
      }
      let text: string;
      try {
        text = read(target);
      } catch {
        throw new ExpandError(`${where}: fragment file "${step.include}" does not exist.`);
      }
      if (containsCardNumber(text)) {
        throw new ExpandError(`${target}: contains a card number. Use a test_card param instead.`);
      }
      const parsed = Fragment.safeParse(parse(text));
      if (!parsed.success) {
        throw new ExpandError(`${target}: invalid fragment:\n${z.prettifyError(parsed.error)}`);
      }
      fragments.push({ file: target, text });
      const fragment = parsed.data;
      const given = step.with ?? {};
      for (const name of Object.keys(given)) {
        if (!(name in fragment.args)) {
          const known = Object.keys(fragment.args);
          throw new ExpandError(
            `${where}: fragment "${fragment.id}" has no arg "${name}". Known args: ${known.length ? known.join(', ') : 'none'}.`,
          );
        }
      }
      const args: Record<string, string | number> = {};
      for (const [name, def] of Object.entries(fragment.args)) {
        const v = given[name] ?? def.default;
        if (v === undefined)
          throw new ExpandError(`${where}: fragment "${fragment.id}" needs arg "${name}".`);
        args[name] = v;
      }
      const fragmentSteps = substituteArgs(fragment.steps, args, target);
      out.push(...expandSteps(fragmentSteps, target, `${prefix}${step.id}__`, when, [...stack, target]));
    }
    return out;
  };

  const steps = expandSteps(scenario.steps, file, '', [], [path.resolve(file)]);

  // Checks that need the expanded scenario.
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const id of [...steps.map((s) => s.id), ...scenario.outcome.map((o) => o.id)]) {
    if (ids.has(id)) problems.push(`Duplicate step or outcome id "${id}" after includes.`);
    ids.add(id);
  }
  for (const item of [...steps, ...scenario.outcome]) {
    for (const c of toConditions(item.when)) {
      if (!(c.param in scenario.params))
        problems.push(`"${item.id}": condition uses unknown param "${c.param}".`);
    }
  }
  const leftover = JSON.stringify([steps, scenario.outcome]).match(ARG_TOKEN);
  if (leftover) problems.push(`${leftover[0]} is allowed only inside a fragment.`);
  if (problems.length > 0) throw new ExpandError(`${file}:\n- ${problems.join('\n- ')}`);

  return { scenario: { ...scenario, steps }, fragments };
}
