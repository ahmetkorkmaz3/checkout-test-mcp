import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/app.js';
import { loadEnvFile } from '../../src/config/env-file.js';
import { parseConfig } from '../../src/config/load-config.js';
import { silentLogger } from '../../src/logger.js';
import { RunManager } from '../../src/runs/manager.js';

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'env-file-'));
}

const rawConfig = (extra: Record<string, unknown> = {}) => ({
  targets: {
    demo: {
      profile: 'demo-store',
      base_url: 'http://localhost:4173',
      allowed_hosts: ['localhost'],
    },
  },
  ...extra,
});

describe('loadEnvFile', () => {
  it('sets keys that are not in env', async () => {
    const file = path.join(await tmp(), '.env');
    await writeFile(file, 'A=1\nB="two words"\n');
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile(file, env);
    expect(env).toEqual({ A: '1', B: 'two words' });
    expect(result).toEqual({ loaded: ['A', 'B'], skipped: [] });
  });

  it('keeps a key that is already set and lists it as skipped', async () => {
    const file = path.join(await tmp(), '.env');
    await writeFile(file, 'A=from-file\nB=2\n');
    const env: NodeJS.ProcessEnv = { A: 'from-shell' };
    const result = loadEnvFile(file, env);
    expect(env.A).toBe('from-shell');
    expect(env.B).toBe('2');
    expect(result).toEqual({ loaded: ['B'], skipped: ['A'] });
  });

  it('names the path of a missing file and no value', async () => {
    const file = path.join(await tmp(), 'missing.env');
    expect(() => loadEnvFile(file, {})).toThrow(file);
  });

  it('names the line of a bad line and never its text', async () => {
    const file = path.join(await tmp(), '.env');
    await writeFile(file, 'A=1\n\n# comment\nthis is s3cr3t-value\n');
    let message = '';
    try {
      loadEnvFile(file, {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(file);
    expect(message).toContain('line 4');
    expect(message).not.toContain('s3cr3t-value');
  });

  it('names the start line of an unterminated quote and never its text', async () => {
    const file = path.join(await tmp(), '.env');
    await writeFile(file, 'A=1\nB="s3cr3t-value\n');
    let message = '';
    try {
      loadEnvFile(file, {});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('line');
    expect(message).not.toContain('s3cr3t-value');
  });

  it('accepts a multi-line quoted value, export, and comments', async () => {
    const file = path.join(await tmp(), '.env');
    await writeFile(file, '# note\nexport A=1\nB="line one\nline two"\n');
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvFile(file, env).loaded).toEqual(['A', 'B']);
  });
});

describe('env_file in the config', () => {
  it('resolves a relative value against the config folder', () => {
    const cfg = parseConfig(rawConfig({ env_file: './secrets/.env' }), '/proj/conf');
    expect(cfg.env_file).toBe(path.resolve('/proj/conf', 'secrets/.env'));
  });

  it('treats an empty value as not set', () => {
    expect(parseConfig(rawConfig({ env_file: '' }), '/proj/conf').env_file).toBeUndefined();
    expect(parseConfig(rawConfig(), '/proj/conf').env_file).toBeUndefined();
  });
});

describe('bootstrap with an env file', () => {
  async function setup() {
    const dir = await tmp();
    await mkdir(path.join(dir, 'scenarios'));
    const config = parseConfig(rawConfig({ runs_dir: './runs' }), dir);
    return { dir, config };
  }

  it('loads the file before it builds the run manager', async () => {
    const { dir, config } = await setup();
    const file = path.join(dir, 'cli.env');
    await writeFile(file, 'DEMO_SECRET=s3cr3t-value\n');
    const env: NodeJS.ProcessEnv = {};
    const deps = await bootstrap({ config, envFile: file, env, logger: silentLogger });
    expect(env.DEMO_SECRET).toBe('s3cr3t-value');
    // The manager keeps the same env object, so its redactor sees the value.
    expect(deps.manager).toBeInstanceOf(RunManager);
    expect((deps.manager as unknown as { env: unknown }).env).toBe(env);
  });

  it('prefers the CLI flag over the config field and resolves it against the working folder', async () => {
    const { dir, config } = await setup();
    await writeFile(path.join(dir, 'config.env'), 'FROM=config\n');
    await writeFile(path.join(dir, 'cli.env'), 'FROM=cli\n');
    const withField = { ...config, env_file: path.join(dir, 'config.env') };
    const relative = path.relative(process.cwd(), path.join(dir, 'cli.env'));
    const env: NodeJS.ProcessEnv = {};
    await bootstrap({ config: withField, envFile: relative, env, logger: silentLogger });
    expect(env.FROM).toBe('cli');
  });

  it('uses the config field when there is no flag', async () => {
    const { dir, config } = await setup();
    await writeFile(path.join(dir, 'config.env'), 'FROM=config\n');
    const env: NodeJS.ProcessEnv = {};
    await bootstrap({
      config: { ...config, env_file: path.join(dir, 'config.env') },
      env,
      logger: silentLogger,
    });
    expect(env.FROM).toBe('config');
  });

  it('does not log a value or a key name', async () => {
    const { dir, config } = await setup();
    const file = path.join(dir, '.env');
    await writeFile(file, 'DEMO_SECRET=s3cr3t-value\n');
    const lines: string[] = [];
    const logger = {
      ...silentLogger,
      info: (m: string, d?: Record<string, unknown>) => lines.push(JSON.stringify({ m, ...d })),
    };
    await bootstrap({ config, envFile: file, env: {}, logger });
    const all = lines.join('\n');
    expect(all).toContain('env file loaded');
    expect(all).not.toContain('s3cr3t-value');
    expect(all).not.toContain('DEMO_SECRET');
  });
});
