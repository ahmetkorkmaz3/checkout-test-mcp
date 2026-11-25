import { type Browser, type BrowserContext, chromium, type Frame, type Route, selectors } from 'playwright';
import { isHostAllowed, isUrlAllowed } from '../safety/hosts.js';
import type { ResolvedConfig, TargetConfig } from '../schemas/config.js';
import type { BrowserInfo } from '../schemas/run.js';
import { startGuardProxy } from './guard-proxy.js';
import { launchBrowser } from './launch.js';

export interface GuardedContextInput {
  config: Pick<ResolvedConfig, 'production_hosts' | 'headless' | 'browser'>;
  target: TargetConfig;
  /** HTTP basic auth. The browser sends it to the origin of `target.base_url` only. */
  httpCredentials?: { username: string; password: string };
  /**
   * Called for each request the guard aborts. The URL can hold a query, so redact it before you store it.
   * `frame` is null when Playwright has no frame for the request, for example a popup navigation, and for
   * each request that the proxy refuses. A proxy URL of an https request has no path.
   */
  onBlocked: (url: string, frame: Frame | null, isNavigation: boolean) => void;
}

export interface GuardedContext {
  browser: Browser;
  info: BrowserInfo;
  context: BrowserContext;
  /** The value of PROXY_ERROR_HEADER on a 502 that the guard proxy sent itself. */
  proxyErrorToken: string;
  close(): Promise<void>;
}

/**
 * Launches Chromium and opens a context with the host guard. The guard has two layers:
 * - The route handler checks the full URL of each request that Playwright routes. Playwright routes only
 *   the first URL of a redirect chain.
 * - A local forward proxy checks the host of every request of the browser, also each redirect follow-up.
 * Runs and inspections use this one function, so they share one guard.
 */
export async function openGuardedContext(input: GuardedContextInput): Promise<GuardedContext> {
  const { config, target } = input;
  const proxy = await startGuardProxy({
    isHostAllowed: (host) => isHostAllowed(host, target, config),
    // The proxy has no frame for a request.
    onBlocked: (url) => input.onBlocked(url, null, false),
  });
  let browser: Browser | undefined;
  try {
    selectors.setTestIdAttribute(target.test_id_attribute);
    const launched = await launchBrowser(
      config.browser,
      {
        headless: config.headless,
        // "<-loopback>" turns off the loopback bypass of Chromium, so the proxy also checks localhost hosts.
        proxy: { server: proxy.server, bypass: '<-loopback>' },
        // WebRTC sends UDP (for example STUN) past an HTTP proxy. This policy allows proxied traffic only.
        args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      },
      chromium,
    );
    browser = launched.browser;
    const context = await browser.newContext({
      baseURL: target.base_url,
      viewport: { width: 1280, height: 900 },
      ...(target.locale ? { locale: target.locale } : {}),
      // The origin keeps the credentials on the target origin. A third-party host never gets them.
      ...(input.httpCredentials
        ? { httpCredentials: { ...input.httpCredentials, origin: new URL(target.base_url).origin } }
        : {}),
    });
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (isUrlAllowed(url, target, config)) {
        // An error here means that the page or the context closed, so the request cannot go on.
        await route.continue().catch(() => {});
        return;
      }
      await blockRequest(route, stripUserInfo(url), input.onBlocked);
    });
    const opened = browser;
    return {
      browser: opened,
      info: launched.info,
      context,
      proxyErrorToken: proxy.errorToken,
      close: async () => {
        await opened.close().catch(() => {});
        await proxy.close();
      },
    };
  } catch (err) {
    await browser?.close().catch(() => {});
    await proxy.close();
    throw err;
  }
}

/** Removes a user name and password from a URL, so a blocked URL never holds credentials. */
export function stripUserInfo(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url.replace(/\/\/[^/?#]*@/, '//');
  }
}

function frameOf(route: Route): Frame | null {
  try {
    return route.request().frame();
  } catch {
    // Playwright throws for a navigation that starts before its frame exists, such as a popup.
    return null;
  }
}

async function blockRequest(
  route: Route,
  url: string,
  notify: GuardedContextInput['onBlocked'],
): Promise<void> {
  // Record first, and abort in finally: an error here must never let a blocked request go on or hang.
  try {
    notify(url, frameOf(route), route.request().isNavigationRequest());
  } finally {
    await route.abort('blockedbyclient').catch(() => {});
  }
}
