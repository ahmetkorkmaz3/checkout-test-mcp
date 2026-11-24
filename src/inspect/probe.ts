import { randomBytes } from 'node:crypto';
import type { BrowserContext, Frame, Locator, Page } from 'playwright';
import { hostOf } from '../safety/hosts.js';
import { redactText } from '../safety/redact-text.js';
import type { InspectConfig, TargetConfig } from '../schemas/config.js';
import {
  type ActionLog,
  type ActionResult,
  type ClickKind,
  CONTINUE,
  guardedClick,
  guardedFill,
  guardedKey,
  guardedSelect,
  hasBlockedFrame,
  hasCardFields,
  isPaymentFrame,
} from './actions.js';
import { accessibleName, type PageSnapshot, rejectCookieBanner } from './crawl.js';
import { guessPageKind, type PageKind } from './page-kind.js';
import { matchesKind, type WordKind } from './words.js';

export interface ProbeStep {
  action: string;
  page_kind: PageKind;
  url_path: string;
  result: 'done' | 'skipped';
}

/** An iframe on the payment page that holds card fields, or a payment frame that the guard blocked. */
export interface CardFrame {
  host: string;
  title: string;
  name?: string;
}

/** A card input. Labels only, never a value. */
export interface CardField {
  label?: string;
  placeholder?: string;
  autocomplete?: string;
  in_frame: boolean;
}

export interface ProbePayment {
  methods: string[];
  card_form: boolean;
  card_iframe_hosts: string[];
  /** Read from the iframe element on the parent page, so a frame on a blocked host is listed too. */
  card_frames: CardFrame[];
  /** Inline card fields, and fields in card frames on allowed hosts. */
  card_fields: CardField[];
  test_card_select: { label: string; options: string[] } | null;
  agreement_checkbox: string | null;
  pay_button: string | null;
}

export interface ProbeResult {
  reached: 'none' | 'product' | 'cart' | 'checkout' | 'payment';
  stopped_reason:
    | 'payment_step_reached'
    | 'login_required'
    | 'no_product'
    | 'no_add_to_cart'
    | 'no_checkout_button'
    | 'form_not_understood'
    | 'timeout'
    | 'blocked_by_safety'
    | 'verification_required';
  steps: ProbeStep[];
  /** Native dialogs and dialog elements that opened, by name or first line of text, redacted. */
  dialogs: string[];
  guest_option: boolean;
  payment: ProbePayment | null;
  /** What the probe made on the test site. The guest email appears here and nowhere else. */
  side_effects: string[];
}

export interface ProbeContext {
  context: BrowserContext;
  target: TargetConfig;
  inspect: InspectConfig;
  signal: AbortSignal;
  onProgress(msg: string): void;
  /** Pages from the crawl. The probe uses the first product page and the first cart page. */
  pages?: PageSnapshot[];
}

export const PROBE_LIMITS = {
  totalMs: 120_000,
  formTries: 3,
  flowSteps: 8,
  fieldsPerForm: 40,
  candidates: 200,
  cardFrames: 20,
  cardFields: 20,
  options: 50,
  methods: 20,
  dialogs: 20,
} as const;

const NAV_TIMEOUT_MS = 15_000;
const IDLE_TIMEOUT_MS = 5_000;
const ENABLE_WAIT_MS = 5_000;

type StopReason = ProbeResult['stopped_reason'];
type Words = Partial<Record<WordKind, string[]>>;

class ProbeStop extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}

const clean = (s: string | null | undefined): string =>
  redactText((s ?? '').replace(/\s+/g, ' ').trim()).slice(0, 120);

/**
 * Page text that says the step sends a code to the phone. With a phone field on the page,
 * the probe stops before it clicks to go on.
 */
const VERIFY_TEXT =
  /(?<![\p{L}\p{N}])(sms ile doğrulama|sms doğrulama|sms kodu|sms code|otp kodu|otp code|doğrulama kodu|onay kodu|kod gönder|tek kullanımlık|verification code|send code|one-time code|código de verificación|code de vérification|bestätigungscode|verificatiecode|codice di verifica)(?![\p{L}\p{N}])/iu;
/** Option and select texts that are a prompt, not a choice. */
const PLACEHOLDER =
  /^\s*$|^[-–—\s]+$|(select|choose|please|seçiniz|seçin|bitte wählen|auswählen|choisir|sélectionner|selecciona|elegir|seleziona|scegli|kies|selecteer)/iu;
const TEST_CARD =
  /(test\s*-?\s*(kart|card|karte|carte|tarjeta|carta|kaart)|carte de test|tarjeta de prueba|carta di test)/iu;

type FieldKind =
  | 'email'
  | 'phone'
  | 'full_name'
  | 'given_name'
  | 'family_name'
  | 'postcode'
  | 'address'
  | 'city'
  | 'title';

/** Fictional values. The guest email comes from guestEmail(). The phone comes from phoneValue(). */
const VALUES: Record<Exclude<FieldKind, 'email' | 'phone' | 'postcode'>, string> = {
  full_name: 'Test Inspect',
  given_name: 'Test',
  family_name: 'Inspect',
  address: 'Test Street 1',
  city: 'Test City',
  title: 'Test',
};

const KIND_BY_AUTOCOMPLETE: [RegExp, FieldKind][] = [
  [/\bemail\b/, 'email'],
  [/\btel(-national)?\b/, 'phone'],
  [/\bgiven-name\b/, 'given_name'],
  [/\bfamily-name\b/, 'family_name'],
  [/\bname\b/, 'full_name'],
  [/\bpostal-code\b/, 'postcode'],
  [/\b(street-address|address-line1)\b/, 'address'],
  [/\baddress-level2\b/, 'city'],
];

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
/** Stems match at the start of a word, so "Telefonu" matches "telefon". Whole words match alone. */
function labelRe(stems: string[], whole: string[] = []): RegExp {
  const parts = [...stems.map((w) => `${B}(?:${w})`), ...whole.map((w) => `${B}(?:${w})${E}`)];
  return new RegExp(parts.join('|'), 'iu');
}

// Order matters: "Ad Soyad" is a full name, "Soyad" alone is a family name, and "Adres başlığı"
// is the name of the address, not the address.
const KIND_BY_LABEL: [RegExp, FieldKind][] = [
  [labelRe(['e-?mail', 'e-?posta', 'courriel', 'correo']), 'email'],
  [
    labelRe(
      ['phone', 'telefon', 'téléphone', 'teléfono', 'telefono', 'telefoon', 'mobile', 'handy'],
      ['gsm', 'cep', 'tel'],
    ),
    'phone',
  ],
  [
    labelRe([
      'full\\s*name',
      'ad\\s*soyad',
      'adı\\s*soyadı',
      'isim\\s*soyisim',
      'name and surname',
      'vollständiger name',
      'nom complet',
      'nombre completo',
      'nome completo',
      'volledige naam',
    ]),
    'full_name',
  ],
  [
    labelRe([
      'last\\s*name',
      'surname',
      'family\\s*name',
      'soyad',
      'soyisim',
      'nachname',
      'nom de famille',
      'apellido',
      'cognome',
      'achternaam',
    ]),
    'family_name',
  ],
  [
    labelRe(
      ['first\\s*name', 'given\\s*name', 'vorname', 'prénom', 'voornaam'],
      ['ad', 'adı', 'adınız', 'isim', 'nombre', 'nome'],
    ),
    'given_name',
  ],
  [labelRe(['başlı[gğ]', 'address title', 'bezeichnung']), 'title'],
  [
    labelRe(
      [
        'post\\s*code',
        'postal',
        'posta kodu',
        'postleitzahl',
        'code postal',
        'código postal',
        'codice postale',
      ],
      ['zip', 'zip\\s*code', 'plz', 'cap'],
    ),
    'postcode',
  ],
  [
    labelRe(
      ['address', 'adres', 'street', 'straße', 'strasse', 'dirección', 'direccion', 'indirizzo'],
      ['rue'],
    ),
    'address',
  ],
  [labelRe(['şehir'], ['city', '[iİ]l', 'stadt', 'ville', 'ciudad', 'città', 'stad', 'town']), 'city'],
  [labelRe([], ['name', 'nom', 'naam']), 'full_name'],
];

interface FieldInfo {
  index: number;
  tag: string;
  type: string;
  role: string;
  label: string;
  key: string;
  autocomplete: string;
  placeholder: string;
  maxlength: number;
  pattern: string;
  value: string;
  visible: boolean;
  disabled: boolean;
  options: { text: string; value: string; disabled: boolean }[] | null;
  selectedIndex: number;
}

const FIELD_SELECTOR = 'input, select, textarea, [role="combobox"]';
const SKIP_TYPES = new Set([
  'hidden',
  'submit',
  'button',
  'reset',
  'image',
  'file',
  'checkbox',
  'radio',
  'range',
  'color',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
  'password',
  'search',
]);

/** Makes a guest email on a reserved test domain. */
export function guestEmail(): string {
  return `inspect-${randomBytes(4).toString('hex')}@example.test`;
}

/** Digits only. The count comes from the field. The default is 10 digits that start with "555". */
export function phoneValue(field: { maxlength: number; pattern: string; placeholder: string }): string {
  let n = 0;
  const quantified = /(?:\\d|\[0-9\])\{(\d+)(?:,\d*)?\}/.exec(field.pattern);
  if (quantified?.[1]) n = Number(quantified[1]);
  if (!n && /^[\s\d()+\-_.xX#*]+$/.test(field.placeholder)) {
    const slots = field.placeholder.replace(/[^\dxX#_*]/g, '').length;
    if (slots >= 7) n = slots;
  }
  if (!n && field.maxlength >= 7 && field.maxlength <= 15) n = field.maxlength;
  if (!n || n < 7 || n > 15) n = 10;
  return '555'.padEnd(n, '0');
}

/** The first example that the pattern attribute allows, when it is all digits, else "34000". */
export function postcodeValue(field: { maxlength: number; pattern: string }): string {
  const m = /^\^?(?:\\d|\[0-9\])\{(\d+)\}\$?$/.exec(field.pattern);
  if (m?.[1]) return '3'.padEnd(Number(m[1]), '0');
  if (field.maxlength > 0 && field.maxlength < 5) return '3'.padEnd(field.maxlength, '0');
  return '34000';
}

export function fieldKind(f: Pick<FieldInfo, 'type' | 'autocomplete' | 'label'>): FieldKind | null {
  if (f.type === 'email') return 'email';
  if (f.type === 'tel') return 'phone';
  for (const [re, kind] of KIND_BY_AUTOCOMPLETE) if (re.test(f.autocomplete.toLowerCase())) return kind;
  for (const [re, kind] of KIND_BY_LABEL) if (re.test(f.label.normalize('NFC'))) return kind;
  return null;
}

async function readFields(page: Page): Promise<FieldInfo[]> {
  return page
    .locator(FIELD_SELECTOR)
    .evaluateAll(
      (els, max) =>
        els.slice(0, max.fields).map((el, index) => {
          const e = el as HTMLInputElement & HTMLSelectElement;
          const tag = el.tagName.toLowerCase();
          const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ');
          const forLabel = el.id
            ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent
            : '';
          const label =
            e.labels?.[0]?.textContent ||
            el.getAttribute('aria-label') ||
            labelledBy ||
            forLabel ||
            el.getAttribute('placeholder') ||
            el.getAttribute('name') ||
            '';
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const isSelect = tag === 'select';
          return {
            index,
            tag,
            type: tag === 'input' ? e.type.toLowerCase() : tag,
            role: el.getAttribute('role') ?? '',
            label,
            key: `${tag}|${el.id}|${el.getAttribute('name') ?? ''}|${label}`,
            autocomplete: el.getAttribute('autocomplete') ?? '',
            placeholder: el.getAttribute('placeholder') ?? '',
            maxlength: Number(el.getAttribute('maxlength') ?? 0) || 0,
            pattern: el.getAttribute('pattern') ?? '',
            value:
              tag === 'input' || tag === 'textarea' || isSelect ? (e.value ?? '') : (el.textContent ?? ''),
            visible:
              rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
            disabled:
              (e as HTMLInputElement).disabled === true ||
              el.getAttribute('aria-disabled') === 'true' ||
              el.hasAttribute('readonly'),
            options: isSelect
              ? Array.from(e.options)
                  .slice(0, max.options)
                  .map((o) => ({ text: o.textContent ?? '', value: o.value, disabled: o.disabled }))
              : null,
            selectedIndex: isSelect ? e.selectedIndex : -1,
          };
        }),
      { fields: PROBE_LIMITS.fieldsPerForm * 3, options: PROBE_LIMITS.options },
    )
    .catch(() => [] as FieldInfo[]);
}

function isCustomCombobox(f: FieldInfo): boolean {
  return f.role === 'combobox' && f.tag !== 'select' && f.tag !== 'input' && f.tag !== 'textarea';
}

function isFillable(f: FieldInfo): boolean {
  if (f.tag === 'select' || isCustomCombobox(f)) return true;
  return !SKIP_TYPES.has(f.type);
}

function needsValue(f: FieldInfo): boolean {
  if (f.tag === 'select') {
    const chosen = f.options?.[f.selectedIndex];
    return !chosen || chosen.value === '' || PLACEHOLDER.test(chosen.text);
  }
  if (isCustomCombobox(f)) return f.value.trim() === '' || PLACEHOLDER.test(f.value);
  return f.value === '';
}

function firstRealOption(options: { text: string; value: string; disabled: boolean }[]): number {
  return options.findIndex((o) => !o.disabled && o.value !== '' && !PLACEHOLDER.test(o.text));
}

interface PageFacts {
  title: string;
  headings: string[];
  buttons: string[];
  passwordVisible: boolean;
}

async function pageFacts(page: Page): Promise<PageFacts> {
  return (
    page
      // No named helper inside evaluate: tsx adds a __name() call to it, and the page has no __name.
      .evaluate((max) => {
        return {
          title: document.title,
          headings: Array.from(document.querySelectorAll('h1, h2, h3'))
            .slice(0, 20)
            .map((h) => h.textContent ?? ''),
          buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit" i]'))
            .slice(0, max)
            .map((b) => (b as HTMLInputElement).value || b.textContent || b.getAttribute('aria-label') || ''),
          passwordVisible: Array.from(document.querySelectorAll('input[type="password" i]')).some((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }),
        };
      }, PROBE_LIMITS.candidates)
      .catch(() => ({ title: '', headings: [], buttons: [], passwordVisible: false }))
  );
}

function urlPath(page: Page): string {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return '';
  }
}

async function kindOf(page: Page): Promise<PageKind> {
  const facts = await pageFacts(page);
  return guessPageKind({
    path: urlPath(page),
    title: facts.title,
    headings: facts.headings,
    buttons: facts.buttons,
    hasPasswordField: facts.passwordVisible,
    hasCardFields: await hasCardFields(page),
  }).kind;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(200);
}

/** Visible elements of the given roles whose accessible name is of one word kind. */
async function findByKind(
  page: Page,
  roles: ('button' | 'link' | 'radio' | 'tab')[],
  test: (name: string) => boolean,
): Promise<{ loc: Locator; name: string }[]> {
  const out: { loc: Locator; name: string }[] = [];
  for (const role of roles) {
    for (const loc of (await page.getByRole(role).all()).slice(0, PROBE_LIMITS.candidates)) {
      const name = await accessibleName(loc);
      if (!name || !test(name)) continue;
      if (!(await loc.isVisible().catch(() => false))) continue;
      out.push({ loc, name });
    }
  }
  return out;
}

function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

class Probe {
  readonly result: ProbeResult = {
    reached: 'none',
    stopped_reason: 'timeout',
    steps: [],
    guest_option: false,
    payment: null,
    side_effects: [],
    dialogs: [],
  };
  private readonly words: Words;
  private email: string | null = null;
  /** True after the guard refused an action. The stop reason is then blocked_by_safety. */
  private refused = false;
  /** True after a field of the address was filled in the current form. */
  private filledAddress = false;
  /** Dialogs that opened after a probe action. The next step entry writes them first. */
  private readonly pendingDialogs: string[] = [];
  /** URLs of frame loads that the host guard blocked, such as a card iframe on a provider host. */
  private readonly blockedFrames = new Set<string>();

  constructor(
    private readonly ctx: ProbeContext,
    private readonly page: Page,
    private readonly signal: AbortSignal,
  ) {
    this.words = ctx.inspect.words;
  }

  private pushStep(action: string, result: ProbeStep['result'], pageKind: PageKind, path: string): void {
    for (const d of this.pendingDialogs.splice(0)) {
      this.result.steps.push({
        action: clean(`dialog opened: ${d}`),
        page_kind: pageKind,
        url_path: path,
        result: 'done',
      });
    }
    const step: ProbeStep = { action: clean(action), page_kind: pageKind, url_path: path, result };
    this.result.steps.push(step);
    this.ctx.onProgress(`Probe: ${step.action} (${result}).`);
  }

  private async record(action: string, result: ProbeStep['result']): Promise<void> {
    this.pushStep(action, result, await kindOf(this.page), clean(urlPath(this.page)));
  }

  /**
   * Runs guarded actions and records each one as a step on the page where it started.
   * A refused action marks the probe as blocked by safety.
   */
  private async act<T>(fn: (log: ActionLog) => Promise<T>): Promise<T> {
    const pageKind = await kindOf(this.page);
    const path = clean(urlPath(this.page));
    const entries: [string, ActionResult][] = [];
    const out = await fn((action, result) => {
      entries.push([action, result]);
    });
    for (const [action, result] of entries) {
      if (result === 'refused') this.refused = true;
      this.pushStep(action, result === 'done' ? 'done' : 'skipped', pageKind, path);
    }
    return out;
  }

  /** Called for each native dialog. The page handler dismisses it. */
  noteNativeDialog(type: string, message: string): void {
    const text = clean(`${type}: ${(message.split('\n')[0] ?? '').trim()}`);
    this.addDialog(text, true);
  }

  /** Called for each blocked request. A blocked frame load can be a card iframe. */
  noteBlockedFrame(url: string): void {
    this.blockedFrames.add(url);
  }

  private addDialog(text: string, asStep: boolean): void {
    if (this.result.dialogs.length >= PROBE_LIMITS.dialogs || this.result.dialogs.includes(text)) return;
    this.result.dialogs.push(text);
    if (asStep) this.pendingDialogs.push(text);
  }

  /**
   * Records the visible dialog elements. Dialogs on a new page go to the list only. Dialogs that
   * open after a probe action also get a step entry.
   */
  private async noteDialogs(asStep: boolean): Promise<void> {
    const names = await this.page
      .locator('dialog[open], [role="dialog"], [role="alertdialog"]')
      .evaluateAll((els) =>
        els
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map((el) => {
            const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
            const name =
              el.getAttribute('aria-label') ||
              ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ') ||
              // biome-ignore lint/performance/useDomNodeTextContent: the first visible line needs the rendered text.
              ((el as HTMLElement).innerText ?? '').split('\n').find((l) => l.trim() !== '') ||
              '';
            return `${el.getAttribute('role') === 'alertdialog' ? 'alertdialog' : 'dialog'}: ${name.trim()}`;
          }),
      )
      .catch(() => [] as string[]);
    for (const n of names) this.addDialog(clean(n), asStep);
  }

  private check(): void {
    if (this.signal.aborted) throw new ProbeStop('timeout');
  }

  private addEffect(effect: string): void {
    if (!this.result.side_effects.includes(effect)) this.result.side_effects.push(effect);
  }

  private async goto(path: string): Promise<boolean> {
    this.check();
    let url: URL;
    try {
      url = new URL(path, this.ctx.target.base_url);
    } catch {
      return false;
    }
    // Paths come from the config or the crawl. They stay on the base host.
    if (url.host !== new URL(this.ctx.target.base_url).host) return false;
    try {
      await this.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch {
      return false;
    }
    await settle(this.page);
    await this.noteDialogs(false);
    return true;
  }

  private async click(loc: Locator, purpose: string, allow: ClickKind): Promise<ActionResult> {
    this.check();
    const r = await this.act((log) =>
      guardedClick(this.page, loc, {
        purpose,
        allow,
        words: this.words,
        log,
        blockedFrames: this.blockedFrames,
      }),
    );
    if (r === 'done') {
      await settle(this.page);
      await this.noteDialogs(true);
    }
    return r;
  }

  /** Clicks the first candidate that the guard allows. */
  private async clickFirst(
    cands: { loc: Locator; name: string }[],
    purpose: string,
    allow: ClickKind,
  ): Promise<ActionResult | null> {
    let last: ActionResult | null = null;
    for (const c of cands) {
      last = await this.click(c.loc, purpose, allow);
      if (last === 'done') return last;
    }
    return last;
  }

  async run(): Promise<void> {
    await this.openProduct();
    await this.openCart();
    await this.startCheckout();
    await this.checkoutFlow();
  }

  private async openProduct(): Promise<void> {
    const { inspect, pages } = this.ctx;
    const productPath = inspect.product_paths[0] ?? pages?.find((p) => p.kind === 'product')?.url_path;
    const paths = productPath ? [productPath] : inspect.start_paths;
    let cookieTried = false;
    for (const path of paths) {
      if (!(await this.goto(path))) continue;
      if (!cookieTried) {
        cookieTried = true;
        await this.act((log) => rejectCookieBanner(this.page, this.words, log));
      }
      const adds = await findByKind(this.page, ['button'], (n) => matchesKind('add_to_cart', n, this.words));
      if (adds.length === 0) {
        if (productPath) {
          await this.record('open product page', 'done');
          this.result.reached = 'product';
          throw new ProbeStop('no_add_to_cart');
        }
        continue;
      }
      await this.record('open product page', 'done');
      this.result.reached = 'product';
      const r = await this.clickFirst(adds, 'add to cart', 'add_to_cart');
      if (r !== 'done') throw new ProbeStop(r === 'refused' ? 'blocked_by_safety' : 'no_add_to_cart');
      this.addEffect('cart item');
      return;
    }
    throw new ProbeStop('no_product');
  }

  private async openCart(): Promise<void> {
    this.check();
    const carts = await findByKind(
      this.page,
      ['link', 'button'],
      (n) => matchesKind('cart', n, this.words) && !matchesKind('add_to_cart', n, this.words),
    );
    let opened = (await this.clickFirst(carts, 'open cart', 'cart')) === 'done';
    if (!opened) {
      const cartPage = this.ctx.pages?.find((p) => p.kind === 'cart');
      if (cartPage && (await this.goto(cartPage.url_path))) {
        await this.record('open cart page', 'done');
        opened = true;
      }
    }
    if (!opened) {
      await this.record('open cart (no cart link found)', 'skipped');
      return;
    }
    if ((await kindOf(this.page)) === 'cart') this.result.reached = 'cart';
  }

  private async startCheckout(): Promise<void> {
    this.check();
    const buttons = await findByKind(this.page, ['button', 'link'], (n) =>
      matchesKind('checkout', n, this.words),
    );
    const r = await this.clickFirst(buttons, 'go to checkout', 'checkout');
    if (r !== 'done') throw new ProbeStop(r === 'refused' ? 'blocked_by_safety' : 'no_checkout_button');
    this.result.reached = 'checkout';
  }

  private async checkoutFlow(): Promise<void> {
    let tries = 0;
    let lastSignature = '';
    for (let i = 0; i < PROBE_LIMITS.flowSteps; i++) {
      this.check();
      const page = this.page;
      const payButtons = await findByKind(page, ['button', 'link'], (n) => matchesKind('pay', n, this.words));
      if (await this.atPaymentStep(payButtons.length > 0)) {
        this.result.reached = 'payment';
        this.result.payment = await this.readPayment(payButtons[0]?.name ?? null);
        await this.record('read the payment step (no click)', 'done');
        this.addEffect('order draft at the payment step, when the site makes one');
        throw new ProbeStop('payment_step_reached');
      }

      const guests = await findByKind(page, ['button', 'link', 'radio', 'tab'], (n) =>
        matchesKind('guest', n, this.words),
      );
      if (guests.length > 0) {
        this.result.guest_option = true;
        const sig = `guest|${urlPath(page)}`;
        if (sig !== lastSignature) {
          lastSignature = sig;
          const r = await this.clickFirst(guests, 'continue as guest', 'guest');
          if (r === 'done') continue;
        }
      }

      if ((await pageFacts(page)).passwordVisible) {
        await this.record('stop at the sign-in form', 'skipped');
        throw new ProbeStop('login_required');
      }

      await this.stopForPhoneCode();
      const before = await this.signature();
      await this.fillForm();
      const next = await this.findContinue();
      if (!next) {
        await this.record('find a button that saves the form', 'skipped');
        throw new ProbeStop(this.refused ? 'blocked_by_safety' : 'form_not_understood');
      }
      await this.stopForPhoneCode();
      const r = await this.clickFirst([next], 'save and continue', 'continue');
      if (r === 'refused') throw new ProbeStop('blocked_by_safety');
      const after = await this.signature();
      if (r === 'done' && after !== before) {
        if (this.filledAddress) this.addEffect('address');
        this.filledAddress = false;
        tries = 0;
        continue;
      }
      tries++;
      if (tries >= PROBE_LIMITS.formTries) throw new ProbeStop('form_not_understood');
    }
    throw new ProbeStop('form_not_understood');
  }

  /**
   * The payment step has card fields in any frame, a frame that the host guard blocked, or a visible
   * terms checkbox. A pay button alone counts only when no empty field is left, because express
   * wallet buttons such as "Apple Pay" also show on the contact step.
   */
  private async atPaymentStep(hasPayButton: boolean): Promise<boolean> {
    if (await hasCardFields(this.page)) return true;
    if (await hasBlockedFrame(this.page, this.blockedFrames)) return true;
    const checkboxes = await this.page
      .locator('input[type="checkbox" i], [role="checkbox"]')
      .evaluateAll((els) =>
        els
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map(
            (el) =>
              (el as HTMLInputElement).labels?.[0]?.textContent ||
              el.getAttribute('aria-label') ||
              el.textContent ||
              '',
          ),
      )
      .catch(() => [] as string[]);
    if (checkboxes.some((t) => matchesKind('terms', t, this.words))) return true;
    if (!hasPayButton) return false;
    const fields = await readFields(this.page);
    return !fields.some((f) => f.visible && !f.disabled && isFillable(f) && needsValue(f));
  }

  /** Stops before a continue click when a page with a phone field says that it sends a code. */
  private async stopForPhoneCode(): Promise<void> {
    const fields = await readFields(this.page);
    if (!fields.some((f) => f.visible && fieldKind(f) === 'phone')) return;
    const text = await this.page
      // biome-ignore lint/performance/useDomNodeTextContent: hidden templates must not stop the probe.
      .evaluate(() => document.body?.innerText ?? '')
      .catch(() => '');
    if (!VERIFY_TEXT.test(text.normalize('NFC'))) return;
    await this.record('stop: the page sends a code to the phone', 'skipped');
    throw new ProbeStop('verification_required');
  }

  /** URL path and visible field labels. A change means the form went on to the next step. */
  private async signature(): Promise<string> {
    const fields = (await readFields(this.page)).filter((f) => f.visible && isFillable(f));
    return `${urlPath(this.page)}|${fields.map((f) => f.key).join(',')}`;
  }

  private async fillForm(): Promise<void> {
    const attempted = new Set<string>();
    for (let n = 0; n < PROBE_LIMITS.fieldsPerForm; n++) {
      this.check();
      let fields = await readFields(this.page);
      let next = fields.find((f) => f.visible && isFillable(f) && !attempted.has(f.key) && needsValue(f));
      if (!next) return;
      attempted.add(next.key);
      if (next.disabled) {
        // A dependent list, such as a district list, waits for the list before it.
        const key = next.key;
        const until = Date.now() + ENABLE_WAIT_MS;
        while (next?.disabled && Date.now() < until) {
          this.check();
          await this.page.waitForTimeout(250);
          fields = await readFields(this.page);
          next = fields.find((f) => f.key === key);
        }
        if (!next || next.disabled) continue;
      }
      await this.fillOne(next);
    }
  }

  private async fillOne(f: FieldInfo): Promise<void> {
    const loc = this.page.locator(FIELD_SELECTOR).nth(f.index);
    const label = clean(f.label) || 'unnamed';
    if (f.tag === 'select') {
      const i = firstRealOption(f.options ?? []);
      if (i < 0) return;
      const r = await this.act((log) =>
        guardedSelect(this.page, loc, i, { purpose: `choose the first option in "${label}"`, log }),
      );
      if (r === 'done') {
        this.filledAddress = true;
        await settle(this.page);
      }
      return;
    }
    if (isCustomCombobox(f)) {
      await this.chooseFromCombobox(loc, label);
      return;
    }
    const kind = fieldKind(f);
    if (!kind) {
      await this.record(`leave field "${label}" empty (unknown kind)`, 'skipped');
      return;
    }
    let value: string;
    if (kind === 'email') {
      this.email ??= guestEmail();
      value = this.email;
    } else if (kind === 'phone') value = phoneValue(f);
    else if (kind === 'postcode') value = postcodeValue(f);
    else value = VALUES[kind];
    const r = await this.act((log) =>
      guardedFill(this.page, loc, value, { purpose: `fill ${kind.replace('_', ' ')} field "${label}"`, log }),
    );
    if (r !== 'done') return;
    if (kind === 'email') this.addEffect(`guest account ${this.email}`);
    if (kind === 'address' || kind === 'postcode' || kind === 'city') this.filledAddress = true;
  }

  /** A custom list: open it, then click the first option that is not a prompt. */
  private async chooseFromCombobox(loc: Locator, label: string): Promise<void> {
    if ((await this.click(loc, `open the list "${label}"`, 'list')) !== 'done') return;
    const options = this.page.getByRole('option');
    await options
      .first()
      .waitFor({ state: 'visible', timeout: 2_000 })
      .catch(() => {});
    for (const opt of (await options.all()).slice(0, PROBE_LIMITS.options)) {
      if (!(await opt.isVisible().catch(() => false))) continue;
      if ((await opt.getAttribute('aria-disabled').catch(() => null)) === 'true') continue;
      const name = await accessibleName(opt);
      if (PLACEHOLDER.test(name)) continue;
      if ((await this.click(opt, `choose the first option in "${label}"`, 'list_option')) === 'done')
        this.filledAddress = true;
      return;
    }
    await this.act((log) => guardedKey(this.page, 'Escape', { purpose: `close the list "${label}"`, log }));
  }

  /** The submit button of the form with the most visible fields, else a visible continue button. */
  private async findContinue(): Promise<{ loc: Locator; name: string } | null> {
    const forms = await this.page
      .locator('form')
      .evaluateAll((els) =>
        els.map(
          (f) =>
            Array.from(f.querySelectorAll('input, select, textarea')).filter((e) => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            }).length,
        ),
      )
      .catch(() => [] as number[]);
    let best = -1;
    forms.forEach((n, i) => {
      if (n > 0 && (best < 0 || n > (forms[best] ?? 0))) best = i;
    });
    if (best >= 0) {
      const submits = this.page
        .locator('form')
        .nth(best)
        .locator('button[type="submit" i], button:not([type]), input[type="submit" i]');
      for (const loc of (await submits.all()).slice(0, 10)) {
        if (!(await loc.isVisible().catch(() => false))) continue;
        const name = await accessibleName(loc);
        // A nameless or unmatched submit button can place an order. The guard checks the name again.
        if (CONTINUE.test(name.normalize('NFC')) || matchesKind('checkout', name, this.words))
          return { loc, name };
      }
    }
    const buttons = await findByKind(
      this.page,
      ['button'],
      (n) => CONTINUE.test(n.normalize('NFC')) || matchesKind('checkout', n, this.words),
    );
    return buttons[0] ?? null;
  }

  /**
   * The card frames and the card field labels. A frame counts when it has card fields, or when the
   * guard blocked its URL and it looks like a payment frame. Field values are never read.
   */
  private async readCardForm(): Promise<{ frames: CardFrame[]; fields: CardField[] }> {
    const frames: CardFrame[] = [];
    const fields = await readCardFields(this.page.mainFrame(), false);
    const iframes = await this.page
      .locator('iframe')
      .elementHandles()
      .catch(() => []);
    for (const handle of iframes.slice(0, PROBE_LIMITS.cardFrames)) {
      const attrs = await handle
        .evaluate((el) => {
          const f = el as HTMLIFrameElement;
          return { src: f.src, title: f.getAttribute('title') ?? '', name: f.getAttribute('name') ?? '' };
        })
        .catch(() => null);
      if (!attrs) continue;
      let host = '';
      try {
        host = hostOf(attrs.src);
      } catch {
        continue;
      }
      const frame = await handle.contentFrame().catch(() => null);
      const inFrame = frame ? await readCardFields(frame, true) : [];
      const blockedPayment =
        this.blockedFrames.has(attrs.src) &&
        isPaymentFrame({ src: attrs.src, title: attrs.title, context: '' });
      if (inFrame.length === 0 && !blockedPayment) continue;
      const title = clean(attrs.title);
      const name = clean(attrs.name);
      frames.push({ host, title, ...(name ? { name } : {}) });
      fields.push(...inFrame);
    }
    return { frames, fields: fields.slice(0, PROBE_LIMITS.cardFields) };
  }

  private async readPayment(payButton: string | null): Promise<ProbePayment> {
    const page = this.page;
    const controls = await page
      .locator(
        'input[type="radio" i], [role="radio"], [role="tab"], input[type="checkbox" i], [role="checkbox"], select',
      )
      .evaluateAll(
        (els, max) =>
          els.slice(0, max.controls).map((el) => {
            const input = el as HTMLInputElement & HTMLSelectElement;
            const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
            const rect = el.getBoundingClientRect();
            const type = (el.getAttribute('type') ?? '').toLowerCase();
            const role = el.getAttribute('role') ?? '';
            return {
              group:
                el.tagName === 'SELECT'
                  ? 'select'
                  : type === 'checkbox' || role === 'checkbox'
                    ? 'checkbox'
                    : 'method',
              shown: rect.width > 0 && rect.height > 0,
              label:
                input.labels?.[0]?.textContent ||
                el.getAttribute('aria-label') ||
                ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ') ||
                (el.tagName === 'SELECT' ? '' : el.textContent) ||
                el.getAttribute('name') ||
                '',
              options:
                el.tagName === 'SELECT'
                  ? Array.from(input.options)
                      .slice(0, max.options)
                      .map((o) => ({ text: o.textContent ?? '', value: o.value }))
                  : [],
            };
          }),
        { controls: PROBE_LIMITS.candidates, options: PROBE_LIMITS.options },
      )
      .catch(() => []);
    const methods = controls.filter((c) => c.group === 'method' && c.shown).slice(0, PROBE_LIMITS.methods);
    const checkboxes = controls.filter((c) => c.group === 'checkbox').map((c) => c.label);
    const selects = controls.filter((c) => c.group === 'select');

    const hosts = new Set<string>();
    for (const frame of page.frames().slice(1)) {
      const n = await frame
        .locator('[autocomplete*="cc-" i]')
        .count()
        .catch(() => 0);
      if (n === 0) continue;
      try {
        hosts.add(hostOf(frame.url()));
      } catch {
        // A frame without a parsable URL has no host to report.
      }
    }

    const { frames: cardFrames, fields: cardFields } = await this.readCardForm();
    const testSelect = selects.find((s) => TEST_CARD.test(s.label.normalize('NFC')));
    const agreement = checkboxes.find((t) => matchesKind('terms', t, this.words));
    return {
      methods: methods.map((m) => clean(m.label)).filter(Boolean),
      card_form: await hasCardFields(page),
      card_iframe_hosts: [...hosts].filter(Boolean).sort(),
      card_frames: cardFrames,
      card_fields: cardFields,
      test_card_select: testSelect
        ? {
            label: clean(testSelect.label),
            options: testSelect.options
              .filter((o) => o.value !== '' && !PLACEHOLDER.test(o.text))
              .map((o) => clean(o.text)),
          }
        : null,
      agreement_checkbox: agreement ? clean(agreement) : null,
      pay_button: payButton ? clean(payButton) : null,
    };
  }
}

/**
 * Goes through the checkout of a test site with fictional data, up to the payment step.
 * It never clicks a pay button, a cookie accept button, or a send-code button.
 * Every click, fill, and select goes through src/inspect/actions.ts.
 * It stops after PROBE_LIMITS.totalMs or when the signal aborts.
 */
export async function probeCheckout(ctx: ProbeContext): Promise<ProbeResult> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(PROBE_LIMITS.totalMs)]);
  const page = await ctx.context.newPage();
  const probe = new Probe(ctx, page, signal);
  page.on('dialog', (d) => {
    probe.noteNativeDialog(d.type(), d.message());
    d.dismiss().catch(() => {});
  });
  page.on('requestfailed', (req) => {
    if (!req.isNavigationRequest() || req.failure()?.errorText !== 'net::ERR_BLOCKED_BY_CLIENT') return;
    let frame: ReturnType<typeof req.frame> | null = null;
    try {
      frame = req.frame();
    } catch {
      frame = null;
    }
    if (frame && frame !== page.mainFrame()) probe.noteBlockedFrame(req.url());
  });
  const work = probe.run().then(
    () => 'form_not_understood' as StopReason,
    (err: unknown) => {
      if (err instanceof ProbeStop) return err.reason;
      if (signal.aborted) return 'timeout' as StopReason;
      throw err;
    },
  );
  try {
    const reason = await Promise.race([work, abortPromise(signal).then(() => 'timeout' as StopReason)]);
    probe.result.stopped_reason = reason;
  } finally {
    // Closing the page ends any Playwright call that is still running after a timeout.
    work.catch(() => {});
    await page.close().catch(() => {});
  }
  // A copy: after a timeout, the work promise can still add a step before it ends.
  const result = structuredClone(probe.result);
  ctx.onProgress(`Probe stopped: ${result.stopped_reason}.`);
  return result;
}

/** Card input labels in one frame. Values are never read. */
async function readCardFields(frame: Frame, inFrame: boolean): Promise<CardField[]> {
  const raw = await frame
    .locator('input')
    .evaluateAll(
      (els, max) =>
        els
          .filter((el) => {
            const i = el as HTMLInputElement;
            const ac = (i.getAttribute('autocomplete') ?? '').toLowerCase();
            if (ac.startsWith('cc-')) return true;
            const hint = `${i.name} ${i.id} ${i.placeholder}`.toLowerCase();
            return /card.?number|cardnumber|\bcvc\b|\bcvv\b|expir|kart numaras|son kullanma/.test(hint);
          })
          .slice(0, max)
          .map((el) => {
            const i = el as HTMLInputElement;
            return {
              label: i.labels?.[0]?.textContent ?? i.getAttribute('aria-label') ?? '',
              placeholder: i.getAttribute('placeholder') ?? '',
              autocomplete: i.getAttribute('autocomplete') ?? '',
            };
          }),
      PROBE_LIMITS.cardFields,
    )
    .catch(() => [] as { label: string; placeholder: string; autocomplete: string }[]);
  return raw.map((r) => {
    const label = clean(r.label);
    const placeholder = clean(r.placeholder);
    const autocomplete = clean(r.autocomplete);
    return {
      ...(label ? { label } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(autocomplete ? { autocomplete } : {}),
      in_frame: inFrame,
    };
  });
}
