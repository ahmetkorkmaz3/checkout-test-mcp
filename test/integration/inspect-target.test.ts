import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load-config.js';
import type { PageSnapshot, SiteReport } from '../../src/inspect/crawl.js';
import {
  describeError,
  type InspectionManager as IM,
  InspectionManager,
  type InspectionPhases,
} from '../../src/inspect/manager.js';
import type { ProbeResult } from '../../src/inspect/probe.js';
import { RESULT_CHAR_LIMIT } from '../../src/inspect/report.js';
import { silentLogger } from '../../src/logger.js';
import type { GuardedContext } from '../../src/runner/browser.js';
import { BrowserSlots } from '../../src/runs/browser-slots.js';
import { RunManager } from '../../src/runs/manager.js';
import { RunStore } from '../../src/runs/store.js';
import { ScenarioRegistry } from '../../src/scenarios/registry.js';
import type { ResolvedConfig } from '../../src/schemas/config.js';
import { createServer } from '../../src/server.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHOP_SRC = path.join(ROOT, 'test/fixtures/shop-src');

let dir: string;
let client: Client | undefined;
let managers: IM[] = [];
let gates: Array<() => void> = [];

function page(kind: PageSnapshot['kind'], p: string, elements = 0): PageSnapshot {
  return {
    path_pattern: p,
    url_path: p,
    kind,
    kind_reasons: [],
    title: `Page ${p}`,
    headings: [],
    landmarks: [],
    elements: Array.from({ length: elements }, (_, i) => ({
      role: 'button',
      name: `Button number ${i} with a long accessible name`,
      visible: true,
    })),
    forms: [],
    selects: [],
    iframes: [],
    dialogs: [],
  };
}

const SITE: SiteReport = {
  pages: [page('home', '/'), page('product', '/p/*'), page('cart', '/cart')],
  api_calls: [
    {
      method: 'GET',
      path_pattern: '/api/products/*',
      status: 200,
      content_type: 'application/json',
      page_kind: 'product',
    },
  ],
  blocked_hosts: [],
};

const PROBE: ProbeResult = {
  reached: 'payment',
  stopped_reason: 'payment_step_reached',
  steps: [{ action: 'click add to cart', page_kind: 'product', url_path: '/p/mug', result: 'done' }],
  dialogs: [],
  guest_option: true,
  payment: {
    methods: ['Card'],
    card_form: true,
    card_iframe_hosts: [],
    test_card_select: { label: 'Test card', options: ['Visa success', 'Card declined'] },
    agreement_checkbox: 'I accept the terms',
    pay_button: 'Pay now',
  },
  side_effects: ['cart item', 'guest account inspect-0a1b2c3d@example.test', 'address'],
};

const fakeContext = (): GuardedContext =>
  ({ browser: {}, context: {}, close: async () => {} }) as unknown as GuardedContext;

/** A gate that holds a phase until the test opens it. */
function gate(): Promise<void> {
  return new Promise((resolve) => gates.push(resolve));
}

function makeConfig(): ResolvedConfig {
  return parseConfig(
    {
      runs_dir: path.join(dir, 'runs'),
      scenario_dirs: [path.join(ROOT, 'scenarios')],
      test_data_dir: path.join(ROOT, 'test-data'),
      targets: {
        'shop-local': {
          profile: 'demo-store',
          base_url: 'http://shop.test',
          allowed_hosts: ['shop.test'],
          inspect: { probe_checkout: true, source_dirs: [SHOP_SRC] },
        },
        'demo-local': {
          profile: 'demo-store',
          base_url: 'http://localhost:4173',
          allowed_hosts: ['localhost'],
        },
        'members-local': {
          profile: 'demo-store',
          base_url: 'http://members.test',
          allowed_hosts: ['members.test'],
          secrets: { member_email: 'M_EMAIL', member_password: 'M_PASS' },
          inspect: { probe_checkout: true, source_dirs: [SHOP_SRC] },
        },
      },
    },
    dir,
  );
}

async function setup(phases: Partial<InspectionPhases> = {}, slots?: BrowserSlots) {
  const config = makeConfig();
  const registry = await ScenarioRegistry.load(config.scenario_dirs);
  const store = new RunStore(config.runs_dir);
  await store.init();
  const shared = slots ?? new BrowserSlots(config.max_parallel_runs);
  const manager = new RunManager({ config, registry, store, logger: silentLogger, env: {}, slots: shared });
  const inspections = track(
    new InspectionManager({
      config,
      logger: silentLogger,
      slots: shared,
      phases: {
        openContext: async () => fakeContext(),
        crawl: async () => SITE,
        probe: async () => PROBE,
        ...phases,
      },
    }),
  );
  await inspections.init();
  const server = createServer({ config, registry, manager, inspections, logger: silentLogger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { config, inspections, slots: shared };
}

function track(m: IM): IM {
  managers.push(m);
  return m;
}

// biome-ignore lint/suspicious/noExplicitAny: test helper over SDK result union
async function call(args: Record<string, unknown>): Promise<any> {
  if (!client) throw new Error('call setup() first');
  return client.callTool({ name: 'inspect_target', arguments: args });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ctm-inspect-'));
  managers = [];
  gates = [];
  client = undefined;
});

afterEach(async () => {
  // Open every gate until all managers are idle, so no job writes after the folder is gone.
  let settled = false;
  const idle = Promise.all(managers.map((m) => m.idle())).finally(() => {
    settled = true;
  });
  while (!settled) {
    for (const open of gates.splice(0)) open();
    await new Promise((r) => setTimeout(r, 1));
  }
  await idle;
  await client?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('inspect_target', () => {
  it('inspects a target and suggests the baseline set', async () => {
    await setup();
    const res = await call({ target: 'shop-local', idempotency_key: 'inspect-shop-01' });
    expect(res.isError).toBeFalsy();
    const r = res.structuredContent;
    expect(r.status).toBe('finished');
    expect(r.reused_existing_inspection).toBe(false);
    expect(r.inspection_id).toMatch(/^insp_[A-Za-z0-9_-]{16}$/);
    expect(
      r.suggested_scenarios.filter((s: { baseline: boolean }) => s.baseline).map((s: { id: string }) => s.id),
    ).toEqual(['shop-local-guest-card', 'shop-local-card-declined', 'shop-local-terms-required']);
    expect(r.code.payment_hints).toContainEqual(expect.objectContaining({ provider: 'iyzico' }));
    expect(r.side_effects).toContain('cart item');
    expect(r.next).toMatchObject({ kind: 'call_tool', tool: 'save_scenario' });
    const onDisk = JSON.parse(await readFile(r.report_path, 'utf8'));
    expect(onDisk.inspection_id).toBe(r.inspection_id);
    expect(onDisk.status).toBe('finished');
  });

  it('same key returns the same inspection, and a restart marks a running one interrupted', async () => {
    const { config } = await setup({
      crawl: async () => {
        await gate();
        return SITE;
      },
    });
    const first = await call({ target: 'shop-local', idempotency_key: 'inspect-shop-02', wait_s: 0 });
    expect(first.structuredContent.status).not.toBe('finished');
    expect(first.structuredContent.next).toMatchObject({
      kind: 'call_tool',
      tool: 'inspect_target',
      arguments: { target: 'shop-local', idempotency_key: 'inspect-shop-02', scope: 'both', wait_s: 20 },
    });
    const again = await call({ target: 'shop-local', idempotency_key: 'inspect-shop-02', wait_s: 0 });
    expect(again.structuredContent.inspection_id).toBe(first.structuredContent.inspection_id);
    expect(again.structuredContent.reused_existing_inspection).toBe(true);

    // Wait until the record on disk says running, as after a crash in the crawl.
    const file = first.structuredContent.report_path;
    for (let i = 0; i < 200; i++) {
      const onDisk = JSON.parse(await readFile(file, 'utf8'));
      if (onDisk.status === 'running') break;
      await new Promise((r) => setTimeout(r, 5));
    }

    // A second manager on the same runs_dir acts as the server after a restart.
    let crawls = 0;
    const restarted = track(
      new InspectionManager({
        config,
        logger: silentLogger,
        phases: {
          openContext: async () => fakeContext(),
          crawl: async () => {
            crawls++;
            return SITE;
          },
        },
      }),
    );
    await restarted.init();
    const { report, reused } = await restarted.start({
      target: 'shop-local',
      idempotency_key: 'inspect-shop-02',
      scope: 'both',
    });
    expect(reused).toBe(true);
    expect(report.inspection_id).toBe(first.structuredContent.inspection_id);
    expect(report.status).toBe('finished');
    expect(report.interrupted).toBe(true);
    expect(report.warnings.join('\n')).toMatch(/server stopped/);
    await restarted.idle();
    expect(crawls).toBe(0);
  });

  it('refuses the same key with other arguments', async () => {
    await setup();
    await call({ target: 'shop-local', idempotency_key: 'inspect-shop-03' });
    const res = await call({ target: 'shop-local', idempotency_key: 'inspect-shop-03', scope: 'site' });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(res.structuredContent.error.next_actions).toContainEqual(
      expect.objectContaining({
        tool: 'inspect_target',
        arguments: expect.objectContaining({ scope: 'both' }),
      }),
    );
  });

  it('keeps the whole tool result under 40000 characters and points to report_path', async () => {
    const big: SiteReport = {
      ...SITE,
      pages: Array.from({ length: 25 }, (_, i) => page('other', `/page-${i}`, 200)),
    };
    await setup({ crawl: async () => big });
    const res = await call({ target: 'shop-local', idempotency_key: 'inspect-shop-04' });
    const r = res.structuredContent;
    expect(res.content[0].text.length).toBeLessThanOrEqual(RESULT_CHAR_LIMIT);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(RESULT_CHAR_LIMIT);
    expect(JSON.parse(res.content[0].text)).toEqual(r);
    expect(r.site.pages).toHaveLength(25);
    expect(r.site.pages[0].elements).toEqual([]);
    const warning = r.warnings.find((w: string) => w.includes('see report_path'));
    expect(warning).toMatch(/site\.pages\[\]\.elements/);
    expect(warning).not.toContain(r.report_path);
    const onDisk = JSON.parse(await readFile(r.report_path, 'utf8'));
    expect(onDisk.site.pages[0].elements).toHaveLength(200);
  });

  it('cuts pages when the other cuts are not enough', async () => {
    const many: SiteReport = {
      ...SITE,
      pages: Array.from({ length: 300 }, (_, i) => ({
        ...page('other', `/page-${i}`),
        headings: Array.from({ length: 5 }, (_, j) => `Heading ${j} of a long page number ${i}`),
      })),
    };
    await setup({ crawl: async () => many });
    const res = await call({ target: 'shop-local', idempotency_key: 'inspect-shop-06' });
    expect(res.content[0].text.length).toBeLessThanOrEqual(RESULT_CHAR_LIMIT);
    const warning = res.structuredContent.warnings.find((w: string) => w.includes('see report_path'));
    expect(warning).toMatch(/site\.pages after the first \d+ of 300/);
    expect(warning).not.toMatch(/Cut: \./);
  });

  it('gives the same inspection after a restart without the key index', async () => {
    const { config } = await setup();
    const first = (await call({ target: 'shop-local', idempotency_key: 'inspect-shop-07' }))
      .structuredContent;
    await managers[0]?.idle();
    await rm(path.join(config.runs_dir, 'inspections', 'idempotency.json'));
    let crawls = 0;
    const restarted = track(
      new InspectionManager({
        config,
        logger: silentLogger,
        phases: {
          openContext: async () => fakeContext(),
          crawl: async () => {
            crawls++;
            return SITE;
          },
        },
      }),
    );
    await restarted.init();
    const { report, reused } = await restarted.start({
      target: 'shop-local',
      idempotency_key: 'inspect-shop-07',
      scope: 'both',
    });
    expect(reused).toBe(true);
    expect(report.inspection_id).toBe(first.inspection_id);
    expect(crawls).toBe(0);
  });

  it('runs the next job after a job fails before its phases', async () => {
    class FailOnce extends BrowserSlots {
      failed = false;
      override acquire(): Promise<void> {
        if (!this.failed) {
          this.failed = true;
          return Promise.reject(new Error('slot error'));
        }
        return super.acquire();
      }
    }
    const slots = new FailOnce(1);
    await setup({}, slots);
    const a = (await call({ target: 'shop-local', idempotency_key: 'inspect-fail-01' })).structuredContent;
    expect(a.status).toBe('finished');
    expect(a.warnings.join('\n')).toMatch(/^INSPECTION_FAILED/m);
    const b = (await call({ target: 'shop-local', idempotency_key: 'inspect-fail-02' })).structuredContent;
    expect(b.status).toBe('finished');
    expect(b.site).not.toBeNull();
    expect(slots.inUse).toBe(0);
  });

  it('keeps the partial report and warns with INSPECTION_FAILED when a phase crashes', async () => {
    await setup({
      crawl: async () => {
        throw new TypeError('cannot read /home/someone/shop/secret.ts for http://shop.test/a?token=abc123');
      },
    });
    const res = await call({ target: 'shop-local', idempotency_key: 'inspect-shop-05' });
    expect(res.isError).toBeFalsy();
    const r = res.structuredContent;
    expect(r.status).toBe('finished');
    expect(r.site).toBeNull();
    expect(r.checkout_probe.reached).toBe('payment');
    expect(r.code).not.toBeNull();
    const failed = r.warnings.find((w: string) => w.startsWith('INSPECTION_FAILED'));
    expect(failed).toMatch(/site crawl/);
    expect(failed).toMatch(/TypeError/);
    expect(failed).not.toMatch(/someone|token|abc123/);
  });

  it('skips the probe without the config flag and says so', async () => {
    let probes = 0;
    await setup({
      probe: async () => {
        probes++;
        return PROBE;
      },
    });
    const res = await call({ target: 'demo-local', idempotency_key: 'inspect-demo-01' });
    const r = res.structuredContent;
    expect(probes).toBe(0);
    expect(r.checkout_probe).toBeNull();
    expect(r.code).toBeNull();
    expect(r.side_effects).toEqual([]);
    const text = r.warnings.join('\n');
    expect(text).toMatch(/targets\.demo-local\.inspect\.probe_checkout/);
    expect(text).toMatch(/guest account/);
    expect(text).toMatch(/source_dirs is empty/);
    expect(r.next.kind).toBe('ask_human');
  });

  it('reads only the site with scope site, and only the code with scope code', async () => {
    let crawls = 0;
    await setup({
      crawl: async () => {
        crawls++;
        return SITE;
      },
    });
    const site = (await call({ target: 'shop-local', idempotency_key: 'inspect-scope-1', scope: 'site' }))
      .structuredContent;
    expect(site.code).toBeNull();
    expect(site.site).not.toBeNull();
    const code = (await call({ target: 'shop-local', idempotency_key: 'inspect-scope-2', scope: 'code' }))
      .structuredContent;
    expect(code.site).toBeNull();
    expect(code.checkout_probe).toBeNull();
    expect(code.code.frameworks.length).toBeGreaterThan(0);
    expect(crawls).toBe(1);
  });

  it('suggests member-card when the target maps member secrets', async () => {
    await setup({ crawl: async () => ({ ...SITE, pages: [...SITE.pages, page('login', '/login')] }) });
    const r = (await call({ target: 'members-local', idempotency_key: 'inspect-members-1' }))
      .structuredContent;
    expect(
      r.suggested_scenarios.find((s: { id: string }) => s.id === 'members-local-member-card').baseline,
    ).toBe(true);
  });

  it('waits for a free browser slot', async () => {
    const slots = new BrowserSlots(1);
    await slots.acquire();
    await setup({}, slots);
    const r = (await call({ target: 'shop-local', idempotency_key: 'inspect-slot-01', wait_s: 0 }))
      .structuredContent;
    expect(r.status).toBe('queued');
    slots.release();
    const done = (await call({ target: 'shop-local', idempotency_key: 'inspect-slot-01', wait_s: 20 }))
      .structuredContent;
    expect(done.status).toBe('finished');
    expect(slots.inUse).toBe(0);
  });
});

describe('inspect_target refusals', () => {
  it('refuses an unknown target', async () => {
    await setup();
    const res = await call({ target: 'shop-locl', idempotency_key: 'inspect-ref-01' });
    expect(res.structuredContent.error.code).toBe('UNKNOWN_TARGET');
    expect(res.structuredContent.error.details.closest_match).toBe('shop-local');
  });

  it('refuses a target whose host is in production_hosts', async () => {
    const { config } = await setup();
    // The config load refuses this too. The manager must refuse on its own.
    config.production_hosts.push('shop.test');
    const res = await call({ target: 'shop-local', idempotency_key: 'inspect-ref-02' });
    expect(res.structuredContent.error.code).toBe('PRODUCTION_HOST_REFUSED');
  });

  it('refuses a target with a host that has no test label', async () => {
    const { config } = await setup();
    // The config load refuses this too. The manager must refuse on its own.
    config.targets['shop-local']?.allowed_hosts.push('shop.example.com');
    const res = await call({ target: 'shop-local', idempotency_key: 'inspect-ref-04' });
    expect(res.structuredContent.error.code).toBe('HOST_NOT_ALLOWED');
  });

  it('refuses scope code without source_dirs', async () => {
    await setup();
    const res = await call({ target: 'demo-local', idempotency_key: 'inspect-ref-03', scope: 'code' });
    expect(res.structuredContent.error.code).toBe('INVALID_PARAMS');
  });

  it('refuses an idempotency key with other characters', async () => {
    await setup();
    const res = await call({ target: 'shop-local', idempotency_key: 'http://x.test/a' });
    expect(res.isError).toBe(true);
  });
});

describe('describeError', () => {
  it('removes URLs and absolute paths', () => {
    expect(describeError(new Error('ENOENT: open "/home/a/b.json" at https://h.test/x?y=1'))).toBe(
      'Error: ENOENT: open "<path>" at <url>',
    );
  });
});

describe('BrowserSlots', () => {
  it('gives a freed slot to a waiter before a later tryAcquire', async () => {
    const slots = new BrowserSlots(1);
    expect(slots.tryAcquire()).toBe(true);
    let got = false;
    const waiting = slots.acquire().then(() => {
      got = true;
    });
    slots.release();
    expect(slots.tryAcquire()).toBe(false);
    await waiting;
    expect(got).toBe(true);
    slots.release();
    expect(slots.inUse).toBe(0);
  });
});
