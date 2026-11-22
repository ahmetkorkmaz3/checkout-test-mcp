import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { containsCardNumber } from '../safety/cards.js';
import { Scenario } from '../schemas/scenario.js';

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

export function parseScenario(text: string, file: string): LoadedScenario {
  if (containsCardNumber(text)) {
    throw new ScenarioLoadError(`${file}: contains a card number. Use a test_card param instead.`);
  }
  const result = Scenario.safeParse(parse(text));
  if (!result.success) {
    throw new ScenarioLoadError(`${file}: invalid scenario:\n${z.prettifyError(result.error)}`);
  }
  return { scenario: result.data, file, hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
}

export class ScenarioRegistry {
  private constructor(private readonly byId: Map<string, LoadedScenario>) {}

  static async load(dirs: readonly string[]): Promise<ScenarioRegistry> {
    const byId = new Map<string, LoadedScenario>();
    const errors: string[] = [];
    for (const dir of dirs) {
      let files: string[];
      try {
        files = await listYamlFiles(dir);
      } catch (err) {
        errors.push(`Cannot read scenario dir ${dir}: ${(err as Error).message}`);
        continue;
      }
      for (const file of files) {
        try {
          const loaded = parseScenario(await readFile(file, 'utf8'), file);
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
