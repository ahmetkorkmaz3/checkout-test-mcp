import { describe, expect, it } from 'vitest';
import { parseCli } from '../../src/cli/args.js';

describe('parseCli', () => {
  it('serves with no arguments', () => {
    expect(parseCli([])).toEqual({ kind: 'serve' });
  });
  it('reads --config and --env-file', () => {
    expect(parseCli(['--config', 'a.yaml', '--env-file', '.env'])).toEqual({
      kind: 'serve',
      config: 'a.yaml',
      envFile: '.env',
    });
  });
  it('treats an unreplaced .mcpb placeholder as not set', () => {
    expect(parseCli(['--env-file', ['$', '{user_config.env_file}'].join('')])).toEqual({ kind: 'serve' });
  });

  it('treats an empty --env-file as not set', () => {
    expect(parseCli(['--env-file', ''])).toEqual({ kind: 'serve' });
  });
  it('parses init', () => {
    expect(parseCli(['init', '--dir', 'x', '--skip-browser'])).toEqual({
      kind: 'init',
      dir: 'x',
      skipBrowser: true,
    });
    expect(parseCli(['init'])).toEqual({ kind: 'init', dir: '.', skipBrowser: false });
  });
  it('parses demo-store', () => {
    expect(parseCli(['demo-store', '--port', '5000'])).toEqual({ kind: 'demo-store', port: 5000 });
    expect(parseCli(['demo-store'])).toEqual({ kind: 'demo-store', port: 4173 });
  });
  it('rejects a bad port', () => {
    expect(() => parseCli(['demo-store', '--port', 'abc'])).toThrow(/--port/);
  });
  it('parses help and version', () => {
    expect(parseCli(['--help'])).toEqual({ kind: 'help' });
    expect(parseCli(['--version'])).toEqual({ kind: 'version' });
  });
  it('names an unknown subcommand in the error', () => {
    expect(() => parseCli(['frobnicate'])).toThrow(/frobnicate/);
  });
});
