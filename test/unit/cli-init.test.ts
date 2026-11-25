import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../src/cli/init.js';
import { packageRoot } from '../../src/cli/package-root.js';
import { loadConfig } from '../../src/config/load-config.js';

const root = packageRoot();
const dirs: string[] = [];

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'ctm-init-'));
  dirs.push(d);
  return d;
}

function setup(dir: string, skipBrowser = false) {
  const lines: string[] = [];
  const installBrowser = vi.fn(async () => {});
  const run = () => runInit({ dir, skipBrowser, root, log: (l) => lines.push(l), installBrowser });
  return { lines, installBrowser, run };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('runInit', () => {
  it('writes the starter files and installs the browser once', async () => {
    const dir = await tmp();
    const { run, installBrowser } = setup(dir);
    expect(await run()).toBe(0);
    expect(existsSync(path.join(dir, 'checkout-test-mcp.config.yaml'))).toBe(true);
    expect(existsSync(path.join(dir, 'scenarios/demo-store/card-success.yaml'))).toBe(true);
    expect(existsSync(path.join(dir, 'test-data'))).toBe(true);
    expect(installBrowser).toHaveBeenCalledTimes(1);
  });

  it('skips the browser install with skipBrowser', async () => {
    const { run, installBrowser } = setup(await tmp(), true);
    expect(await run()).toBe(0);
    expect(installBrowser).not.toHaveBeenCalled();
  });

  it('returns 0 and mentions Chrome when the browser install fails', async () => {
    const dir = await tmp();
    const { run, lines, installBrowser } = setup(dir);
    installBrowser.mockRejectedValueOnce(new Error('offline'));
    expect(await run()).toBe(0);
    expect(lines.join('\n')).toContain('Google Chrome');
  });

  it('refuses before any write when scenarios exists', async () => {
    const dir = await tmp();
    await mkdir(path.join(dir, 'scenarios'));
    const { run, lines, installBrowser } = setup(dir);
    expect(await run()).toBe(1);
    expect(lines.join('\n')).toContain('scenarios');
    expect(existsSync(path.join(dir, 'checkout-test-mcp.config.yaml'))).toBe(false);
    expect(existsSync(path.join(dir, 'test-data'))).toBe(false);
    expect(installBrowser).not.toHaveBeenCalled();
  });

  it('never writes to stdout', async () => {
    const spy = vi.spyOn(process.stdout, 'write');
    const { run } = setup(await tmp());
    await run();
    expect(spy).not.toHaveBeenCalled();
  });

  it('writes a config that loads and has the demo-local target', async () => {
    const dir = await tmp();
    const { run, lines } = setup(dir, true);
    await run();
    const cfg = await loadConfig(path.join(dir, 'checkout-test-mcp.config.yaml'));
    expect(Object.keys(cfg.targets)).toContain('demo-local');
    expect(lines.join('\n')).toContain('npx -y checkout-test-mcp');
  });
});

describe('packageRoot', () => {
  it('finds the package folder', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('checkout-test-mcp');
  });
});
