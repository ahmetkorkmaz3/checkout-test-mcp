import type { Redactor } from './safety/secrets.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Writes JSON lines to stderr. Stdout belongs to the MCP stdio transport. */
export function createLogger(opts: { level?: Level; redactors?: Redactor[] } = {}): Logger {
  const min = ORDER[opts.level ?? (process.env.CHECKOUT_MCP_LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;
  const write = (level: Level, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    let line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data });
    for (const r of opts.redactors ?? []) line = r.redact(line);
    process.stderr.write(`${line}\n`);
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
