import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JS example without types
import { startDemoStore } from '../../examples/demo-store/server.mjs';
import { bootstrap } from '../../src/app.js';
import { parseConfig } from '../../src/config/load-config.js';
import { guardedClick, guardedFill, guardedKey } from '../../src/inspect/actions.js';
import { BlockedHostCounter, crawlSite, type SiteReport } from '../../src/inspect/crawl.js';
import { InspectionManager } from '../../src/inspect/manager.js';
import { type ProbeResult, probeCheckout } from '../../src/inspect/probe.js';
import type { InspectionReport } from '../../src/inspect/report.js';
import { silentLogger } from '../../src/logger.js';
import { openGuardedContext } from '../../src/runner/browser.js';
import type { InspectConfig } from '../../src/schemas/config.js';
import { createServer as createMcpServer, type ServerDeps } from '../../src/server.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

let demo: {
  url: string;
  close(): Promise<void>;
  stats: {
    orders: number;
    payments: number;
    return_rejects: number;
    cookieAccepted: number;
    contacts: number;
  };
  issuedOtps: string[];
  setBugs(bugs: string[]): void;
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

async function probe(
  t: ReturnType<typeof demoTarget>,
  signal = new AbortController().signal,
): Promise<ProbeResult> {
  const guarded = await openGuardedContext({ config: t.config, target: t.target, onBlocked: () => {} });
  try {
    return await probeCheckout({
      context: guarded.context,
      target: t.target,
      inspect: t.inspect,
      signal,
      onProgress: () => {},
    });
  } finally {
    await guarded.close();
  }
}

describe('checkout probe', () => {
  afterEach(() => {
    demo.setBugs([]);
  });

  it('probes the demo store to the payment step and never pays', async () => {
    const before = demo.stats.orders;
    const payments = demo.stats.payments;
    const contacts = demo.stats.contacts;
    const otps = demo.issuedOtps.length;
    const r = await probe(demoTarget({ probe_checkout: true }));
    expect(r.reached).toBe('payment');
    expect(r.stopped_reason).toBe('payment_step_reached');
    expect(r.guest_option).toBe(true);
    expect(r.payment?.agreement_checkbox).toMatch(/terms/i);
    expect(r.payment?.pay_button).toMatch(/^Pay/);
    expect(r.payment?.card_form).toBe(true);
    expect(r.payment?.card_iframe_hosts).toEqual(['localhost']);
    expect(r.payment?.card_frames).toEqual([{ host: 'localhost', title: 'Secure card payment input' }]);
    expect(r.payment?.card_fields).toEqual([
      { placeholder: 'Card number', autocomplete: 'cc-number', in_frame: true },
      { placeholder: 'MM / YY', autocomplete: 'cc-exp', in_frame: true },
      { placeholder: 'CVC', autocomplete: 'cc-csc', in_frame: true },
    ]);
    expect(demo.stats.orders).toBe(before);
    expect(demo.stats.payments).toBe(payments);
    expect(demo.issuedOtps.length).toBe(otps);
    // The probe saved the address form once.
    expect(demo.stats.contacts).toBe(contacts + 1);
    // The guest email is only in side_effects.
    const email = r.side_effects.find((e) => e.startsWith('guest account '));
    expect(email).toMatch(/^guest account inspect-[0-9a-f]{8}@example\.test$/);
    expect(JSON.stringify({ steps: r.steps, payment: r.payment })).not.toMatch(/@example\.test/);
    expect(r.side_effects).toEqual(expect.arrayContaining(['cart item', 'address']));
  });

  it('rejects a cookie banner and never accepts it', async () => {
    demo.setBugs(['cookie-banner']);
    const r = await probe(demoTarget({ probe_checkout: true }));
    expect(r.steps[0]).toMatchObject({ action: expect.stringMatching(/reject/i), result: 'done' });
    expect(demo.stats.cookieAccepted).toBe(0);
    expect(r.reached).toBe('payment');
    expect(r.dialogs).toContain('dialog: Cookie settings');
  });

  it('stops at a login wall without a guest option', async () => {
    demo.setBugs(['login-wall']);
    const r = await probe(demoTarget({ probe_checkout: true }));
    expect(r.stopped_reason).toBe('login_required');
    expect(r.guest_option).toBe(false);
    expect(r.reached).toBe('checkout');
  });

  it('stops with timeout when the signal aborts', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await probe(demoTarget({ probe_checkout: true }), ac.signal);
    expect(r.stopped_reason).toBe('timeout');
    expect(r.reached).toBe('none');
  });
});

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
<form onsubmit="event.preventDefault();fetch('/clicked/form-reject')"><p>Withdraw your consent for cookies on request R-2?</p><button>Reject</button></form>
<section role="region" aria-label="Offers"><button onclick="fetch('/clicked/region-reject')">Reject</button></section>
<div class="wrap"><p>See our cookie policy.</p><div><button onclick="fetch('/clicked/wrap-reject')">Reject</button></div><nav><a href="/next">Next</a></nav></div>
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
    expect(hits).not.toContain('/clicked/region-reject');
    expect(hits).not.toContain('/clicked/wrap-reject');
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

// A small Turkish shop: a cart page, custom lists where the district list waits
// for the city list, and a site test card select. The SMS case below tests a send-code page.
const TR_HEAD =
  '<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Mağaza</title></head><body>';
const TR_PAGES: Record<string, string> = {
  '/urun/kalem-123456': `${TR_HEAD}<header><a href="/sepet">Sepetim</a></header><main><h1>Kalem</h1>
<button onclick="fetch('/api/sepet',{method:'POST'}).then(()=>alert('Ürün sepete eklendi'))">Sepete Ekle</button></main></body></html>`,
  '/sepet': `${TR_HEAD}<main><h1>Sepetim</h1><p>1 ürün</p>
<button onclick="location.href='/odeme/adres'">Sepeti Onayla</button></main></body></html>`,
  '/odeme/adres': `${TR_HEAD}<main><h1>Teslimat adresi</h1>
<label for="ad">Ad</label><input id="ad">
<label for="soyad">Soyad</label><input id="soyad">
<label for="tel">Cep Telefonu</label><input id="tel" type="tel" placeholder="05XX XXX XX XX">
<span id="il-l">İl</span><button id="il" role="combobox" aria-labelledby="il-l" aria-expanded="false">Seçiniz</button>
<ul id="il-list" role="listbox" hidden><li role="option">Seçiniz</li><li role="option">Adana</li><li role="option">Ankara</li></ul>
<span id="ilce-l">İlçe</span><button id="ilce" role="combobox" aria-labelledby="ilce-l" aria-disabled="true" aria-expanded="false">Seçiniz</button>
<ul id="ilce-list" role="listbox" hidden></ul>
<label for="adres">Adres</label><textarea id="adres"></textarea>
<label for="baslik">Adres Başlığı</label><input id="baslik">
<button id="save">Kaydet ve Devam Et</button></main>
<script>
const il = document.getElementById('il'), ilce = document.getElementById('ilce');
const ilList = document.getElementById('il-list'), ilceList = document.getElementById('ilce-list');
il.onclick = () => { ilList.hidden = false; };
ilList.onclick = (e) => {
  if (e.target.textContent === 'Seçiniz') return;
  il.textContent = e.target.textContent; ilList.hidden = true;
  setTimeout(() => {
    ilceList.innerHTML = '<li role="option">Seçiniz</li><li role="option">Seyhan</li><li role="option">Çukurova</li>';
    ilce.setAttribute('aria-disabled', 'false');
  }, 600);
};
ilce.onclick = () => { if (ilce.getAttribute('aria-disabled') !== 'true') ilceList.hidden = false; };
ilceList.onclick = (e) => {
  if (e.target.textContent === 'Seçiniz') return;
  ilce.textContent = e.target.textContent; ilceList.hidden = true;
};
document.getElementById('save').onclick = async () => {
  const v = (id) => document.getElementById(id).value;
  const body = { ad: v('ad'), soyad: v('soyad'), tel: v('tel'), adres: v('adres'), baslik: v('baslik'),
    il: il.textContent, ilce: ilce.textContent };
  const r = await fetch('/api/adres', { method: 'POST', body: JSON.stringify(body) });
  if (r.ok) location.href = '/odeme/kart';
};
</script></body></html>`,
  '/odeme/kart': `${TR_HEAD}<main><h1>Ödeme</h1>
<label><input type="radio" name="m" checked> Kredi Kartı</label><label><input type="radio" name="m"> Havale</label>
<label for="tk">Test Kartı</label><select id="tk"><option value="">Seçiniz</option>
<option value="1">Akbank - Master Card (Credit)</option><option value="2">3DS Tamamlama - İşlem onaylanmadı</option></select>
<label><input type="checkbox" id="agree"> Ön Bilgilendirme Formu'nu okudum, onaylıyorum.</label>
<button onclick="fetch('/clicked/pay',{method:'POST'})">Siparişi Tamamla</button></main></body></html>`,
};

describe('checkout probe on a shop with custom lists', () => {
  let server: Server;
  let base = '';
  const hits: string[] = [];
  let address: Record<string, string> | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          if (req.url === '/api/adres') {
            address = JSON.parse(body);
            const ok = address?.il !== 'Seçiniz' && address?.ilce !== 'Seçiniz';
            res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
            res.end('{}');
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}');
        });
        return;
      }
      const page = TR_PAGES[req.url ?? ''];
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page ?? '<!doctype html><title>Yok</title><h1>Yok</h1>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('fills the dependent lists, records the test card select, and never pays', async () => {
    const config = parseConfig(
      {
        targets: {
          tr: {
            profile: 'p',
            base_url: base,
            allowed_hosts: ['localhost'],
            inspect: { product_paths: ['/urun/kalem-123456'], probe_checkout: true },
          },
        },
      },
      '/tmp',
    );
    const target = config.targets.tr;
    if (!target?.inspect) throw new Error('test config has no inspect block');
    const r = await probe({ config, target, inspect: target.inspect });
    expect(r.stopped_reason).toBe('payment_step_reached');
    expect(r.reached).toBe('payment');
    expect(r.guest_option).toBe(false);
    expect(r.payment).toMatchObject({
      methods: ['Kredi Kartı', 'Havale'],
      card_form: false,
      test_card_select: {
        label: 'Test Kartı',
        options: ['Akbank - Master Card (Credit)', '3DS Tamamlama - İşlem onaylanmadı'],
      },
      agreement_checkbox: expect.stringMatching(/^Ön Bilgilendirme Formu/),
      pay_button: 'Siparişi Tamamla',
    });
    expect(address).toMatchObject({
      ad: 'Test',
      soyad: 'Inspect',
      tel: '55500000000',
      adres: 'Test Street 1',
      baslik: 'Test',
      il: 'Adana',
      ilce: 'Seyhan',
    });
    expect(hits).toContain('POST /api/sepet');
    expect(hits).not.toContain('POST /clicked/pay');
    expect(r.steps.map((s) => s.action)).toEqual(
      expect.arrayContaining(['open cart: "Sepetim"', 'go to checkout: "Sepeti Onayla"']),
    );
    expect(r.side_effects).toEqual(['cart item', 'address', expect.stringMatching(/^order draft/)]);
    expect(r.dialogs).toContain('alert: Ürün sepete eklendi');
    expect(r.steps.map((s) => s.action)).toContain('dialog opened: alert: Ürün sepete eklendi');
  });
});

describe('guarded actions', () => {
  it('refuses pay, cookie accept, send-code, password form, and card page clicks', async () => {
    const t = demoTarget();
    const guarded = await openGuardedContext({ config: t.config, target: t.target, onBlocked: () => {} });
    try {
      const page = await guarded.context.newPage();
      await page.setContent(`<main>
<button onclick="window.hit.push('next')">Next</button>
<button onclick="window.hit.push('pay')">Pay now</button>
<button onclick="window.hit.push('accept')">Accept all</button>
<button onclick="window.hit.push('code')">Send code</button>
<input type="submit" value="Place order" onclick="window.hit.push('order')">
<form onsubmit="event.preventDefault()"><input type="password"><button onclick="window.hit.push('login')">Sign in</button></form>
<input id="pw" type="password"><input id="cc" autocomplete="cc-number"><input id="otp" autocomplete="one-time-code">
</main><script>window.hit = []</script>`);
      const log: [string, string][] = [];
      const opts = {
        purpose: 'test',
        allow: 'continue' as const,
        words: {},
        log: (a: string, r: string) => log.push([a, r]),
      };
      for (const name of ['Next', 'Pay now', 'Accept all', 'Send code', 'Place order', 'Sign in']) {
        await guardedClick(page, page.getByRole('button', { name, exact: true }), opts);
      }
      // The one-time code field on this page makes every click unsafe, also "Next".
      expect(await page.evaluate(() => (window as unknown as { hit: string[] }).hit)).toEqual([]);
      expect(log.every(([, r]) => r === 'refused')).toBe(true);

      for (const id of ['pw', 'cc', 'otp']) {
        expect(await guardedFill(page, page.locator(`#${id}`), '1234', opts)).toBe('refused');
        expect(await page.locator(`#${id}`).inputValue()).toBe('');
      }

      await page.setContent(`<button onclick="window.hit.push('next')">Next</button>
<button onclick="window.hit.push('pay')">Pay now</button><script>window.hit = []</script>`);
      expect(await guardedClick(page, page.getByRole('button', { name: 'Pay now' }), opts)).toBe('refused');
      expect(await guardedClick(page, page.getByRole('button', { name: 'Next' }), opts)).toBe('done');
      expect(await page.evaluate(() => (window as unknown as { hit: string[] }).hit)).toEqual(['next']);

      await page.setContent(`<button onclick="window.hit.push('next')">Next</button>
<iframe srcdoc="<input autocomplete='cc-number'>"></iframe><script>window.hit = []</script>`);
      await page.waitForTimeout(200);
      expect(await guardedClick(page, page.getByRole('button', { name: 'Next' }), opts)).toBe('refused');
      expect(await page.evaluate(() => (window as unknown as { hit: string[] }).hit)).toEqual([]);
    } finally {
      await guarded.close();
    }
  });

  it('refuses image pay buttons, nameless buttons, pay links, unmatched names, and keys other than Escape', async () => {
    const t = demoTarget();
    const guarded = await openGuardedContext({ config: t.config, target: t.target, onBlocked: () => {} });
    try {
      const page = await guarded.context.newPage();
      await page.setContent(`<main><form onsubmit="event.preventDefault()">
<input id="img" type="image" alt="Pay" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onclick="window.hit.push('img')">
<button id="imgchild" onclick="window.hit.push('imgchild')"><img alt="Complete order" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>
<button id="nameless" type="submit" onclick="window.hit.push('nameless')"></button>
<button id="delete" onclick="window.hit.push('delete')">Delete address</button>
</form>
<span id="paylink" role="link" tabindex="0" onclick="window.hit.push('paylink')">Pay now</span>
<a id="checkout" href="#" onclick="window.hit.push('checkout')">Checkout</a>
</main><script>window.hit = []</script>`);
      const log: [string, string][] = [];
      const base = { purpose: 'test', words: {}, log: (a: string, r: string) => log.push([a, r]) };
      for (const id of ['img', 'imgchild', 'nameless', 'delete']) {
        expect(await guardedClick(page, page.locator(`#${id}`), { ...base, allow: 'continue' }), id).toBe(
          'refused',
        );
      }
      expect(await guardedClick(page, page.locator('#paylink'), { ...base, allow: 'checkout' })).toBe(
        'refused',
      );
      // The right name for the wrong step is also refused.
      expect(await guardedClick(page, page.locator('#checkout'), { ...base, allow: 'add_to_cart' })).toBe(
        'refused',
      );
      expect(await page.evaluate(() => (window as unknown as { hit: string[] }).hit)).toEqual([]);
      expect(await guardedClick(page, page.locator('#checkout'), { ...base, allow: 'checkout' })).toBe(
        'done',
      );
      expect(await guardedKey(page, 'Enter', base)).toBe('refused');

      // A frame that the guard blocked makes every click unsafe.
      await page.setContent(`<button onclick="window.hit.push('next')">Continue</button>
<iframe src="https://pay.example.com/card"></iframe><script>window.hit = []</script>`);
      await page.waitForTimeout(300);
      const blockedFrames = new Set(['https://pay.example.com/card']);
      expect(
        await guardedClick(page, page.getByRole('button', { name: 'Continue' }), {
          ...base,
          allow: 'continue',
          blockedFrames,
        }),
      ).toBe('refused');
      expect(log.at(-1)?.[0]).toMatch(/frame that the guard blocked/);
      expect(await page.evaluate(() => (window as unknown as { hit: string[] }).hit)).toEqual([]);
      expect(
        await guardedClick(page, page.getByRole('button', { name: 'Continue' }), {
          ...base,
          allow: 'continue',
        }),
      ).toBe('done');
      expect(await guardedKey(page, 'Escape', base)).toBe('done');
    } finally {
      await guarded.close();
    }
  });
});

// Pages that test the payment step rules and the verification stop. Each case has a product page
// "/urun/<case>-123456" whose checkout link opens "/odeme/<case>".
const SAFETY_CASES: Record<string, string> = {
  // Address fields, a card iframe on a host that the guard blocks, and an order button.
  blocked: `<main><h1>Ödeme</h1><form onsubmit="event.preventDefault()">
<label for="ad">Ad</label><input id="ad"><label for="soyad">Soyad</label><input id="soyad">
<iframe title="Kart" src="https://pay.example.com/card"></iframe>
<button type="submit" onclick="fetch('/clicked/order',{method:'POST'})">Siparişi Onayla</button></form></main>`,
  // An express wallet button on the contact step must not end the probe.
  express: `<main><h1>Contact</h1><form id="f">
<label for="email">Email</label><input id="email" type="email">
<label for="name">Full name</label><input id="name">
<button type="submit">Continue</button></form>
<button onclick="fetch('/clicked/applepay',{method:'POST'})">Apple Pay</button></main>
<script>document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault(); await fetch('/api/contact',{method:'POST'}); location.href = '/odeme/express-pay';
});</script>`,
  // An SMS marketing consent next to the phone field is not a verification step.
  consent: `<main><h1>İletişim</h1><form id="f">
<label for="ad">Ad Soyad</label><input id="ad">
<label for="tel">Cep Telefonu</label><input id="tel" type="tel">
<label><input type="checkbox" id="kampanya"> Kampanyalardan SMS ile haberdar olmak istiyorum</label>
<button type="submit">Devam Et</button></form></main>
<script>document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault(); await fetch('/api/consent-contact',{method:'POST'}); location.href = '/odeme/express-pay';
});</script>`,
  // Blocked ad and tag manager frames on the guest and contact steps are not payment frames.
  adframes: `<main><h1>Checkout</h1><button onclick="location.href='/odeme/adframes-contact'">Continue as guest</button></main>
<div class="ads"><iframe src="https://ads.example.net/frame"></iframe>
<iframe src="https://www.googletagmanager.example/ns.html?id=GTM-X"></iframe></div>`,
  'adframes-contact': `<main><h1>Contact</h1><form id="f">
<label for="email">Email</label><input id="email" type="email">
<label for="name">Full name</label><input id="name">
<button type="submit">Continue</button></form></main>
<div class="ads"><iframe src="https://ads.example.net/frame"></iframe>
<iframe src="https://www.googletagmanager.example/ns.html?id=GTM-X"></iframe></div>
<script>document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault(); await fetch('/api/adframes-contact',{method:'POST'}); location.href = '/odeme/express-pay';
});</script>`,
  'express-pay': `<main><h1>Payment</h1><input autocomplete="cc-number" placeholder="Card number">
<button onclick="fetch('/clicked/pay',{method:'POST'})">Pay now</button></main>`,
  // A phone field and an SMS verification text: the probe stops before any continue click.
  sms: `<main><h1>İletişim</h1><form onsubmit="event.preventDefault()">
<label for="tel">Cep Telefonu</label><input id="tel" type="tel">
<p>Telefonunuza SMS ile doğrulama kodu gönderilecek.</p>
<button type="submit" onclick="fetch('/clicked/continue',{method:'POST'})">Devam Et</button></form></main>`,
};

describe('checkout probe safety rules', () => {
  let server: Server;
  let base = '';
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const product = /^\/urun\/([a-z-]+)-123456$/.exec(req.url ?? '');
      const step = /^\/odeme\/([a-z-]+)$/.exec(req.url ?? '');
      let body: string | undefined;
      if (product?.[1]) {
        body = `<header><a href="/odeme/${product[1]}">Checkout</a></header><main><h1>Kalem</h1>
<button onclick="fetch('/api/sepet',{method:'POST'})">Sepete Ekle</button></main>`;
      } else if (step?.[1]) body = SAFETY_CASES[step[1]];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title></head><body>${body ?? 'Yok'}</body></html>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function caseTarget(name: string) {
    const config = parseConfig(
      {
        targets: {
          s: {
            profile: 'p',
            base_url: base,
            allowed_hosts: ['localhost'],
            inspect: { product_paths: [`/urun/${name}-123456`], probe_checkout: true },
          },
        },
      },
      '/tmp',
    );
    const target = config.targets.s;
    if (!target?.inspect) throw new Error('test config has no inspect block');
    return { config, target, inspect: target.inspect };
  }

  it('takes a blocked card iframe as the payment step and clicks nothing that orders', async () => {
    const r = await probe(caseTarget('blocked'));
    expect(r.reached).toBe('payment');
    expect(r.stopped_reason).toBe('payment_step_reached');
    expect(r.payment?.pay_button).toBe('Siparişi Onayla');
    // The frame element is on the parent page, so the probe lists the blocked frame. Its fields are unknown.
    expect(r.payment?.card_frames).toEqual([{ host: 'pay.example.com', title: 'Kart' }]);
    expect(r.payment?.card_fields).toEqual([]);
    expect(hits.filter((h) => h.startsWith('POST /clicked/'))).toEqual([]);
  });

  it('does not take blocked ad or tag manager frames as the payment step', async () => {
    const r = await probe(caseTarget('adframes'));
    expect(r.guest_option).toBe(true);
    expect(r.reached).toBe('payment');
    expect(r.steps.at(-1)?.url_path).toBe('/odeme/express-pay');
    expect(r.steps.some((s) => s.action.includes('frame that the guard blocked'))).toBe(false);
    expect(hits).toContain('POST /api/adframes-contact');
  });

  it('does not stop at an express wallet button on the contact step', async () => {
    const r = await probe(caseTarget('express'));
    expect(r.reached).toBe('payment');
    expect(r.steps.at(-1)?.url_path).toBe('/odeme/express-pay');
    expect(r.payment?.pay_button).toBe('Pay now');
    expect(hits).toContain('POST /api/contact');
    expect(hits.filter((h) => h.startsWith('POST /clicked/'))).toEqual([]);
  });

  it('does not stop at an SMS marketing consent next to the phone field', async () => {
    const r = await probe(caseTarget('consent'));
    expect(r.stopped_reason).toBe('payment_step_reached');
    expect(hits).toContain('POST /api/consent-contact');
  });

  it('stops before a continue click when the page with a phone field talks about an SMS code', async () => {
    const r = await probe(caseTarget('sms'));
    expect(r.stopped_reason).toBe('verification_required');
    expect(hits.filter((h) => h.startsWith('POST /clicked/'))).toEqual([]);
  });
});

describe('inspection job on the demo store', () => {
  let dir = '';
  let manager: InspectionManager | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ctm-e2e-inspect-'));
  });

  afterAll(async () => {
    await manager?.idle();
    await rm(dir, { recursive: true, force: true });
  });

  async function inspectToEnd(input: { target: string; idempotency_key: string }): Promise<InspectionReport> {
    const config = parseConfig(
      {
        runs_dir: path.join(dir, 'runs'),
        targets: {
          'demo-local': {
            profile: 'demo-store',
            base_url: demo.url,
            allowed_hosts: ['localhost'],
            inspect: {
              max_pages: 10,
              probe_checkout: true,
              source_dirs: [path.resolve(import.meta.dirname, '../../examples/demo-store/src')],
            },
          },
        },
      },
      dir,
    );
    manager = new InspectionManager({ config, logger: silentLogger });
    await manager.init();
    const { report } = await manager.start({ ...input, scope: 'both' });
    let r = report;
    while (r.status !== 'finished') r = await manager.wait(r.inspection_id, 20);
    return r;
  }

  it('inspects the demo store and suggests the baseline set', async () => {
    const orders = demo.stats.orders;
    const payments = demo.stats.payments;
    const r = await inspectToEnd({ target: 'demo-local', idempotency_key: 'e2e-inspect-01' });
    expect(r.warnings.filter((w) => w.startsWith('INSPECTION_FAILED'))).toEqual([]);
    expect(r.suggested_scenarios.filter((s) => s.baseline).map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'demo-local-guest-card',
        'demo-local-card-declined',
        'demo-local-terms-required',
      ]),
    );
    expect(r.suggested_scenarios.find((s) => s.id === 'demo-local-guest-card')?.card_source).toEqual({
      kind: 'registry',
      card_id: 'stripe/visa-success',
    });
    expect(r.site?.pages.map((p) => p.kind)).toEqual(expect.arrayContaining(['product', 'checkout']));
    expect(r.checkout_probe?.guest_option).toBe(true);
    expect(r.checkout_probe?.reached).toBe('payment');
    expect(r.code?.payment_hints).toContainEqual(expect.objectContaining({ package: '@stripe/stripe-js' }));
    // The guest email may appear only in side_effects.
    expect(JSON.stringify({ site: r.site, code: r.code, probe: r.checkout_probe?.payment })).not.toMatch(
      /4242|@example\.test/,
    );
    expect(r.side_effects.join('\n')).toMatch(/@example\.test/);
    expect(demo.stats.orders).toBe(orders);
    expect(demo.stats.payments).toBe(payments);
    const onDisk = JSON.parse(await readFile(r.report_path, 'utf8'));
    expect(onDisk.status).toBe('finished');
  });
});

/**
 * The setup loop without a model: a small template fills a scenario from the report only.
 * It shows that the report has enough facts for the guest card scenario on the demo store.
 * It does not prove this for every shop: the success checks come from common words, not from the report.
 */
function guestCardScenario(
  report: InspectionReport,
  suggestion: InspectionReport['suggested_scenarios'][number],
) {
  const probe = report.checkout_probe;
  const payment = probe?.payment;
  if (!probe || !payment?.agreement_checkbox || !payment.pay_button) throw new Error('no payment step');
  if (suggestion.card_source?.kind !== 'registry') throw new Error('expected a registry card');
  const quoted = (prefix: string) => {
    const action = probe.steps.find((s) => s.result === 'done' && s.action.startsWith(prefix))?.action;
    const name = action?.match(/"([^"]+)"/)?.[1];
    if (!name) throw new Error(`no probe step "${prefix}"`);
    return name;
  };
  const elements = report.site?.pages.flatMap((p) => p.elements) ?? [];
  const roleOf = (name: string) => elements.find((e) => e.name === name)?.role ?? 'button';
  const products = report.site?.pages.filter((p) => p.kind === 'product') ?? [];
  const product = products.find((p) => p.url_path !== '/') ?? products[0];
  const productApi = report.site?.api_calls.find((a) => a.page_kind === 'product');
  if (!product || !productApi) throw new Error('no product page or product API call');
  const dataField: Record<string, string> = {
    email: 'email',
    'full name': 'full_name',
    phone: 'phone',
    address: 'address_line',
  };
  const fields = probe.steps.flatMap((s) => {
    const fill = s.action.match(/^fill (.+) field "([^"]+)"$/);
    if (fill?.[1] && fill[2] && dataField[fill[1]]) {
      return [
        `      - field: { label: ${fill[2]} }\n        value: "{{data.customer.${dataField[fill[1]]}}}"`,
      ];
    }
    const choose = s.action.match(/^choose the first option in "([^"]+)"$/);
    if (choose?.[1]) {
      return [
        `      - field: { label: ${choose[1]} }\n        select: "{{data.customer.${choose[1].toLowerCase()}}}"`,
      ];
    }
    return [];
  });
  // Card fields by autocomplete, in the card frame from the report.
  const frame = payment.card_frames[0];
  const cardValue: Record<string, string> = {
    'cc-number': '{{card.number}}',
    'cc-exp': '{{card.expiry}}',
    'cc-csc': '{{card.cvc}}',
  };
  const cardFields = payment.card_fields.flatMap((f) => {
    const value = f.autocomplete ? cardValue[f.autocomplete] : undefined;
    if (!value || !f.placeholder) return [];
    return [`      - field: { placeholder: ${f.placeholder} }\n        value: "${value}"`];
  });
  if (!frame || cardFields.length !== 3) throw new Error('no card frame or card fields in the report');
  const cardStep = `    within:\n      frame: { css: "iframe[title='${frame.title}']" }\n    fill_form:\n${cardFields.join('\n')}`;
  const checkout = quoted('go to checkout: ');
  const guest = quoted('continue as guest: ');
  const payWord = payment.pay_button.split(/\s+/)[0] ?? 'Pay';
  return `id: ${suggestion.id}
title: ${suggestion.title}
summary: ${suggestion.why}
compatible_profiles: [demo-store]
expected_outcome: ${suggestion.expected_outcome}
params:
  card:
    type: test_card
    default: ${suggestion.card_source.card_id}
    description: Test card that succeeds.
data:
  customer: customers/tr-guest.yaml
steps:
  - id: open_product
    title: Open the product page
    goto: ${product.url_path}
    expect:
      - response: { method: ${productApi.method}, url: "**${productApi.path_pattern}", status: ${productApi.status} }
  - id: add_to_cart
    title: Add the product to the cart
    click: { role: ${roleOf(quoted('add to cart: '))}, name: ${quoted('add to cart: ')}, exact: true }
  - id: start_checkout
    title: Start a guest checkout
    click: { role: ${roleOf(checkout)}, name: ${checkout}, exact: true }
    then:
      - click: { role: ${roleOf(guest)}, name: ${guest}, exact: true }
  - id: fill_address
    title: Fill the contact and address form
    fill_form:
${fields.join('\n')}
    then:
      - click: { role: button, name: ${quoted('save and continue: ')}, exact: true }
  - id: card
    title: Fill the card form
${cardStep}
  - id: accept_terms
    title: Accept the terms
    check: { label: ${payment.agreement_checkbox} }
  - id: pay
    title: Pay
    click: { role: button, name: { matches: "^${payWord}\\\\b" } }
    on_failure:
      hint: The payment did not go through. Check the card form and the payment hosts.
outcome:
  - id: confirmation_shown
    visible: { role: heading, name: { matches: "thank you|order received|order confirmed" } }
    timeout_ms: 20000
  - id: on_success_url
    url: { regex: "^https?://[^/]+/[^?]*(success|confirm)" }
`;
}

describe('setup loop without a model', () => {
  let dir = '';
  let deps: ServerDeps | undefined;
  let mcp: Client | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ctm-e2e-setup-'));
    await cp(path.join(ROOT, 'scenarios'), path.join(dir, 'scenarios'), { recursive: true });
    const config = parseConfig(
      {
        runs_dir: path.join(dir, 'runs'),
        scenario_dirs: [path.join(dir, 'scenarios')],
        test_data_dir: path.join(ROOT, 'test-data'),
        authoring: { dir: path.join(dir, 'scenarios/demo-store') },
        targets: {
          'demo-local': {
            profile: 'demo-store',
            base_url: demo.url,
            allowed_hosts: ['localhost'],
            inspect: {
              max_pages: 10,
              probe_checkout: true,
              source_dirs: [path.join(ROOT, 'examples/demo-store/src')],
            },
          },
        },
      },
      dir,
    );
    deps = await bootstrap({ config, logger: silentLogger });
    const server = createMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    mcp = new Client({ name: 'e2e', version: '0.0.0' });
    await mcp.connect(clientTransport);
  });

  afterAll(async () => {
    await deps?.inspections.idle();
    await deps?.manager.idle();
    await mcp?.close();
    await rm(dir, { recursive: true, force: true });
  });

  // biome-ignore lint/suspicious/noExplicitAny: test helper over SDK result union
  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    if (!mcp) throw new Error('no client');
    const res = await mcp.callTool({ name, arguments: args });
    expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
    return res.structuredContent;
  }

  it('builds the guest card scenario from the report, saves it with validate_on, and it passes', async () => {
    const orders = demo.stats.orders;
    const args = { target: 'demo-local', idempotency_key: 'e2e-setup-loop-01', scope: 'both', wait_s: 20 };
    let report = (await call('inspect_target', args)) as InspectionReport;
    for (let i = 0; i < 20 && report.status !== 'finished'; i++) {
      report = (await call('inspect_target', args)) as InspectionReport;
    }
    expect(report.status).toBe('finished');
    const suggestion = report.suggested_scenarios.find((s) => s.id === 'demo-local-guest-card');
    expect(suggestion?.baseline).toBe(true);
    if (!suggestion) throw new Error('no guest card suggestion');

    const saved = await call('save_scenario', {
      kind: 'scenario',
      path: 'local/demo-local-guest-card.yaml',
      yaml: guestCardScenario(report, suggestion),
      validate_on: { target: 'demo-local' },
    });
    expect(saved.scenario_id).toBe('demo-local-guest-card');
    // A card frame needs a css locator. The warning is expected.
    expect(saved.warnings.map((w: { path: string; rule: string }) => `${w.path} ${w.rule}`)).toEqual([
      'steps.4.within.frame.css prefer-semantic-locator',
    ]);
    const runId = saved.validation?.run_id as string;
    expect(runId).toMatch(/^run_/);

    let result = await call('get_run_result', { run_id: runId, wait_s: 20 });
    for (let i = 0; i < 12 && result.status !== 'finished'; i++) {
      result = await call('get_run_result', { run_id: runId, wait_s: 20 });
    }
    expect(result.status).toBe('finished');
    expect(result.verdict, JSON.stringify(result.failure)).toBe('passed');
    expect(demo.stats.orders).toBe(orders + 1);
  });
});
