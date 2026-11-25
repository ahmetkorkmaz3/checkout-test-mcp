import path from 'node:path';
import { loadEnvFile } from './config/env-file.js';
import { loadConfig } from './config/load-config.js';
import { InspectionManager } from './inspect/manager.js';
import { createLogger, type Logger } from './logger.js';
import { BrowserSlots } from './runs/browser-slots.js';
import { RunManager } from './runs/manager.js';
import { RunStore } from './runs/store.js';
import { ScenarioRegistry } from './scenarios/registry.js';
import type { ResolvedConfig } from './schemas/config.js';
import type { ServerDeps } from './server.js';

/** Loads config, scenarios, and run state. Shared by all transports. */
export async function bootstrap(opts: {
  configPath?: string;
  config?: ResolvedConfig;
  logger?: Logger;
  /** CLI env file. Wins over config.env_file. A relative path is relative to the working folder. */
  envFile?: string;
  /** Where secrets are read and where the env file is loaded. Default: process.env. */
  env?: NodeJS.ProcessEnv;
}): Promise<ServerDeps> {
  const logger = opts.logger ?? createLogger();
  const config = opts.config ?? (await loadConfig(opts.configPath ?? 'checkout-test-mcp.config.yaml'));
  const env = opts.env ?? process.env;
  // Before the managers: they read secrets from env, and the redactor registers them from there.
  const envFile = opts.envFile ? path.resolve(opts.envFile) : config.env_file;
  if (envFile) {
    const { loaded } = loadEnvFile(envFile, env);
    logger.info('env file loaded', { path: envFile, count: loaded.length });
  }
  const registry = await ScenarioRegistry.load(config.scenario_dirs);
  const store = new RunStore(config.runs_dir);
  const interrupted = await store.init();
  // Runs and inspections share the browser slots, so the server never opens more than max_parallel_runs browsers.
  const slots = new BrowserSlots(config.max_parallel_runs);
  const manager = new RunManager({ config, registry, store, logger, slots, env });
  await manager.recover(interrupted);
  const inspections = new InspectionManager({ config, logger, slots, env });
  await inspections.init();
  logger.info('ready', {
    targets: Object.keys(config.targets),
    scenarios: registry.ids(),
    runs_dir: config.runs_dir,
    recovered_runs: interrupted.length,
  });
  return { config, registry, manager, inspections, logger };
}
