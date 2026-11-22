#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { bootstrap } from './app.js';
import { createLogger } from './logger.js';
import { createServer } from './server.js';
import { VERSION } from './version.js';

const USAGE = `checkout-test-mcp ${VERSION}

Usage: checkout-test-mcp [--config <path>]

Options:
  --config <path>  Config file. Default: ./checkout-test-mcp.config.yaml or $CHECKOUT_MCP_CONFIG.
  --version        Print the version.
  --help           Print this text.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  // Stdout is the MCP channel. Help and version go to stderr.
  if (values.help) {
    process.stderr.write(USAGE);
    return;
  }
  if (values.version) {
    process.stderr.write(`${VERSION}\n`);
    return;
  }
  const logger = createLogger();
  const configPath = values.config ?? process.env.CHECKOUT_MCP_CONFIG ?? 'checkout-test-mcp.config.yaml';
  const deps = await bootstrap({ configPath, logger });
  serveStdio(() => createServer(deps), {
    onerror: (err) => logger.error('transport error', { error: err.message }),
  });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `checkout-test-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
