#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { bootstrap } from './app.js';
import { parseCli } from './cli/args.js';
import { runDemoStore } from './cli/demo-store.js';
import { installChromium, runInit } from './cli/init.js';
import { packageRoot } from './cli/package-root.js';
import { createLogger } from './logger.js';
import { createServer } from './server.js';
import { VERSION } from './version.js';

const USAGE = `checkout-test-mcp ${VERSION}

Usage:
  checkout-test-mcp [--config <path>] [--env-file <path>]
  checkout-test-mcp init [--dir <folder>] [--skip-browser]
  checkout-test-mcp demo-store [--port <number>]

Commands:
  (none)       Start the MCP server on stdio.
  init         Write a starter config, the demo scenarios, and test data. Install Chromium.
  demo-store   Start the bundled demo store. Default port: 4173.

Options:
  --config <path>    Config file. Default: ./checkout-test-mcp.config.yaml or $CHECKOUT_MCP_CONFIG.
  --env-file <path>  Env file for secrets.
  --dir <folder>     init: target folder. Default: the current folder.
  --skip-browser     init: do not install Chromium.
  --port <number>    demo-store: port. Default: 4173.
  --version          Print the version.
  --help             Print this text.
`;

// Stdout is the MCP channel. Every CLI line goes to stderr.
const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function main(): Promise<void> {
  const cmd = parseCli(process.argv.slice(2));
  switch (cmd.kind) {
    case 'help':
      process.stderr.write(USAGE);
      return;
    case 'version':
      process.stderr.write(`${VERSION}\n`);
      return;
    case 'init': {
      const root = packageRoot();
      process.exitCode = await runInit({
        dir: cmd.dir,
        skipBrowser: cmd.skipBrowser,
        root,
        log,
        installBrowser: () => installChromium(root),
      });
      return;
    }
    case 'demo-store':
      await runDemoStore({ port: cmd.port, root: packageRoot(), log });
      return;
    case 'serve': {
      const logger = createLogger();
      const configPath = cmd.config ?? process.env.CHECKOUT_MCP_CONFIG ?? 'checkout-test-mcp.config.yaml';
      const deps = await bootstrap({ configPath, logger, ...(cmd.envFile ? { envFile: cmd.envFile } : {}) });
      serveStdio(() => createServer(deps), {
        onerror: (err) => logger.error('transport error', { error: err.message }),
      });
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `checkout-test-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
