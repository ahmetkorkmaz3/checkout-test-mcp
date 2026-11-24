import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { z } from 'zod';
import { ToolError } from '../errors/tool-error.js';
import { sortKeys } from '../runs/manager.js';
import { containsCardNumber } from '../safety/cards.js';
import { looksLikeSecret } from '../safety/secrets.js';
import { ScenarioRegistry } from '../scenarios/registry.js';
import type { NextAction, ParamValue, RunStatus } from '../schemas/common.js';
import { Fragment, Scenario } from '../schemas/scenario.js';
import type { ServerDeps } from '../server.js';
import { resolveInside, YAML_PATH } from '../util/paths.js';
import { applyFixes, checkHouseRules, checkTestData, type RuleIssue } from './rules.js';

export type SaveKind = 'scenario' | 'fragment' | 'test_data';

export interface SaveInput {
  kind: SaveKind;
  path: string;
  yaml: string;
  overwrite?: boolean;
  validate_on?: { target: string; params?: Record<string, ParamValue> };
}

export interface SaveResult {
  path: string;
  kind: SaveKind;
  scenario_id: string | null;
  written: boolean;
  unchanged: boolean;
  fixes_applied: string[];
  warnings: RuleIssue[];
  validation: { run_id: string; status: RunStatus; reused_existing_run: boolean } | null;
  next: NextAction;
}

// src/authoring/save.ts and dist/authoring/save.js both sit two folders below the package root.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A relative schema path when the file is inside this package, so the line works on every clone. */
export function schemaPathFor(kind: 'scenario' | 'fragment', file: string): string {
  const schema = path.join(PACKAGE_ROOT, 'schemas', `${kind}.schema.json`);
  const rel = path.relative(PACKAGE_ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return schema;
  return path.relative(path.dirname(file), schema).split(path.sep).join('/');
}

function invalid(issues: RuleIssue[], what: string): ToolError {
  return new ToolError({
    code: 'SCENARIO_INVALID',
    message: `The ${what} breaks ${issues.length} rule${issues.length === 1 ? '' : 's'}. Nothing was written.`,
    likelyCause: 'The YAML does not match the schema, a house rule, or the other scenario files.',
    nextActions: [
      {
        kind: 'fix_scenario',
        description: 'Fix every issue in details.issues, then call save_scenario again with the fixed YAML.',
        tool: 'save_scenario',
      },
    ],
    details: { issues },
  });
}

function issue(rule: string, pathText: string, message: string, fix: string): RuleIssue {
  return { rule, severity: 'error', path: pathText, message, fix };
}

// A YAML key is user text. Only a key with plain name characters can show in a result.
const PLAIN_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * zod puts a bad record key into the path and an unknown key into the message.
 * Such a key can be an email or another value, so it shows only when it is a plain name.
 */
function zodIssues(error: z.ZodError, what: string): RuleIssue[] {
  return error.issues.map((i) => {
    const issuePath = i.path
      .map((seg) => (typeof seg === 'number' || PLAIN_KEY.test(String(seg)) ? String(seg) : '<key>'))
      .join('.');
    let message = i.message;
    if (i.code === 'unrecognized_keys') {
      const plain = i.keys.filter((k) => PLAIN_KEY.test(k));
      const hidden = i.keys.length - plain.length;
      message = `Unknown key${i.keys.length === 1 ? '' : 's'}: ${[
        ...plain.map((k) => `"${k}"`),
        ...(hidden > 0 ? [`${hidden} key${hidden === 1 ? '' : 's'} with other characters`] : []),
      ].join(', ')}. Remove ${i.keys.length === 1 ? 'it' : 'them'}.`;
    }
    return issue(
      'schema',
      issuePath,
      `${what} schema: ${message}`,
      `Change the value to match the ${what} schema. docs/scenario-format.md describes every field.`,
    );
  });
}

function parseYaml(text: string): unknown {
  try {
    return parse(text);
  } catch (err) {
    throw invalid(
      [
        issue(
          'yaml-syntax',
          '',
          `The text is not valid YAML: ${(err as Error).message.split('\n')[0]}`,
          'Fix the YAML syntax.',
        ),
      ],
      'YAML',
    );
  }
}

// A key whose whole value is one template, for example `password: "{{secrets.member_password}}"`.
// The value is a reference, not a secret. A literal value or text next to the template stays in.
// A template-only "default:" goes too, so the map key check below sees only literal defaults.
const TEMPLATE_ONLY_VALUE = /[\w-]+\s*[=:][ \t]*(["']?)\{\{[^{}\n]*\}\}\1(?=[ \t]*(?:$|[,}\]#]))/gm;
const MAP_KEY_LINE = /^([ \t]*)[\w-]+:[ \t]*\r?$/;
const NESTED_KEY_LINE = /^([ \t]+)[\w-]+[ \t]*:/;
const LITERAL_DEFAULT = /^[ \t]+default[ \t]*:[ \t]*\S/;

const indentOf = (line: string): number => /^[ \t]*/.exec(line)?.[0].length ?? 0;

/**
 * Removes keys that hold no literal value, so the secret check sees only literal values.
 * 1. A key whose whole value is one template.
 * 2. A key that opens a nested map, for example a fragment arg "password:" with a "description:" line
 *    below. Without this, the secret pattern reads the next line as the value. The key stays when its
 *    block has a literal "default:", because a param or arg default is a value of that key.
 *    A scalar on the next line also keeps the key.
 */
function withoutReferenceValues(text: string): string {
  const lines = text.replace(TEMPLATE_ONLY_VALUE, '').split('\n');
  return lines
    .map((line, i) => {
      const key = MAP_KEY_LINE.exec(line);
      const next = lines[i + 1];
      if (!key || next === undefined) return line;
      const keyIndent = (key[1] as string).length;
      const nested = NESTED_KEY_LINE.exec(next);
      if (!nested || (nested[1] as string).length <= keyIndent) return line;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] as string;
        if (l.trim() === '') continue;
        if (indentOf(l) <= keyIndent) break;
        if (LITERAL_DEFAULT.test(l)) return line;
      }
      return '';
    })
    .join('\n');
}

function checkInputSafety(text: string): void {
  // Registry test card numbers are refused too: scenarios name a test_card param, never a number.
  if (containsCardNumber(text)) {
    throw new ToolError({
      code: 'REAL_CARD_DATA_REFUSED',
      message: 'The YAML contains a number that looks like a payment card number. Nothing was written.',
      likelyCause: 'A card number was written into the file. Files must never hold card numbers.',
      nextActions: [
        {
          kind: 'fix_scenario',
          description:
            'Remove the number. Add a param of type test_card and use {{card.number}} in the fill step.',
        },
        {
          kind: 'call_tool',
          description: 'Get the valid test card ids.',
          tool: 'list_scenarios',
          arguments: {},
        },
      ],
    });
  }
  if (looksLikeSecret(withoutReferenceValues(text))) {
    throw new ToolError({
      code: 'SECRET_IN_ARGUMENTS',
      message:
        'The YAML contains text that looks like a secret (password, token, or API key). Nothing was written.',
      likelyCause:
        'A credential was written into the file. Scenarios read secrets from environment variables.',
      nextActions: [
        {
          kind: 'fix_scenario',
          description: 'Replace the value with {{secrets.<name>}}.',
        },
        {
          kind: 'ask_human',
          description:
            'Ask a human to put the secret in an environment variable and map it in the target "secrets" config.',
        },
      ],
    });
  }
}

function authoringDisabled(message: string, description: string): ToolError {
  return new ToolError({
    code: 'AUTHORING_DISABLED',
    message,
    likelyCause: 'The server config does not turn on this kind of save.',
    nextActions: [{ kind: 'ask_human', description }],
  });
}

/** An fs error message holds the absolute path. The result names only the relative path and the code. */
function fsRefused(rel: string, err: unknown): ToolError {
  const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
  return new ToolError({
    code: 'PATH_REFUSED',
    message: `The server cannot read or write "${rel}" (${code}). Nothing was written.`,
    likelyCause:
      code === 'EISDIR'
        ? 'A folder has this name.'
        : 'A folder or file in the path has the wrong type or permissions.',
    nextActions: [
      { kind: 'change_argument', description: 'Use another path for the file.', tool: 'save_scenario' },
    ],
    details: { reason: code },
  });
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Temp file in the same folder, then rename: a reader never sees half a file. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // The ".tmp" end keeps the registry from reading the temp file as a scenario.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

interface Checked {
  text: string;
  fixes: string[];
  warnings: RuleIssue[];
  scenarioId: string | null;
  trial: ScenarioRegistry | null;
  /** Hash of the scenario text and all its fragment texts, from the trial load. */
  loadedHash: string | null;
}

async function checkScenarioOrFragment(
  deps: ServerDeps,
  kind: 'scenario' | 'fragment',
  file: string,
  yaml: string,
): Promise<Checked> {
  const { text, fixes } = applyFixes(yaml, kind, schemaPathFor(kind, file));
  const doc = parseYaml(text);
  const schema = kind === 'scenario' ? Scenario : Fragment;
  const parsed = schema.safeParse(doc);
  if (!parsed.success) throw invalid(zodIssues(parsed.error, kind), kind);

  // The trial load sees the new text in place of the file, so a fragment change also checks its users.
  let trial: ScenarioRegistry;
  try {
    trial = await ScenarioRegistry.load(deps.config.scenario_dirs, { overrides: new Map([[file, text]]) });
  } catch (err) {
    // Paths relative to the config folder are shorter and do not show the local folder layout.
    const prefix = deps.config.config_dir + path.sep;
    const lines = (err as Error).message
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.split(prefix).join(''));
    throw invalid(
      lines.map((l) =>
        issue(
          'trial-load',
          '',
          l,
          'Fix the file so that all scenario folders load. A duplicate id needs a new id. A fragment change must keep every including scenario valid.',
        ),
      ),
      kind,
    );
  }

  let issues: RuleIssue[];
  let scenarioId: string | null = null;
  let loadedHash: string | null = null;
  if (kind === 'scenario') {
    const raw = parsed.data as Scenario;
    const loaded = trial.list().find((l) => path.resolve(l.file) === file);
    if (!loaded) throw new Error('The trial load has no scenario for the saved file.');
    issues = checkHouseRules({ kind: 'scenario', raw, expanded: loaded.scenario });
    scenarioId = raw.id;
    loadedHash = loaded.hash;
  } else {
    issues = checkHouseRules({ kind: 'fragment', raw: parsed.data as Fragment });
  }
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) throw invalid(errors, kind);
  return {
    text,
    fixes,
    warnings: issues.filter((i) => i.severity === 'warning'),
    scenarioId,
    trial,
    loadedHash,
  };
}

function checkTestDataText(yaml: string): Checked {
  parseYaml(yaml);
  const issues = checkTestData(yaml);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) throw invalid(errors, 'test data file');
  return {
    text: yaml,
    fixes: [],
    warnings: issues.filter((i) => i.severity === 'warning'),
    scenarioId: null,
    trial: null,
    loadedHash: null,
  };
}

// One save at a time per registry: two parallel trial loads would each miss the other file.
const locks = new WeakMap<object, Promise<unknown>>();

export function saveScenario(deps: ServerDeps, input: SaveInput): Promise<SaveResult> {
  const before = locks.get(deps.registry) ?? Promise.resolve();
  const run = before.then(
    () => doSave(deps, input),
    () => doSave(deps, input),
  );
  locks.set(
    deps.registry,
    run.catch(() => undefined),
  );
  return run;
}

async function doSave(deps: ServerDeps, input: SaveInput): Promise<SaveResult> {
  const { config } = deps;
  if (!config.authoring) {
    throw authoringDisabled(
      'save_scenario is off on this server. Nothing was written.',
      'Ask a human to add an "authoring" block with "dir" to the server config, then restart the server.',
    );
  }
  if (input.kind === 'test_data' && !config.authoring.test_data_dir_writable) {
    throw authoringDisabled(
      'This server does not write test data files. Nothing was written.',
      'Ask a human to set "authoring.test_data_dir_writable: true" in the server config, then restart the server.',
    );
  }
  if (input.validate_on && input.kind !== 'scenario') {
    throw new ToolError({
      code: 'INVALID_PARAMS',
      message: `validate_on works only with kind "scenario", not "${input.kind}". Nothing was written.`,
      likelyCause: 'A fragment or a test data file cannot run alone.',
      nextActions: [
        {
          kind: 'change_argument',
          description:
            'Call save_scenario again without validate_on. Then run a scenario that uses the file with run_scenario.',
          tool: 'save_scenario',
        },
      ],
    });
  }

  const root = input.kind === 'test_data' ? config.test_data_dir : config.authoring.dir;
  // The config load checks that authoring.dir is inside scenario_dirs. A new setup can have no folder yet.
  try {
    await mkdir(root, { recursive: true });
  } catch (err) {
    throw fsRefused(input.path, err);
  }
  const file = resolveInside(root, input.path, { pattern: YAML_PATH });

  checkInputSafety(input.yaml);

  const checked =
    input.kind === 'test_data'
      ? checkTestDataText(input.yaml)
      : await checkScenarioOrFragment(deps, input.kind, file, input.yaml);

  let existing: string | undefined;
  try {
    existing = await readIfExists(file);
  } catch (err) {
    throw fsRefused(input.path, err);
  }
  const unchanged = existing === checked.text;
  if (existing !== undefined && !unchanged && !input.overwrite) {
    throw new ToolError({
      code: 'SCENARIO_EXISTS',
      message: `The file "${input.path}" exists with different content. Nothing was written.`,
      likelyCause: 'Another scenario uses this path, or this is a change to a file that you saved before.',
      nextActions: [
        {
          kind: 'change_argument',
          description: 'Set overwrite to true to replace the file, or use a new path.',
          tool: 'save_scenario',
          arguments: { overwrite: true },
        },
      ],
    });
  }
  if (!unchanged) {
    try {
      await writeAtomic(file, checked.text);
    } catch (err) {
      throw fsRefused(input.path, err);
    }
  }
  if (checked.trial) deps.registry.swap(checked.trial);
  deps.logger.info('save_scenario', {
    kind: input.kind,
    path: input.path,
    written: !unchanged,
    scenario_id: checked.scenarioId,
  });

  const base = {
    path: input.path,
    kind: input.kind,
    scenario_id: checked.scenarioId,
    written: !unchanged,
    unchanged,
    fixes_applied: checked.fixes,
    warnings: checked.warnings,
  };

  if (input.validate_on && checked.scenarioId && checked.loadedHash) {
    const params = input.validate_on.params ?? {};
    const hash = createHash('sha256')
      // The loaded hash covers the fragments too, so a fragment change gives a new run.
      .update(input.validate_on.target + checked.loadedHash + JSON.stringify(sortKeys(params)))
      .digest('hex')
      .slice(0, 16);
    let started: Awaited<ReturnType<ServerDeps['manager']['start']>>;
    try {
      started = await deps.manager.start({
        target: input.validate_on.target,
        scenario_id: checked.scenarioId,
        params,
        idempotency_key: `save-${checked.scenarioId.slice(0, 60)}-${hash}`,
      });
    } catch (err) {
      throw savedButNotStarted(err, input.path);
    }
    const { record, reused } = started;
    return {
      ...base,
      validation: { run_id: record.run_id, status: record.status, reused_existing_run: reused },
      next: {
        kind: 'call_tool',
        description: 'Wait for the validation run and get the result.',
        tool: 'get_run_result',
        arguments: { run_id: record.run_id, wait_s: 20 },
      },
    };
  }

  return {
    ...base,
    validation: null,
    next: checked.scenarioId
      ? {
          kind: 'call_tool',
          description: 'Run the saved scenario on a test target to check it.',
          tool: 'run_scenario',
          arguments: { scenario_id: checked.scenarioId },
        }
      : {
          kind: 'call_tool',
          description: 'List the scenarios, then run one that uses this file.',
          tool: 'list_scenarios',
          arguments: {},
        },
  };
}

/** The file is on disk at this point. The error must say so, or the agent saves again for no reason. */
function savedButNotStarted(err: unknown, rel: string): unknown {
  if (!(err instanceof ToolError)) return err;
  return new ToolError({
    code: err.code,
    message: `The file "${rel}" was saved, but the validation run did not start: ${err.message}`,
    likelyCause: err.likelyCause,
    retryable: err.retryable,
    nextActions: err.nextActions as [NextAction, ...NextAction[]],
    details: { ...err.details, saved: true, path: rel },
  });
}
