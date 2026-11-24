import { existsSync, realpathSync } from 'node:fs';
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

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Resolves `rel` under `root`. Throws PATH_REFUSED when the result could leave the real root. */
export function resolveInside(root: string, rel: string, opts: { pattern: RegExp }): string {
  if (path.isAbsolute(rel) || rel.startsWith('/')) throw refuse(rel, 'the path is absolute');
  if (rel.includes('\\')) throw refuse(rel, 'the path has a backslash');
  if (rel.split('/').includes('..')) throw refuse(rel, 'the path has ".."');
  if (!opts.pattern.test(rel)) throw refuse(rel, 'the path does not match the allowed pattern');

  const absolute = path.resolve(root, rel);
  // Compare real paths: the root itself may be a symlink (for example /tmp on macOS).
  const realRoot = realpathSync(root);
  let probe = path.dirname(absolute);
  while (!existsSync(probe)) probe = path.dirname(probe);
  const realParent = realpathSync(probe);
  const rest = path.relative(probe, absolute);
  const realTarget = path.join(realParent, rest);
  if (!isInside(realRoot, realTarget)) throw refuse(rel, 'the path resolves outside the config folder');
  return absolute;
}
