import { type Browser, type BrowserContext, chromium, selectors } from 'playwright';
import { isUrlAllowed } from '../safety/hosts.js';
import type { ResolvedConfig, TargetConfig } from '../schemas/config.js';

export interface GuardedContextInput {
  config: Pick<ResolvedConfig, 'production_hosts' | 'headless'>;
  target: TargetConfig;
  httpCredentials?: { username: string; password: string };
  /** Called for each request the guard aborts. The URL can hold a query, so redact it before you store it. */
  onBlocked: (url: string, isMainFrameNavigation: boolean) => void;
}

export interface GuardedContext {
  browser: Browser;
  context: BrowserContext;
  close(): Promise<void>;
}

/**
 * Launches Chromium and opens a context with the host guard on every request.
 * Runs and inspections use this one function, so they share one guard.
 */
export async function openGuardedContext(input: GuardedContextInput): Promise<GuardedContext> {
  const { config, target } = input;
  selectors.setTestIdAttribute(target.test_id_attribute);
  const browser = await chromium.launch({ headless: config.headless });
  try {
    const context = await browser.newContext({
      baseURL: target.base_url,
      viewport: { width: 1280, height: 900 },
      ...(target.locale ? { locale: target.locale } : {}),
      ...(input.httpCredentials ? { httpCredentials: input.httpCredentials } : {}),
    });
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      if (isUrlAllowed(url, target, config)) return route.continue();
      // A navigation request always has a frame. Only the top frame of a page has no parent.
      const mainFrameNavigation = req.isNavigationRequest() && req.frame().parentFrame() === null;
      input.onBlocked(url, mainFrameNavigation);
      return route.abort('blockedbyclient');
    });
    return {
      browser,
      context,
      close: () => browser.close().catch(() => {}),
    };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}
