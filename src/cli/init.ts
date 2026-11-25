import { spawn } from 'node:child_process';
import { cp, lstat, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const CONFIG_NAME = 'checkout-test-mcp.config.yaml';

export async function runInit(opts: {
  dir: string;
  skipBrowser: boolean;
  root: string;
  log: (line: string) => void;
  installBrowser: () => Promise<void>;
}): Promise<number> {
  const { log, root } = opts;
  const dir = path.resolve(opts.dir);
  const configPath = path.join(dir, CONFIG_NAME);
  const scenariosDir = path.join(dir, 'scenarios');
  const testDataDir = path.join(dir, 'test-data');

  // Check every destination before the first write, so a refusal leaves no partial setup.
  const taken: string[] = [];
  for (const target of [configPath, scenariosDir, testDataDir]) {
    if (await exists(target)) taken.push(path.relative(dir, target) || target);
  }
  if (taken.length > 0) {
    log(`Cannot set up ${dir}. These paths exist already: ${taken.join(', ')}.`);
    log('Use an empty folder, or pass --dir with a new folder. Init does not overwrite files.');
    return 1;
  }

  await mkdir(dir, { recursive: true });
  const copy = { recursive: true, errorOnExist: true, force: false } as const;
  await cp(path.join(root, 'checkout-test-mcp.config.example.yaml'), configPath, copy);
  await cp(path.join(root, 'scenarios', 'demo-store'), path.join(scenariosDir, 'demo-store'), copy);
  await cp(path.join(root, 'test-data'), testDataDir, copy);
  log(`Wrote ${CONFIG_NAME}, scenarios/demo-store, and test-data in ${dir}.`);

  if (!opts.skipBrowser) {
    log('Installing the Chromium browser for Playwright. This can take a minute.');
    try {
      await opts.installBrowser();
      log('Chromium is installed.');
    } catch (err) {
      log(`Chromium install failed: ${err instanceof Error ? err.message : String(err)}`);
      log(
        'Google Chrome on this machine also works. Install Chromium later with: npx playwright install chromium',
      );
    }
  }

  log('');
  log(`Server command: npx -y checkout-test-mcp --config ${configPath}`);
  log('Add this server to your MCP client config:');
  log(
    JSON.stringify(
      {
        mcpServers: {
          'checkout-test': {
            command: 'npx',
            args: ['-y', 'checkout-test-mcp', '--config', configPath],
          },
        },
      },
      null,
      2,
    ),
  );
  log('');
  log('To try the bundled demo store, start it in another terminal:');
  log('  npx checkout-test-mcp demo-store');
  return 0;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

// Runs the Playwright CLI of this package. Its stdout goes to stderr, because our stdout is the MCP channel.
export function installChromium(root: string): Promise<void> {
  const require = createRequire(path.join(root, 'package.json'));
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.pipe(process.stderr);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit code ${code}`))));
  });
}
