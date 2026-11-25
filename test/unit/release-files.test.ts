import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface UserConfigField {
  type: string;
  required?: boolean;
}

interface JsonFile {
  version: string;
  name: string;
  mcpName: string;
  license: string;
  user_config: { config_path: UserConfigField; env_file: UserConfigField };
  server: { mcp_config: { command: string; args: string[] } };
  packages: [{ registryType: string; identifier: string; version: string; transport: { type: string } }];
}

// One loose shape for all three files keeps the test short. Each test reads only its own fields.
function readJson(path: string): JsonFile {
  return JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')) as JsonFile;
}

// Built in parts so the lint rule for placeholders in plain strings stays quiet.
const ph = (name: string): string => ['$', '{', name, '}'].join('');

const pkg = readJson('package.json');
const manifest = readJson('manifest.json');
const registry = readJson('server.json');

describe('release files', () => {
  it('keeps one version in package.json, manifest.json, and server.json', () => {
    expect(manifest.version).toBe(pkg.version);
    expect(registry.version).toBe(pkg.version);
    expect(registry.packages[0].version).toBe(pkg.version);
  });

  it('declares the MIT license in the manifest', () => {
    expect(manifest.license).toBe('MIT');
  });

  it('asks for the config file and makes the env file optional', () => {
    const { config_path, env_file } = manifest.user_config;
    expect(config_path.type).toBe('file');
    expect(config_path.required).toBe(true);
    expect(env_file.type).toBe('file');
    expect(env_file.required).not.toBe(true);
  });

  it('sets no default for a user path', () => {
    const { config_path, env_file } = manifest.user_config;
    expect(config_path).not.toHaveProperty('default');
    expect(env_file).not.toHaveProperty('default');
  });

  it('starts dist/index.js with both user paths', () => {
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.mcp_config.args).toEqual([
      `${ph('__dirname')}/dist/index.js`,
      '--config',
      ph('user_config.config_path'),
      '--env-file',
      ph('user_config.env_file'),
    ]);
  });

  it('names the npm package and the mcpName in server.json', () => {
    expect(registry.name).toBe(pkg.mcpName);
    const [npm] = registry.packages;
    expect(npm.registryType).toBe('npm');
    expect(npm.identifier).toBe('checkout-test-mcp');
    expect(npm.transport.type).toBe('stdio');
  });
});
