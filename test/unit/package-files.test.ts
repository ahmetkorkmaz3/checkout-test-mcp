import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const allowed = [
  'dist/',
  'scenarios/',
  'test-data/',
  'schemas/',
  'examples/demo-store/server.mjs',
  'checkout-test-mcp.config.example.yaml',
  'LICENSE',
  'README.md',
  'package.json',
];

function packedPaths(): string[] {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const [info] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return (info?.files ?? []).map((f) => f.path);
}

describe('npm pack allow list', () => {
  const paths = packedPaths();

  it('packs only allowed paths', () => {
    const extra = paths.filter((p) => !allowed.some((a) => p.startsWith(a)));
    expect(extra).toEqual([]);
  });

  it('packs the license and the demo store server', () => {
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('examples/demo-store/server.mjs');
  });

  it('packs no test source map and no env file', () => {
    expect(paths.filter((p) => p.startsWith('test/') && p.includes('.map'))).toEqual([]);
    expect(paths.filter((p) => /(^|\/)\.env/.test(p))).toEqual([]);
  });
});
