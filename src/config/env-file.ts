import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const KEY_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=(.*)$/;

/**
 * Finds the first line that is not a comment, a blank, or KEY=value.
 * node:util parseEnv skips such lines without an error, so a typo would hide a secret.
 * Returns the 1-based line number only. The text of a line can hold a secret.
 */
function findBadLine(text: string): number | undefined {
  const lines = text.split(/\r?\n/);
  let open: string | undefined; // quote char of a multi-line value
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (open) {
      if (line.includes(open)) open = undefined;
      continue;
    }
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = KEY_LINE.exec(line);
    if (!m) return i + 1;
    const value = (m[1] ?? '').trimStart();
    const q = value[0];
    if ((q === '"' || q === "'" || q === '`') && !value.slice(1).includes(q)) open = q;
  }
  return open ? lines.length : undefined;
}

/**
 * Reads a dotenv file and sets each key that `env` does not have yet.
 * A value that is already set wins, so the shell can override the file.
 * Results and errors hold key names, paths, and line numbers only. Never a value.
 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv): { loaded: string[]; skipped: string[] } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    throw new Error(`Cannot read env file ${path} (${code}).`);
  }
  const bad = findBadLine(text);
  if (bad !== undefined) {
    throw new Error(`Env file ${path} has a line that is not KEY=value at line ${bad}.`);
  }
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(text) as Record<string, string>;
  } catch {
    throw new Error(`Cannot parse env file ${path}.`);
  }
  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined) {
      skipped.push(key);
    } else {
      env[key] = value;
      loaded.push(key);
    }
  }
  return { loaded, skipped };
}
