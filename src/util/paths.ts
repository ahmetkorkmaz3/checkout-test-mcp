import { lstatSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';
import { ToolError } from '../errors/tool-error.js';

/** Scenario file paths: lowercase kebab-case folders and file name, `.yaml` only. */
export const YAML_PATH = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*\.yaml$/;

function refuse(rel: string, reason: string): ToolError {
  return new ToolError({
    code: 'PATH_REFUSED',
    message: `The path "${rel}" is not allowed: ${reason}.`,
    likelyCause:
      'The path must be relative, use forward slashes, stay inside the config folder, and match the file name rule.',
    nextActions: [
      {
        kind: 'change_argument',
        description:
          'Use a relative path like "profile/scenario-id.yaml" with lowercase letters, digits, and hyphens.',
      },
    ],
    details: { reason },
  });
}

function insideOrEqual(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Resolves `rel` under `root`. Throws PATH_REFUSED when the result could leave the real root. */
export function resolveInside(root: string, rel: string, opts: { pattern: RegExp }): string {
  if (path.isAbsolute(rel) || rel.startsWith('/')) throw refuse(rel, 'the path is absolute');
  if (rel.includes('\\')) throw refuse(rel, 'the path has a backslash');
  if (rel.split('/').includes('..')) throw refuse(rel, 'the path has ".."');
  if (!opts.pattern.test(rel)) throw refuse(rel, 'the path does not match the allowed pattern');

  // Compare real paths: the root itself may be a symlink (for example /tmp on macOS).
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw refuse(rel, 'the config folder does not exist');
  }

  // Walk each component, the last one too. A symlink anywhere must resolve inside the root.
  let current = realRoot;
  for (const segment of rel.split('/')) {
    const next = path.join(current, segment);
    let stat: Stats;
    try {
      stat = lstatSync(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        current = next;
        continue;
      }
      throw refuse(rel, 'the path cannot be checked');
    }
    if (stat.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = realpathSync(next);
      } catch {
        throw refuse(rel, 'the path has a symlink that points nowhere');
      }
      if (!insideOrEqual(realRoot, resolved))
        throw refuse(rel, 'the path resolves outside the config folder');
      current = resolved;
    } else {
      current = next;
    }
  }
  return path.resolve(root, rel);
}
