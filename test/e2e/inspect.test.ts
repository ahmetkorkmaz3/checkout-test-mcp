import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS example without types
import { startDemoStore } from '../../examples/demo-store/server.mjs';
import { parseConfig } from '../../src/config/load-config.js';
import { BlockedHostCounter, crawlSite, type SiteReport } from '../../src/inspect/crawl.js';
import { openGuardedContext } from '../../src/runner/browser.js';
import type { InspectConfig } from '../../src/schemas/config.js';

let demo: {
  url: string;
  close(): Promise<void>;
  stats: { orders: number; payments: number; return_rejects: number };
  issuedOtps: string[];
};

beforeAll(async () => {
  demo = await startDemoStore({ port: 0 });
});

afterAll(async () => {
  await demo?.close();
});

function demoTarget(inspect: Partial<InspectConfig> = {}) {
  const config = parseConfig(
    {
      targets: {
        'demo-local': {
          profile: 'demo-store',
          base_url: demo.url,
          allowed_hosts: ['localhost'],
          inspect: { start_paths: ['/'], ...inspect },
        },
      },
    },
    '/tmp',
  );
  const target = config.targets['demo-local'];
  if (!target?.inspect) throw new Error('test config has no inspect block');
  return { config, target, inspect: target.inspect };
}

async function crawl(
  t: ReturnType<typeof demoTarget>,
  signal = new AbortController().signal,
  messages: string[] = [],
): Promise<SiteReport> {
  const blocked = new BlockedHostCounter();
  const guarded = await openGuardedContext({
    config: t.config,
    target: t.target,
    onBlocked: blocked.onBlocked,
  });
  try {
    return await crawlSite({
      context: guarded.context,
      target: t.target,
      inspect: t.inspect,
      config: t.config,
      blocked,
      signal,
      onProgress: (m) => messages.push(m),
    });
  } finally {
    await guarded.close();
  }
}

describe('site crawl', () => {
  it('crawls the demo store and finds the product page and its API call', async () => {
    const { pages, api_calls, blocked_hosts } = await crawl(demoTarget({ max_pages: 10 }));
    expect(blocked_hosts).toEqual([]);
    expect(pages.map((p) => p.kind)).toEqual(expect.arrayContaining(['product']));
    expect(pages.find((p) => p.kind === 'product')?.elements).toContainEqual(
      expect.objectContaining({ role: 'button', name: 'Add to cart' }),
    );
    expect(api_calls).toContainEqual(
      expect.objectContaining({ method: 'GET', path_pattern: '/api/products/*' }),
    );
    expect(demo.stats.orders).toBe(0);
  });

  it('follows links breadth first, reads forms and selects, and never clicks', async () => {
    const before = demo.issuedOtps.length;
    const { pages } = await crawl(demoTarget({ max_pages: 10 }));
    const paths = pages.map((p) => p.path_pattern);
    expect(paths).toEqual(expect.arrayContaining(['/', '/products', '/checkout', '/account/verify-phone']));
    expect(new Set(paths).size).toBe(paths.length);
    expect(pages.find((p) => p.path_pattern === '/products')?.kind).toBe('listing');
    const verify = pages.find((p) => p.path_pattern === '/account/verify-phone');
    expect(verify?.headings).toContain('Verify your phone');
    expect(verify?.forms[0]?.fields).toContainEqual(
      expect.objectContaining({ label: 'Verification code', autocomplete: 'one-time-code' }),
    );
    expect(verify?.landmarks).toEqual(expect.arrayContaining(['banner', 'main', 'contentinfo']));
    // The crawl must not click "Send code".
    expect(demo.issuedOtps.length).toBe(before);
    // "Reject" on the returns page is a form button, not a cookie banner.
    expect(paths).toContain('/account/returns');
    expect(demo.stats.return_rejects).toBe(0);
    expect(demo.stats.payments).toBe(0);
  });

  it('stops at max_pages', async () => {
    const { pages } = await crawl(demoTarget({ max_pages: 2 }));
    expect(pages).toHaveLength(2);
  });

  it('returns what it has when the signal aborts', async () => {
    const ac = new AbortController();
    ac.abort();
    const { pages } = await crawl(demoTarget({ max_pages: 10 }), ac.signal);
    expect(pages).toEqual([]);
  });
});

// A small site with a cookie banner, a third-party script, and links the crawl must not follow.
const BANNER_PAGE = `<!doctype html><html><head><title>Banner</title>
<script src="https://cdn.example.com/tracker.js"></script></head><body>
<main><h1>Welcome</h1>
<form onsubmit="event.preventDefault();fetch('/clicked/form-reject')"><button>Reject</button></form>
<a href="//other.example.com/x">Other host</a>
<a href="/logout">Log out</a>
<a href="/next">Next</a>
</main>
<div role="dialog" aria-label="Cookie settings"><p>We use cookies.</p>
<button onclick="fetch('/clicked/accept')">Accept all</button>
<button onclick="fetch('/clicked/reject');this.parentElement.remove()">Reject all</button>
</div></body></html>`;

describe('site crawl rules', () => {
  let server: Server;
  let base = '';
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url?.startsWith('/dead')) {
        req.socket.destroy();
        return;
      }
      if (/^\/r\d+$/.test(req.url ?? '')) {
        res.writeHead(302, { location: '/loop' });
        res.end();
        return;
      }
      if (req.url === '/loop') {
        res.writeHead(200, { 'content-type': 'text/html' });
        const links = Array.from({ length: 20 }, (_, i) => `<a href="/r${i}">r${i}</a>`).join('');
        res.end(`<!doctype html><title>Loop</title><main>${links}</main>`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.url === '/' ? BANNER_PAGE : '<!doctype html><title>Next</title><h1>Next</h1>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('rejects the cookie banner, counts blocked hosts, and skips other hosts and logout', async () => {
    const config = parseConfig(
      {
        targets: {
          site: { profile: 'p', base_url: base, allowed_hosts: ['localhost'], inspect: { max_pages: 10 } },
        },
      },
      '/tmp',
    );
    const target = config.targets.site;
    if (!target?.inspect) throw new Error('test config has no inspect block');
    const report = await crawl({ config, target, inspect: target.inspect });
    expect(report.blocked_hosts).toEqual([{ host: 'cdn.example.com', count: 1 }]);
    expect(hits).toContain('/clicked/reject');
    expect(hits).not.toContain('/clicked/accept');
    expect(hits).not.toContain('/clicked/form-reject');
    expect(hits).not.toContain('/logout');
    expect(report.pages.map((p) => p.path_pattern)).toEqual(['/', '/next']);
    expect(report.pages[0]?.dialogs).toEqual([]);
  });

  function siteTarget(inspect: Record<string, unknown>) {
    const config = parseConfig(
      { targets: { site: { profile: 'p', base_url: base, allowed_hosts: ['localhost'], inspect } } },
      '/tmp',
    );
    const target = config.targets.site;
    if (!target?.inspect) throw new Error('test config has no inspect block');
    return { config, target, inspect: target.inspect };
  }

  it('stops after three page loads for each page, also when loads only redirect', async () => {
    const before = hits.filter((h) => /^\/r\d+$/.test(h)).length;
    const report = await crawl(siteTarget({ start_paths: ['/loop'], max_pages: 2 }));
    expect(report.pages.map((p) => p.path_pattern)).toEqual(['/loop']);
    // Six loads in all: "/loop" and five redirects back to it.
    expect(hits.filter((h) => /^\/r\d+$/.test(h)).length - before).toBe(5);
  });

  it('cuts the query from URLs in progress messages', async () => {
    const messages: string[] = [];
    await crawl(siteTarget({ start_paths: ['/dead?session=abc123secret'] }), undefined, messages);
    expect(messages.join('\n')).toContain('Could not open /dead');
    expect(messages.join('\n')).not.toContain('abc123secret');
  });
});
