import { type Browser, type BrowserContext, chromium, type Frame, type Route, selectors } from 'playwright';
import { isUrlAllowed, matchesAny } from '../safety/hosts.js';
import type { ResolvedConfig, TargetConfig } from '../schemas/config.js';

export interface GuardedContextInput {
  config: Pick<ResolvedConfig, 'production_hosts' | 'headless'>;
  target: TargetConfig;
  /**
   * HTTP basic auth for the hosts in `target.allowed_hosts` only. The guard adds the header itself, so the
   * credentials never go to a third-party host, also when that host asks for them.
   */
  httpCredentials?: { username: string; password: string };
  /**
   * Called for each request the guard aborts. The URL can hold a query, so redact it before you store it.
   * `frame` is null when Playwright has no frame for the request, for example a popup navigation.
   */
  onBlocked: (url: string, frame: Frame | null, isNavigation: boolean) => void;
}

export type BlockedListener = (url: string, frame: Frame | null, isNavigation: boolean) => void;

/**
 * Passive content. The guard checks the first URL only, so such an asset can still follow a redirect
 * to another host. No document or executable content can.
 */
const PASSIVE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);
/** A long-lived stream. The guard fetch reads the full body, so it would hold a stream until its timeout. */
const STREAM_TYPES = new Set(['eventsource']);

const blockedListeners = new WeakMap<BrowserContext, Set<BlockedListener>>();

/**
 * Adds a listener for the requests that the guard of this context blocks. It gets the same data as `onBlocked`.
 * Returns a function that removes the listener. A context that the guard did not open has no listeners.
 */
export function addBlockedListener(context: BrowserContext, listener: BlockedListener): () => void {
  const set = blockedListeners.get(context);
  set?.add(listener);
  return () => {
    set?.delete(listener);
  };
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
  const listeners = new Set<BlockedListener>();
  const notify: BlockedListener = (url, frame, isNavigation) => {
    input.onBlocked(url, frame, isNavigation);
    for (const listener of [...listeners]) listener(url, frame, isNavigation);
  };
  selectors.setTestIdAttribute(target.test_id_attribute);
  const browser = await chromium.launch({ headless: config.headless });
  try {
    const context = await browser.newContext({
      baseURL: target.base_url,
      viewport: { width: 1280, height: 900 },
      ...(target.locale ? { locale: target.locale } : {}),
    });
    // Not the httpCredentials option of the context: Chromium and route.fetch then answer a basic auth
    // challenge from any host, also from a third-party host.
    const authorization = input.httpCredentials ? basicAuthHeader(input.httpCredentials) : null;
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      if (!isUrlAllowed(url, target, config)) return blockRequest(route, url, notify);
      const headers = authorization
        ? withAuthorization(req.headers(), url, target, authorization)
        : undefined;
      const type = req.resourceType();
      if (PASSIVE_TYPES.has(type) || STREAM_TYPES.has(type)) {
        return route.continue(headers ? { headers } : undefined);
      }
      await fetchWithRedirectCheck(route, headers, (next) => isUrlAllowed(next, target, config), notify);
    });
    blockedListeners.set(context, listeners);
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

function basicAuthHeader(creds: { username: string; password: string }): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
}

/**
 * The request headers with the basic auth header, for a host in `allowed_hosts` only. Returns undefined
 * for any other host, and when the page set its own Authorization header, such as a bearer token.
 */
function withAuthorization(
  headers: Record<string, string>,
  url: string,
  target: TargetConfig,
  authorization: string,
): Record<string, string> | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (!matchesAny(host, target.allowed_hosts)) return undefined;
  if (Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) return undefined;
  return { ...headers, authorization };
}

function frameOf(route: Route): Frame | null {
  try {
    return route.request().frame();
  } catch {
    // Playwright throws for a navigation that starts before its frame exists, such as a popup.
    return null;
  }
}

async function blockRequest(route: Route, url: string, notify: BlockedListener): Promise<void> {
  // Record first, and abort in finally: an error here must never let a blocked request go on or hang.
  try {
    notify(url, frameOf(route), route.request().isNavigationRequest());
  } finally {
    await route.abort('blockedbyclient').catch(() => {});
  }
}

/**
 * Playwright routes only the first URL of a redirect chain. So the guard sends the request itself,
 * without redirects, and checks the Location of a redirect before the browser can follow it.
 * An allowed redirect goes back to the browser, which sends the next request through this route again.
 */
async function fetchWithRedirectCheck(
  route: Route,
  headers: Record<string, string> | undefined,
  isAllowed: (url: string) => boolean,
  notify: BlockedListener,
): Promise<void> {
  let response: Awaited<ReturnType<Route['fetch']>>;
  try {
    response = await route.fetch({ maxRedirects: 0, ...(headers ? { headers } : {}) });
  } catch (err) {
    // Fail closed: a request that the guard could not send never goes to the browser network stack.
    await route.abort(abortCodeFor(err)).catch(() => {});
    return;
  }
  const status = response.status();
  const location = response.headers().location;
  if (status >= 300 && status < 400 && location !== undefined) {
    let next = location;
    try {
      next = new URL(location, route.request().url()).href;
    } catch {
      // An invalid Location is not on an allowed host, so the guard blocks it.
    }
    if (!isAllowed(next)) {
      await response.dispose().catch(() => {});
      return blockRequest(route, next, notify);
    }
  }
  await route.fulfill({ response }).catch(() => {});
}

/**
 * The net error that the browser shows for a failed guard fetch. The runner reads these errors to
 * tell an unreachable target from a page error, so they match what the browser shows without the guard.
 */
function abortCodeFor(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'namenotresolved';
  if (/ECONNREFUSED/.test(msg)) return 'connectionrefused';
  if (/ECONNRESET/.test(msg)) return 'connectionreset';
  if (/EHOSTUNREACH|ENETUNREACH/.test(msg)) return 'addressunreachable';
  if (/ETIMEDOUT|[Tt]imeout|timed out/.test(msg)) return 'timedout';
  return 'failed';
}
