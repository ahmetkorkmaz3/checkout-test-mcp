import { parseArgs } from 'node:util';

export type CliCommand =
  | { kind: 'serve'; config?: string; envFile?: string }
  | { kind: 'init'; dir: string; skipBrowser: boolean }
  | { kind: 'demo-store'; port: number }
  | { kind: 'help' }
  | { kind: 'version' };

const DEFAULT_DEMO_PORT = 4173;
const UNREPLACED_PLACEHOLDER = /^\$\{user_config\.[^}]+\}$/;

export function parseCli(argv: string[]): CliCommand {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      'env-file': { type: 'string' },
      dir: { type: 'string' },
      'skip-browser': { type: 'boolean' },
      port: { type: 'string' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  const [sub, ...rest] = positionals;
  if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
  if (sub === undefined) {
    const cmd: CliCommand = { kind: 'serve' };
    if (values.config !== undefined) cmd.config = values.config;
    // The .mcpb host leaves the literal ${user_config.env_file} in the args when the user leaves
    // the field empty. An empty value or an unreplaced placeholder both mean not set.
    const envFile = values['env-file'];
    if (envFile && !UNREPLACED_PLACEHOLDER.test(envFile)) cmd.envFile = envFile;
    return cmd;
  }
  if (sub === 'init') {
    return { kind: 'init', dir: values.dir ?? '.', skipBrowser: values['skip-browser'] === true };
  }
  if (sub === 'demo-store') {
    const raw = values.port;
    const port = raw === undefined ? DEFAULT_DEMO_PORT : Number(raw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Invalid --port value: ${raw}. Use a whole number from 0 to 65535.`);
    }
    return { kind: 'demo-store', port };
  }
  throw new Error(`Unknown command: ${sub}. Use init, demo-store, or no command.`);
}
