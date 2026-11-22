import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { checkTargetHost, hostOf, matchesAny } from '../safety/hosts.js';
import { type ResolvedConfig, ServerConfig } from '../schemas/config.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const absPath = path.resolve(configPath);
  let text: string;
  try {
    text = await readFile(absPath, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${absPath}: ${(err as Error).message}`);
  }
  return parseConfig(parse(text), path.dirname(absPath));
}

export function parseConfig(raw: unknown, configDir: string): ResolvedConfig {
  const result = ServerConfig.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid config:\n${z.prettifyError(result.error)}`);
  }
  const cfg = result.data;
  const resolve = (p: string) => path.resolve(configDir, p);
  const resolved: ResolvedConfig = {
    ...cfg,
    config_dir: configDir,
    runs_dir: resolve(cfg.runs_dir),
    test_data_dir: resolve(cfg.test_data_dir),
    scenario_dirs: cfg.scenario_dirs.map(resolve),
  };
  validateTargets(resolved);
  return resolved;
}

/** Refuses the whole config when one target looks like production. Fail closed. */
function validateTargets(cfg: ResolvedConfig): void {
  const problems: string[] = [];
  for (const [name, target] of Object.entries(cfg.targets)) {
    const baseHost = hostOf(target.base_url);
    if (!matchesAny(baseHost, target.allowed_hosts)) {
      problems.push(`Target "${name}": base_url host "${baseHost}" is not in allowed_hosts.`);
    }
    if (target.allow_unlabeled_host && cfg.production_hosts.length === 0) {
      problems.push(`Target "${name}": allow_unlabeled_host needs a non-empty production_hosts list.`);
    }
    for (const host of new Set([baseHost, ...target.allowed_hosts])) {
      const check = checkTargetHost(host, target, cfg);
      if (!check.ok && check.reason === 'production') {
        problems.push(`Target "${name}": host "${host}" is in production_hosts.`);
      } else if (!check.ok) {
        problems.push(
          `Target "${name}": host "${host}" does not look like a test environment. Use a host with a label such as "staging" or "test", or set allow_unlabeled_host: true together with production_hosts.`,
        );
      }
    }
    for (const host of target.third_party_hosts) {
      if (matchesAny(host.replace(/^\*\./, ''), cfg.production_hosts)) {
        problems.push(`Target "${name}": third-party host "${host}" is in production_hosts.`);
      }
    }
    for (const [secretName, envName] of Object.entries(target.secrets)) {
      if (!secretName || !envName) problems.push(`Target "${name}": empty secret mapping.`);
    }
    const creds = target.http_credentials;
    if (creds) {
      for (const ref of [creds.username_secret, creds.password_secret]) {
        if (!(ref in target.secrets)) {
          problems.push(`Target "${name}": http_credentials refers to unknown secret "${ref}".`);
        }
      }
    }
  }
  if (problems.length > 0) throw new ConfigError(`Config refused:\n- ${problems.join('\n- ')}`);
}
