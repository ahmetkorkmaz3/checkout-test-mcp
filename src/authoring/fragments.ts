import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { Fragment } from '../schemas/scenario.js';

export interface FragmentSummary {
  /** Relative to the authoring folder, with "/" separators. */
  path: string;
  id: string;
  description: string;
  args: { name: string; description: string; default?: string | number }[];
}

/** The prompts list at most this many fragments, so a large folder does not fill the prompt. */
export const MAX_LISTED_FRAGMENTS = 50;
const MAX_FILE_BYTES = 64 * 1024;

/**
 * The valid fragments in the authoring folder. An agent with only the MCP tools cannot read the
 * folder, so the prompts show this list. A file that does not parse is left out. Symlinks are not followed.
 */
export async function listFragments(dir: string): Promise<FragmentSummary[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
  const out: FragmentSummary[] = [];
  for (const file of files) {
    if (out.length >= MAX_LISTED_FRAGMENTS) break;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES || !/^kind:\s*fragment\s*$/m.test(text)) continue;
    let doc: unknown;
    try {
      doc = parse(text);
    } catch {
      continue;
    }
    const parsed = Fragment.safeParse(doc);
    if (!parsed.success) continue;
    const f = parsed.data;
    out.push({
      path: path.relative(dir, file).split(path.sep).join('/'),
      id: f.id,
      description: f.description.replace(/\s+/g, ' ').trim(),
      args: Object.entries(f.args).map(([name, a]) => ({
        name,
        description: a.description.replace(/\s+/g, ' ').trim(),
        ...(a.default !== undefined ? { default: a.default } : {}),
      })),
    });
  }
  return out;
}
