import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { containsCardNumber } from '../safety/cards.js';
import { Fragment, Scenario } from '../schemas/scenario.js';
import { ExpandError, expandScenario } from './expand.js';

export interface LoadedScenario {
  scenario: Scenario;
  file: string;
  hash: string;
}

export class ScenarioLoadError extends Error {
  override name = 'ScenarioLoadError';
}

async function listYamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

function isFragmentDoc(doc: unknown): boolean {
  return typeof doc === 'object' && doc !== null && (doc as { kind?: unknown }).kind === 'fragment';
}

/**
 * Parses one scenario file and expands its includes.
 * `roots` limits where fragment files can come from. Default: the folder of the file.
 */
export function parseScenario(
  text: string,
  file: string,
  roots: readonly string[] = [path.dirname(file)],
  readText?: (file: string) => string,
): LoadedScenario {
  if (containsCardNumber(text)) {
    throw new ScenarioLoadError(`${file}: contains a card number. Use a test_card param instead.`);
  }
  const result = Scenario.safeParse(parse(text));
  if (!result.success) {
    throw new ScenarioLoadError(`${file}: invalid scenario:\n${z.prettifyError(result.error)}`);
  }
  try {
    const { scenario, fragments } = expandScenario(
      result.data,
      file,
      readText ? { roots, readFile: readText } : { roots },
    );
    const hash = createHash('sha256').update(text);
    for (const f of fragments) hash.update(f.text);
    return { scenario, file, hash: hash.digest('hex').slice(0, 16) };
  } catch (err) {
    if (err instanceof ExpandError) throw new ScenarioLoadError(err.message);
    throw err;
  }
}

export interface LoadOptions {
  /** Absolute file path to text. The text replaces the disk content. null removes the file. */
  overrides?: ReadonlyMap<string, string | null>;
}

function isUnder(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export class ScenarioRegistry {
  private constructor(private byId: Map<string, LoadedScenario>) {}

  static async load(dirs: readonly string[], opts: LoadOptions = {}): Promise<ScenarioRegistry> {
    const overrides = new Map<string, string | null>();
    for (const [f, t] of opts.overrides ?? []) overrides.set(path.resolve(f), t);
    // Fragment includes must see the same override text as the scenario files.
    const readText = (f: string): string => {
      const o = overrides.get(path.resolve(f));
      if (o === null) throw new Error(`${f}: removed by override`);
      return o ?? readFileSync(f, 'utf8');
    };
    const byId = new Map<string, LoadedScenario>();
    const errors: string[] = [];
    for (const dir of dirs) {
      let files: string[];
      try {
        files = await listYamlFiles(dir);
        // A new file that is not on disk yet still belongs to the dir that contains it.
        for (const f of overrides.keys()) {
          if (/\.ya?ml$/.test(f) && isUnder(f, dir) && !files.includes(f)) files.push(f);
        }
        files = files.filter((f) => overrides.get(f) !== null).sort();
      } catch (err) {
        errors.push(`Cannot read scenario dir ${dir}: ${(err as Error).message}`);
        continue;
      }
      for (const file of files) {
        try {
          const text = overrides.get(file) ?? (await readFile(file, 'utf8'));
          const doc: unknown = parse(text);
          if (isFragmentDoc(doc)) {
            // Fragments are not scenarios. Validate them here so a broken fragment shows at startup.
            const frag = Fragment.safeParse(doc);
            if (!frag.success) errors.push(`${file}: invalid fragment:\n${z.prettifyError(frag.error)}`);
            continue;
          }
          const loaded = parseScenario(text, file, dirs, readText);
          const existing = byId.get(loaded.scenario.id);
          if (existing) {
            errors.push(`Duplicate scenario id "${loaded.scenario.id}" in ${existing.file} and ${file}.`);
            continue;
          }
          byId.set(loaded.scenario.id, loaded);
        } catch (err) {
          errors.push((err as Error).message);
        }
      }
    }
    if (errors.length > 0) throw new ScenarioLoadError(errors.join('\n'));
    return new ScenarioRegistry(byId);
  }

  static fromLoaded(items: LoadedScenario[]): ScenarioRegistry {
    return new ScenarioRegistry(new Map(items.map((i) => [i.scenario.id, i])));
  }

  /** Replaces the list in place. Every holder of this object sees the new scenarios. */
  swap(next: ScenarioRegistry): void {
    this.byId = next.byId;
  }

  get(id: string): LoadedScenario | undefined {
    return this.byId.get(id);
  }

  list(): LoadedScenario[] {
    return [...this.byId.values()];
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }
}
