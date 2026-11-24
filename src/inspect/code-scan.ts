import fs from 'node:fs';
import path from 'node:path';
import { redactText } from '../safety/redact-text.js';
import { looksLikeSecret, SECRET_KEYWORDS, STRONG_SECRET_WORDS } from '../safety/secrets.js';
import { providerForPackage } from '../safety/test-cards.js';
import { matchesKind, type WordKind } from './words.js';

export interface Evidence {
  name: string;
  reason: string;
  file: string;
}

export interface CodeReport {
  frameworks: Evidence[];
  routes: { path: string; file: string }[];
  ui_strings: { key: string; text: string; file: string; line: number }[];
  test_ids: { value: string; file: string; line: number }[];
  payment_hints: { provider: string | null; package: string; file: string }[];
  otp_hints: { text: string; file: string; line: number }[];
  stats: { files: number; skipped: number; truncated: boolean };
  warnings: string[];
}

export interface ScanOptions {
  words?: Partial<Record<WordKind, string[]>>;
  maxFiles?: number;
  maxMs?: number;
  testIdAttribute: string;
}

const LIST_CAP = 500;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINE_CHARS = 2000;
const MAX_TEXT_CHARS = 300;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.nuxt', 'coverage', 'vendor']);
const CODE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.liquid',
  '.html',
  '.erb',
  '.php',
  '.mdx',
]);
const LOCALE_DIRS = new Set([
  'locales',
  'locale',
  'i18n',
  'lang',
  'languages',
  'messages',
  'translations',
  'intl',
]);
const LOCALE_FILE = /^[a-z]{2,3}([-_][A-Za-z]{2,4})?(\.default)?\.(json|ts|js|mjs)$/;
const FRAMEWORK_PACKAGES: [RegExp, string][] = [
  [/^next$/, 'next'],
  [/^nuxt(3)?$/, 'nuxt'],
  [/^(remix|@remix-run\/.+|@react-router\/.+)$/, 'remix'],
  [/^@shopify\/hydrogen$/, 'hydrogen'],
  [/^astro$/, 'astro'],
  [/^gatsby$/, 'gatsby'],
  [/^@sveltejs\/kit$/, 'sveltekit'],
  [/^vue$/, 'vue'],
  [/^react$/, 'react'],
  [/^@angular\/core$/, 'angular'],
];
const PAYMENT_NAME = /pay|checkout|stripe|adyen|braintree|klarna|iyzi|paytr/i;
const KEY_WORDS = /(?<![a-z0-9])(cart|checkout|payment|card|address|otp|terms|basket|order)s?(?![a-z0-9])/;
const RELEVANT_KINDS: WordKind[] = [
  'cart',
  'checkout',
  'add_to_cart',
  'guest',
  'login',
  'terms',
  'success',
  'decline',
];
const OTP_WORDS =
  /(?<![a-z])(otp|one time (code|pass\w*)|sms code|send code|verify code|verification code|doğrulama kodu)(?![a-z])/;
const KV_LINE = /(?:^|[\s{,])["']?([\w.-]+)["']?\s*:\s*(["'`])((?:\\.|(?!\2).)*)\2/g;

function words(s: string): string {
  return s
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_.\-/]+/g, ' ')
    .toLowerCase();
}

export async function scanSource(dirs: string[], opts: ScanOptions): Promise<CodeReport> {
  const maxFiles = opts.maxFiles ?? 20000;
  const maxMs = opts.maxMs ?? 30000;
  const start = Date.now();
  const report: CodeReport = {
    frameworks: [],
    routes: [],
    ui_strings: [],
    test_ids: [],
    payment_hints: [],
    otp_hints: [],
    stats: { files: 0, skipped: 0, truncated: false },
    warnings: [],
  };
  const capped = new Set<string>();
  const add = <K extends 'routes' | 'ui_strings' | 'test_ids' | 'payment_hints' | 'otp_hints'>(
    list: K,
    item: CodeReport[K][number],
  ): void => {
    const target = report[list] as unknown[];
    if (target.length >= LIST_CAP) {
      if (!capped.has(list)) {
        capped.add(list);
        report.warnings.push(`the list ${list} stopped at ${LIST_CAP} entries`);
      }
      return;
    }
    target.push(item);
  };
  const testIdRe = new RegExp(
    `${opts.testIdAttribute.replace(/[.*+?^${'$'}{}()|[\\]\\\\]/g, '\\$&')}\\s*=\\s*\\{?\\s*(["'\`])([^"'\`]{1,200})\\1`,
    'g',
  );
  const seenTestIds = new Set<string>();
  const seenFrameworks = new Set<string>();
  const clean = (s: string): string => redactText(s.trim().slice(0, MAX_TEXT_CHARS));

  const stop = (): boolean => {
    if (report.stats.truncated) return true;
    if (Date.now() - start >= maxMs) {
      report.stats.truncated = true;
      report.warnings.push(`stopped after the time limit of ${maxMs} ms`);
      return true;
    }
    return false;
  };

  async function readText(abs: string, size: number): Promise<string | undefined> {
    if (size > MAX_FILE_BYTES) return undefined;
    const buf = await fs.promises.readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) return undefined;
    return buf.toString('utf8');
  }

  function routeFor(parts: string[]): string | undefined {
    const file = parts[parts.length - 1] as string;
    const ext = path.extname(file);
    const base = file.slice(0, file.length - ext.length);
    const dirsOnly = parts.slice(0, -1);
    const routesAt = dirsOnly.lastIndexOf('routes');
    if (routesAt > 0 && dirsOnly[routesAt - 1] === 'app' && CODE_EXTS.has(ext)) {
      // Remix flat routes: dots split segments, "_index" is the index, "_layout" prefixes drop out.
      const segs = base
        .split('.')
        .filter((s) => s !== '_index' && !s.startsWith('_'))
        .map((s) => (s.startsWith('$') ? `:${s.slice(1)}` : s));
      return `/${segs.join('/')}`;
    }
    const appAt = dirsOnly.indexOf('app');
    if (appAt >= 0 && /^page$/.test(base) && CODE_EXTS.has(ext)) {
      const segs = dirsOnly.slice(appAt + 1).filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
      return `/${segs.join('/')}`;
    }
    const pagesAt = dirsOnly.indexOf('pages');
    if (pagesAt >= 0 && CODE_EXTS.has(ext) && !base.startsWith('_')) {
      const segs = dirsOnly.slice(pagesAt + 1);
      if (segs[0] === 'api') return undefined;
      if (base !== 'index') segs.push(base);
      return `/${segs.join('/')}`;
    }
    const tplAt = dirsOnly.indexOf('templates');
    if (tplAt >= 0 && (ext === '.liquid' || ext === '.json')) {
      const name = base.split('.')[0] as string;
      const known: Record<string, string> = {
        index: '/',
        product: '/products/:handle',
        collection: '/collections/:handle',
        page: '/pages/:handle',
      };
      return known[name] ?? `/${name}`;
    }
    return undefined;
  }

  function scanCatalogJson(text: string, file: string): void {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const lines = text.split('\n');
    let cursor = 0;
    const walk = (node: unknown, prefix: string, depth: number): void => {
      if (depth > 8 || !node || typeof node !== 'object' || Array.isArray(node)) return;
      for (const [k, v] of Object.entries(node)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'string') {
          let line = cursor;
          while (line < lines.length && !(lines[line] as string).includes(`"${k}"`)) line++;
          const found = line < lines.length;
          if (found) cursor = line;
          considerString(key, v, file, found ? line + 1 : 1);
        } else {
          walk(v, key, depth + 1);
        }
      }
    };
    walk(data, '', 0);
  }

  function relevantString(key: string, text: string): boolean {
    const k = words(key);
    if (KEY_WORDS.test(k)) return true;
    for (const t of [k, text]) {
      if (matchesKind('pay', t, opts.words)) return true;
      if (RELEVANT_KINDS.some((kind) => matchesKind(kind, t, opts.words))) return true;
    }
    return false;
  }

  function considerString(key: string, text: string, file: string, line: number): void {
    // Fail closed: a key and text pair that looks like a secret assignment is not reported.
    // A label such as "Password" stays. A single-token value under a secret key does not.
    if (looksLikeSecret(text)) return;
    if (SECRET_KEYWORDS.test(key) && !STRONG_SECRET_WORDS.test(text) && looksLikeSecret(`${key}: ${text}`))
      return;
    if (!relevantString(key, text)) return;
    add('ui_strings', { key, text: clean(text), file, line });
  }

  function scanCode(text: string, file: string, isCatalog: boolean): void {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.length > MAX_LINE_CHARS || line.length === 0) continue;
      testIdRe.lastIndex = 0;
      for (let m = testIdRe.exec(line); m; m = testIdRe.exec(line)) {
        const value = m[2] as string;
        const id = `${file}:${value}`;
        if (looksLikeSecret(value) || seenTestIds.has(id)) continue;
        seenTestIds.add(id);
        add('test_ids', { value: redactText(value), file, line: i + 1 });
      }
      if (OTP_WORDS.test(words(line)) && !looksLikeSecret(line))
        add('otp_hints', { text: clean(line), file, line: i + 1 });
      if (isCatalog) {
        KV_LINE.lastIndex = 0;
        for (let m = KV_LINE.exec(line); m; m = KV_LINE.exec(line)) {
          const value = m[3] as string;
          if (value.includes('${')) continue;
          considerString(m[1] as string, value, file, i + 1);
        }
      }
    }
  }

  function scanPackageJson(text: string, file: string): void {
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(text);
    } catch {
      return;
    }
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    for (const name of names) {
      for (const [re, fw] of FRAMEWORK_PACKAGES) {
        if (re.test(name) && !seenFrameworks.has(fw)) {
          seenFrameworks.add(fw);
          report.frameworks.push({ name: fw, reason: `dependency "${name}" in package.json`, file });
        }
      }
      const provider = providerForPackage(name);
      if (provider || PAYMENT_NAME.test(name)) {
        add('payment_hints', { provider: provider ?? null, package: name, file });
      }
    }
  }

  async function walk(root: string, relDir: string, label: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      report.warnings.push(`could not read the folder ${label || path.basename(root)}`);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (report.stats.truncated) return;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(root, rel);
      const shown = label ? `${label}/${rel}` : rel;
      if (entry.isSymbolicLink()) {
        report.stats.skipped++;
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) report.stats.skipped++;
        else await walk(root, rel, label);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      const isPkg = entry.name === 'package.json';
      const isJson = ext === '.json';
      if (entry.name.startsWith('.env') || !(CODE_EXTS.has(ext) || isJson || ext === '.mjs')) {
        report.stats.skipped++;
        continue;
      }
      const parts = rel.split('/');
      const inLocaleDir = parts.slice(0, -1).some((p) => LOCALE_DIRS.has(p.toLowerCase()));
      const isCatalog =
        !isPkg && (inLocaleDir || LOCALE_FILE.test(entry.name)) && (isJson || CODE_EXTS.has(ext));
      if (isJson && !isPkg && !isCatalog && !routeFor(parts)) {
        report.stats.skipped++;
        continue;
      }
      if (stop()) return;
      if (report.stats.files >= maxFiles) {
        report.stats.truncated = true;
        report.warnings.push(`stopped after ${maxFiles} files`);
        return;
      }
      let st: fs.Stats;
      try {
        st = await fs.promises.lstat(abs);
      } catch {
        report.stats.skipped++;
        continue;
      }
      if (!st.isFile()) {
        report.stats.skipped++;
        continue;
      }
      report.stats.files++;
      const route = routeFor(parts);
      if (route !== undefined) add('routes', { path: route, file: shown });
      if (!isPkg && !isCatalog && !CODE_EXTS.has(ext)) continue;
      let text: string | undefined;
      try {
        text = await readText(abs, st.size);
      } catch {
        text = undefined;
      }
      if (text === undefined) {
        report.stats.skipped++;
        continue;
      }
      if (isPkg) scanPackageJson(text, shown);
      else if (isCatalog && isJson) scanCatalogJson(text, shown);
      else scanCode(text, shown, isCatalog);
    }
  }

  const multi = dirs.length > 1;
  for (const dir of dirs) {
    if (report.stats.truncated) break;
    await walk(path.resolve(dir), '', multi ? path.basename(dir) : '');
  }
  if (
    fs.existsSync(path.join(dirs[0] ?? '', 'layout', 'theme.liquid')) &&
    !seenFrameworks.has('shopify-theme')
  ) {
    report.frameworks.push({
      name: 'shopify-theme',
      reason: 'layout/theme.liquid exists',
      file: 'layout/theme.liquid',
    });
  }
  return report;
}
