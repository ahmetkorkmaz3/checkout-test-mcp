import type { BrowserContext, Locator, Page } from 'playwright';
import { parse as parseYaml } from 'yaml';
import { hostOf, isUrlAllowed, matchesAny } from '../safety/hosts.js';
import { redactText } from '../safety/redact-text.js';
import type { InspectConfig, ResolvedConfig, TargetConfig } from '../schemas/config.js';
import { guessPageKind, type PageKind } from './page-kind.js';
import { matchesKind } from './words.js';

export interface PageSnapshot {
  path_pattern: string;
  url_path: string;
  kind: PageKind;
  kind_reasons: string[];
  title: string;
  headings: string[];
  landmarks: string[];
  elements: { role: string; name: string; label?: string; test_id?: string; visible: boolean }[];
  forms: { fields: { label: string; type: string; autocomplete?: string; required: boolean }[] }[];
  selects: { label: string; options: string[] }[];
  iframes: { host: string; title?: string }[];
  dialogs: string[];
}

export interface ApiCall {
  method: string;
  path_pattern: string;
  status: number;
  content_type: string;
  page_kind: PageKind;
}

export interface SiteReport {
  pages: PageSnapshot[];
  api_calls: ApiCall[];
  blocked_hosts: { host: string; count: number }[];
}

export interface CrawlContext {
  context: BrowserContext;
  target: TargetConfig;
  inspect: InspectConfig;
  config: Pick<ResolvedConfig, 'production_hosts'>;
  /** The counter whose onBlocked went to openGuardedContext. */
  blocked: BlockedHostCounter;
  signal: AbortSignal;
  onProgress(msg: string): void;
}

/** Caps per page. They keep the report small on large shops. */
export const CRAWL_LIMITS = {
  elements: 200,
  options: 50,
  selects: 50,
  fields: 200,
  headings: 50,
  links: 500,
  iframes: 50,
  dialogs: 20,
  cookieButtons: 50,
} as const;

const NAV_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 2_000;

/** Counts the hosts that the browser guard blocked. Pass `onBlocked` to openGuardedContext. */
export class BlockedHostCounter {
  private readonly counts = new Map<string, number>();

  readonly onBlocked = (url: string): void => {
    let host: string;
    try {
      host = hostOf(url) || new URL(url).protocol;
    } catch {
      host = '(invalid url)';
    }
    this.counts.set(host, (this.counts.get(host) ?? 0) + 1);
  };

  list(): { host: string; count: number }[] {
    return [...this.counts]
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
  }
}

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
// A slug with a long number at its end, such as "merci-kalem-p-123456", is an id too.
const NUMBERED_SLUG = /-\d{4,}$/;
// The segment after one of these words is a product or category slug. One example of each is enough.
const COLLECTION_WORDS = new Set([
  'p',
  'c',
  'item',
  'items',
  'artikel',
  'product',
  'products',
  'produkt',
  'produkte',
  'produit',
  'produits',
  'producto',
  'productos',
  'prodotto',
  'prodotti',
  'producten',
  'urun',
  'urunler',
  'collection',
  'collections',
  'category',
  'categories',
  'kategori',
  'kategorie',
  'categorie',
]);

/**
 * Turns a URL path into a pattern: ids and slugs become "*". The query is not part of it.
 * "/api/products/ceramic-mug" and "/products/ceramic-mug" both keep only the static parts.
 */
export function pathPattern(pathname: string): string {
  const segments = (pathname.split(/[?#]/)[0] ?? '').split('/');
  return segments
    .map((seg, i) => {
      if (seg === '') return seg;
      if (ID_SEGMENT.test(seg) || NUMBERED_SLUG.test(seg)) return '*';
      const prev = segments[i - 1]?.toLowerCase();
      if (prev !== undefined && COLLECTION_WORDS.has(prev) && !COLLECTION_WORDS.has(seg.toLowerCase()))
        return '*';
      return seg;
    })
    .join('/');
}

const SKIP_LINK =
  /(^|\/)(logout|log-out|signout|sign-out|sign_out|cikis|cikis-yap|abmelden|deconnexion|uitloggen)(\/|$)/i;

const ELEMENT_ROLES = [
  'button',
  'textbox',
  'searchbox',
  'spinbutton',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'tab',
  'menuitem',
  'link',
] as const;

const LANDMARK_ROLES = [
  'banner',
  'navigation',
  'main',
  'contentinfo',
  'complementary',
  'search',
  'region',
] as const;

const clean = (s: string | null | undefined): string => redactText((s ?? '').replace(/\s+/g, ' ').trim());

function firstLine(msg: string): string {
  return (msg.split('\n')[0] ?? msg).slice(0, 300);
}

/** Reads the accessible name from the element's ARIA snapshot, for example `- button "Add to cart"`. */
async function accessibleName(loc: Locator): Promise<string> {
  const snap = await loc.ariaSnapshot({ timeout: READ_TIMEOUT_MS }).catch(() => '');
  let first: unknown;
  try {
    const parsed: unknown = parseYaml(snap);
    first = Array.isArray(parsed) ? parsed[0] : undefined;
  } catch {
    return '';
  }
  const key =
    typeof first === 'string' ? first : first && typeof first === 'object' ? Object.keys(first)[0] : '';
  const m = /^[\w-]+\s+"((?:[^"\\]|\\.)*)"/.exec(key ?? '');
  if (!m?.[1]) return '';
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

async function namesOf(page: Page, role: Parameters<Page['getByRole']>[0], cap: number): Promise<string[]> {
  const out: string[] = [];
  for (const loc of (await page.getByRole(role).all()).slice(0, cap))
    out.push(clean(await accessibleName(loc)));
  return out;
}

/** Clicks one visible cookie button that rejects. It never clicks a button that accepts. */
async function rejectCookieBanner(page: Page, words: InspectConfig['words']): Promise<boolean> {
  const buttons = (await page.getByRole('button').all()).slice(0, CRAWL_LIMITS.cookieButtons);
  for (const b of buttons) {
    const name = await accessibleName(b);
    if (!matchesKind('cookie_reject', name, words) || matchesKind('cookie_accept', name, words)) continue;
    if (!(await b.isVisible().catch(() => false))) continue;
    try {
      await b.click({ timeout: READ_TIMEOUT_MS });
      await page.waitForTimeout(300);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

interface RawField {
  form: number;
  label: string;
  type: string;
  autocomplete: string;
  required: boolean;
  options: string[] | null;
}

/** Reads form controls by their properties. Password fields have no ARIA role, so role queries miss them. */
async function readFields(page: Page): Promise<RawField[]> {
  return page.locator('input, select, textarea').evaluateAll(
    (els, maxOptions) =>
      els.map((el) => {
        const e = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        // No named helper here: tsx adds a __name() call to it, and the page has no __name.
        const labelledBy = (e.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        const label =
          e.labels?.[0]?.textContent ||
          e.getAttribute('aria-label') ||
          labelledBy ||
          e.getAttribute('placeholder') ||
          e.getAttribute('name') ||
          '';
        const form = e.form ? Array.prototype.indexOf.call(document.forms, e.form) : -1;
        const type = e instanceof HTMLInputElement ? e.type : e.tagName.toLowerCase();
        const options =
          e instanceof HTMLSelectElement
            ? Array.from(e.options)
                .slice(0, maxOptions)
                .map((o) => o.textContent ?? '')
            : null;
        return {
          form,
          label,
          type,
          autocomplete: e.getAttribute('autocomplete') ?? '',
          required: e.required,
          options,
        };
      }),
    CRAWL_LIMITS.options,
  );
}

const NON_FIELD_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

async function hasCardFields(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const n = await frame
      .locator('[autocomplete*="cc-number" i], [autocomplete*="cc-csc" i]')
      .count()
      .catch(() => 0);
    if (n > 0) return true;
  }
  return false;
}

async function snapshotPage(
  page: Page,
  testIdAttribute: string,
  urlPath: string,
  openedDialogs: string[],
): Promise<PageSnapshot> {
  const title = clean(await page.title());
  const headings = await namesOf(page, 'heading', CRAWL_LIMITS.headings);

  const landmarks: string[] = [];
  for (const role of LANDMARK_ROLES) {
    for (const loc of await page.getByRole(role).all()) {
      const name = clean(await accessibleName(loc));
      landmarks.push(name ? `${role}: ${name}` : role);
    }
  }

  const elements: PageSnapshot['elements'] = [];
  for (const role of ELEMENT_ROLES) {
    if (elements.length >= CRAWL_LIMITS.elements) break;
    const locs = (await page.getByRole(role).all()).slice(0, CRAWL_LIMITS.elements - elements.length);
    for (const loc of locs) {
      const [name, attrs, visible] = await Promise.all([
        accessibleName(loc),
        loc
          .evaluate(
            (e, attr) => ({
              label: (e as HTMLInputElement).labels?.[0]?.textContent ?? null,
              testId: e.getAttribute(attr),
            }),
            testIdAttribute,
            { timeout: READ_TIMEOUT_MS },
          )
          .catch(() => ({ label: null, testId: null })),
        loc.isVisible().catch(() => false),
      ]);
      const label = clean(attrs.label);
      const testId = clean(attrs.testId);
      elements.push({
        role,
        name: clean(name),
        ...(label ? { label } : {}),
        ...(testId ? { test_id: testId } : {}),
        visible,
      });
    }
  }

  const raw = (await readFields(page)).slice(0, CRAWL_LIMITS.fields);
  const formsByIndex = new Map<number, PageSnapshot['forms'][number]>();
  const selects: PageSnapshot['selects'] = [];
  for (const f of raw) {
    if (f.options && selects.length < CRAWL_LIMITS.selects) {
      selects.push({ label: clean(f.label), options: f.options.map((o) => clean(o)) });
    }
    if (NON_FIELD_TYPES.has(f.type)) continue;
    let form = formsByIndex.get(f.form);
    if (!form) {
      form = { fields: [] };
      formsByIndex.set(f.form, form);
    }
    form.fields.push({
      label: clean(f.label),
      type: f.type,
      ...(f.autocomplete ? { autocomplete: clean(f.autocomplete) } : {}),
      required: f.required,
    });
  }
  // Real forms first, in page order. Fields outside a <form> come last as one group.
  const forms = [...formsByIndex].sort(([a], [b]) => (a < 0 ? 1 : b < 0 ? -1 : a - b)).map(([, f]) => f);

  const iframes: PageSnapshot['iframes'] = [];
  for (const frame of page.frames().slice(1, CRAWL_LIMITS.iframes + 1)) {
    let host: string;
    try {
      const u = new URL(frame.url());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      host = hostOf(u.href);
    } catch {
      continue;
    }
    const frameTitle = clean(
      await frame
        .frameElement()
        .then((el) => el.getAttribute('title'))
        .catch(() => null),
    );
    iframes.push({ host, ...(frameTitle ? { title: frameTitle } : {}) });
  }

  const dialogs = [
    ...openedDialogs,
    ...(await namesOf(page, 'dialog', CRAWL_LIMITS.dialogs)).map((n) => `dialog: ${n}`),
    ...(await namesOf(page, 'alertdialog', CRAWL_LIMITS.dialogs)).map((n) => `alertdialog: ${n}`),
  ].slice(0, CRAWL_LIMITS.dialogs);

  const hasPasswordField = raw.some((f) => f.type === 'password');
  const guess = guessPageKind({
    path: urlPath,
    title,
    headings,
    buttons: elements.filter((e) => e.role === 'button').map((e) => e.name),
    hasPasswordField,
    hasCardFields: await hasCardFields(page),
  });

  return {
    path_pattern: clean(pathPattern(urlPath)),
    url_path: clean(urlPath),
    kind: guess.kind,
    kind_reasons: guess.reasons,
    title,
    headings,
    landmarks,
    elements,
    forms,
    selects,
    iframes,
    dialogs,
  };
}

/**
 * Reads the site breadth first, one page for each path pattern, up to `max_pages`.
 * It never fills, submits, or presses keys. The only click is a cookie button that rejects.
 * When the signal aborts, it returns the pages it has.
 */
export async function crawlSite(ctx: CrawlContext): Promise<SiteReport> {
  const { target, inspect, config } = ctx;
  const base = new URL(target.base_url);
  const queue: URL[] = [];
  const queued = new Set<string>();
  const read = new Set<string>();

  // Paths come from the config or from same-host links. Every URL starts from base_url and passes the guard.
  const enqueue = (path: string): void => {
    if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return;
    let url: URL;
    try {
      url = new URL(path, target.base_url);
    } catch {
      return;
    }
    url.hash = '';
    if (url.host !== base.host || !isUrlAllowed(url.href, target, config)) return;
    const pattern = pathPattern(url.pathname);
    if (queued.has(pattern)) return;
    queued.add(pattern);
    queue.push(url);
  };
  for (const p of [...inspect.start_paths, ...inspect.product_paths]) enqueue(p);

  const pages: PageSnapshot[] = [];
  const rawCalls: (Omit<ApiCall, 'page_kind'> & { visit: number })[] = [];
  const kindByVisit = new Map<number, PageKind>();
  let visit = -1;
  let openedDialogs: string[] = [];
  let cookieBannerClosed = false;

  const page = await ctx.context.newPage();
  page.on('dialog', (d) => {
    if (openedDialogs.length < CRAWL_LIMITS.dialogs) openedDialogs.push(clean(`${d.type()}: ${d.message()}`));
    d.dismiss().catch(() => {});
  });
  page.on('response', (res) => {
    const req = res.request();
    const type = req.resourceType();
    if (type !== 'fetch' && type !== 'xhr') return;
    let url: URL;
    try {
      url = new URL(res.url());
    } catch {
      return;
    }
    if (!matchesAny(url.hostname, target.allowed_hosts)) return;
    rawCalls.push({
      method: req.method(),
      path_pattern: clean(pathPattern(url.pathname)),
      status: res.status(),
      content_type: clean((res.headers()['content-type'] ?? '').split(';')[0]),
      visit,
    });
  });

  try {
    while (queue.length > 0 && pages.length < inspect.max_pages) {
      if (ctx.signal.aborted) {
        ctx.onProgress('The crawl stopped because the job was cancelled.');
        break;
      }
      const url = queue.shift() as URL;
      const wanted = pathPattern(url.pathname);
      visit++;
      openedDialogs = [];
      try {
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
      } catch (err) {
        ctx.onProgress(
          clean(`Could not open ${wanted}: ${firstLine(err instanceof Error ? err.message : String(err))}`),
        );
        continue;
      }

      const landed = new URL(page.url());
      const landedPattern = pathPattern(landed.pathname);
      // A redirect can land on a pattern that the crawl read before.
      if (read.has(landedPattern)) continue;

      if (!cookieBannerClosed) cookieBannerClosed = await rejectCookieBanner(page, inspect.words);

      let snap: PageSnapshot;
      try {
        snap = await snapshotPage(page, target.test_id_attribute, landed.pathname, openedDialogs);
      } catch (err) {
        ctx.onProgress(
          clean(
            `Could not read ${landedPattern}: ${firstLine(err instanceof Error ? err.message : String(err))}`,
          ),
        );
        continue;
      }
      read.add(landedPattern);
      read.add(wanted);
      pages.push(snap);
      kindByVisit.set(visit, snap.kind);
      ctx.onProgress(
        `Read page ${pages.length} of at most ${inspect.max_pages}: ${snap.path_pattern} (${snap.kind}).`,
      );

      const hrefs = await page
        .getByRole('link')
        .evaluateAll(
          (els, max) => els.slice(0, max).map((e) => (e as HTMLAnchorElement).href),
          CRAWL_LIMITS.links,
        )
        .catch(() => [] as string[]);
      for (const href of hrefs) {
        let link: URL;
        try {
          link = new URL(href);
        } catch {
          continue;
        }
        if (link.host !== base.host || SKIP_LINK.test(link.pathname)) continue;
        enqueue(link.pathname);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  const seen = new Set<string>();
  const api_calls: ApiCall[] = [];
  for (const { visit: v, ...call } of rawCalls) {
    const c: ApiCall = { ...call, page_kind: kindByVisit.get(v) ?? 'other' };
    const key = `${c.method} ${c.path_pattern} ${c.status} ${c.page_kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    api_calls.push(c);
  }

  return { pages, api_calls, blocked_hosts: ctx.blocked.list() };
}
