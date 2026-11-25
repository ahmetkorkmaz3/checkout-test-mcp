import path from 'node:path';
import type { LaunchOptions } from 'playwright';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load-config.js';
import { openGuardedContext } from '../../src/runner/browser.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MISSING = "browserType.launch: Executable doesn't exist at /x/chromium";

/** Records the launch options. A launch error that is not "missing" ends the call at once. */
function recordingLauncher(results: string[]) {
  const calls: LaunchOptions[] = [];
  return {
    calls,
    launch: async (o?: LaunchOptions) => {
      calls.push(o ?? {});
      throw new Error(results[calls.length - 1] ?? 'boom');
    },
  };
}

async function open(browser: 'auto' | 'chromium' | 'chrome', launcher: ReturnType<typeof recordingLauncher>) {
  const config = parseConfig(
    {
      browser,
      headless: true,
      targets: {
        t: { profile: 'demo-store', base_url: 'http://localhost:4173', allowed_hosts: ['localhost'] },
      },
    },
    ROOT,
  );
  const target = config.targets.t;
  if (!target) throw new Error('test config has no target');
  await openGuardedContext({ config, target, onBlocked: () => {}, launcher: launcher as never }).catch(
    () => {},
  );
}

function expectGuard(o: LaunchOptions | undefined) {
  expect(o?.headless).toBe(true);
  expect(o?.proxy?.bypass).toBe('<-loopback>');
  expect(o?.proxy?.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(o?.args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
}

describe('openGuardedContext launch options', () => {
  it('passes the guard options to the Chromium launch', async () => {
    const l = recordingLauncher(['boom']);
    await open('chromium', l);
    expect(l.calls).toHaveLength(1);
    expectGuard(l.calls[0]);
    expect(l.calls[0]?.channel).toBeUndefined();
  });

  it('passes the same guard options to the Chrome fallback launch', async () => {
    const l = recordingLauncher([MISSING, 'boom']);
    await open('auto', l);
    expect(l.calls).toHaveLength(2);
    expectGuard(l.calls[0]);
    expectGuard(l.calls[1]);
    expect(l.calls[1]?.channel).toBe('chrome');
  });
});
