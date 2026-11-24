import { type Browser, type BrowserContext, chromium, type Frame, selectors } from 'playwright';
import { isUrlAllowed } from '../safety/hosts.js';
import type { ResolvedConfig, TargetConfig } from '../schemas/config.js';

export interface GuardedContextInput {
  config: Pick<ResolvedConfig, 'production_hosts' | 'headless'>;
  target: TargetConfig;
  httpCredentials?: { username: string; password: string };
  /**
   * Called for each request the guard aborts. The URL can hold a query, so redact it before you store it.
   * `frame` is null when Playwright has no frame for the request, for example a popup navigation.
   */
  onBlocked: (url: string, frame: Frame | null, isNavigation: boolean) => void;
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
      // Record first, and abort in finally: an error here must never let a blocked request go on or hang.
      try {
        let frame: Frame | null = null;
        try {
          frame = req.frame();
        } catch {
          // Playwright throws for a navigation that starts before its frame exists, such as a popup.
          frame = null;
        }
        input.onBlocked(url, frame, req.isNavigationRequest());
      } finally {
        await route.abort('blockedbyclient');
      }
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
