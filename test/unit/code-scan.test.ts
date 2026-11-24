import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSource } from '../../src/inspect/code-scan.js';

const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/shop-src');
const LINK = path.join(FIXTURE, 'tmp-link');

beforeAll(() => {
  fs.rmSync(LINK, { force: true });
  fs.symlinkSync(os.tmpdir(), LINK);
});
afterAll(() => {
  fs.rmSync(LINK, { force: true });
});

describe('scanSource', () => {
  it('finds framework, routes, strings, test ids, payment and otp hints', async () => {
    const r = await scanSource([FIXTURE], { testIdAttribute: 'data-testid' });
    expect(r.frameworks.map((f) => f.name)).toContain('next');
    expect(r.routes.map((x) => x.path)).toEqual(expect.arrayContaining(['/odeme', '/sepet']));
    expect(r.test_ids).toContainEqual(expect.objectContaining({ value: 'pay-button' }));
    expect(r.payment_hints).toContainEqual(
      expect.objectContaining({ provider: 'iyzico', package: 'iyzipay' }),
    );
    expect(r.otp_hints.length).toBeGreaterThan(0);
  });

  it('reports relevant catalog strings and skips others', async () => {
    const r = await scanSource([FIXTURE], { testIdAttribute: 'data-testid' });
    const keys = r.ui_strings.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['cart.title', 'checkout.pay', 'checkout.guest']));
    expect(keys).not.toContain('footer.about');
    expect(keys).not.toContain('login.password');
    expect(r.ui_strings.find((s) => s.key === 'cart.title')).toMatchObject({
      text: 'Sepetim',
      file: 'locales/tr.json',
    });
  });

  it('skips .env, node_modules, and the symlink, and leaks no secret', async () => {
    const r = await scanSource([FIXTURE], { testIdAttribute: 'data-testid' });
    expect(JSON.stringify(r)).not.toContain('FAKE_SECRET_VALUE');
    expect(r.routes.every((x) => !x.file.includes('node_modules'))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('tmp-link');
    expect(r.stats.skipped).toBeGreaterThan(0);
  });

  it('stops at maxFiles with a warning', async () => {
    const r = await scanSource([FIXTURE], { testIdAttribute: 'data-testid', maxFiles: 3 });
    expect(r.stats.truncated).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/stopped after 3 files/);
  });

  it('stops at the time limit with a warning', async () => {
    const r = await scanSource([FIXTURE], { testIdAttribute: 'data-testid', maxMs: -1 });
    expect(r.stats.truncated).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/stopped after the time limit of -1 ms/);
  });

  describe('temp trees', () => {
    let dir: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
      const w = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
      };
      w('pages/index.vue', '<template><i /></template>');
      w('pages/urun/[id].vue', '<template><i /></template>');
      w('app/routes/_index.tsx', 'export default 1;');
      w('app/routes/cart.checkout.tsx', 'export default 1;');
      w('app/routes/products.$id.tsx', 'export default 1;');
      w('templates/cart.liquid', '{{ cart }}');
      w('templates/product.json', '{}');
      w(
        'src/a.tsx',
        '<a data-qa="buy-now" /> <b data-qa={"two"} />\n<p>Bearer abcdefghijklmnop12</p>\nconst token = "password: hunter22";\n',
      );
      w(
        'i18n/en.ts',
        'export default {\n  checkout: "Proceed to checkout",\n  footer: "Contact",\n  password: "Password: abc",\n};\n',
      );
      fs.writeFileSync(path.join(dir, 'bin.tsx'), Buffer.from([65, 0, 66]));
      fs.writeFileSync(path.join(dir, 'big.tsx'), 'x'.repeat(600 * 1024));
      fs.symlinkSync(path.join(dir, 'src/a.tsx'), path.join(dir, 'src/link.tsx'));
    });
    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('maps Nuxt, Remix, and Shopify routes', async () => {
      const r = await scanSource([dir], { testIdAttribute: 'data-qa' });
      const paths = r.routes.map((x) => x.path);
      expect(paths).toEqual(
        expect.arrayContaining(['/', '/urun/[id]', '/cart/checkout', '/products/:id', '/cart']),
      );
      expect(paths).toContain('/products/:handle');
    });

    it('reads a custom test id attribute, skips secrets, binary, big files and links', async () => {
      const r = await scanSource([dir], { testIdAttribute: 'data-qa' });
      expect(r.test_ids.map((t) => t.value)).toEqual(expect.arrayContaining(['buy-now', 'two']));
      expect(r.test_ids.filter((t) => t.value === 'buy-now')).toHaveLength(1);
      expect(JSON.stringify(r)).not.toMatch(/hunter22|abcdefghijklmnop12|Password: abc/);
      expect(r.ui_strings.map((s) => s.key)).toContain('checkout');
      expect(r.ui_strings.map((s) => s.key)).not.toContain('footer');
    });
  });
});
