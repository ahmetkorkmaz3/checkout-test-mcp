import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Find the package folder from this file, not from process.cwd().
// After "npx" the working folder is the user's folder, not ours.
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (existsSync(file)) {
      try {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string };
        if (pkg.name === 'checkout-test-mcp') return dir;
      } catch {
        // Not our package.json. Keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot find the checkout-test-mcp package folder.');
    dir = parent;
  }
}
