import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface DemoStoreModule {
  startDemoStore(opts: { port: number; bugs?: string[] }): Promise<{ url: string; close(): Promise<void> }>;
}

export async function runDemoStore(opts: {
  port: number;
  root: string;
  log: (line: string) => void;
}): Promise<void> {
  const file = path.join(opts.root, 'examples', 'demo-store', 'server.mjs');
  const mod = (await import(pathToFileURL(file).href)) as DemoStoreModule;
  // Same as "npm run demo-store": fault injection comes from this variable.
  const bugs = (process.env.DEMO_STORE_BUGS ?? '').split(',').filter(Boolean);
  const store = await mod.startDemoStore({ port: opts.port, bugs });
  opts.log(`Demo store: ${store.url}${bugs.length ? ` (bugs: ${bugs.join(', ')})` : ''}`);
  opts.log('Press Ctrl+C to stop.');
  await new Promise<void>((resolve) => {
    const stop = () => {
      store.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
