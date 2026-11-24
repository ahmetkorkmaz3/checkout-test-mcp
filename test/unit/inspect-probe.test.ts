import { describe, expect, it } from 'vitest';
import { type ClickFacts, type ClickKind, clickRefusal, fieldRefusal } from '../../src/inspect/actions.js';
import { fieldKind, guestEmail, phoneValue, postcodeValue } from '../../src/inspect/probe.js';

const click = (texts: string[], more: Partial<ClickFacts> = {}): ClickFacts => ({
  name: texts[0] ?? '',
  texts,
  role: 'button',
  otpOnPage: false,
  passwordInForm: false,
  ...more,
});

describe('clickRefusal', () => {
  it('allows step buttons whose name matches the step', () => {
    const cases: [string, ClickKind][] = [
      ['Add to cart', 'add_to_cart'],
      ['Sepetim', 'cart'],
      ['Checkout', 'checkout'],
      ['Continue as guest', 'guest'],
      ['Continue to payment', 'continue'],
      ['Kaydet ve Devam Et', 'continue'],
      ['Bu adresi kullan', 'continue'],
      ['Reject all', 'cookie_reject'],
    ];
    for (const [t, kind] of cases) expect(clickRefusal(click([t]), kind, {}), t).toBeNull();
    expect(clickRefusal(click(['İl'], { role: 'combobox' }), 'list', {})).toBeNull();
    expect(clickRefusal(click(['İstanbul'], { role: 'option' }), 'list_option', {})).toBeNull();
  });

  it('refuses an element without a name', () => {
    expect(clickRefusal(click([]), 'continue', {})).toMatch(/no name/);
  });

  it('refuses a name that does not match the step', () => {
    expect(clickRefusal(click(['Delete address']), 'continue', {})).toMatch(
      /does not match the step "continue"/,
    );
    expect(clickRefusal(click(['Checkout']), 'add_to_cart', {})).toMatch(
      /does not match the step "add_to_cart"/,
    );
    expect(clickRefusal(click(['Add to cart']), 'cart', {})).toMatch(/does not match the step "cart"/);
    expect(clickRefusal(click(['İl'], { role: 'button' }), 'list', {})).toMatch(
      /does not match the step "list"/,
    );
    expect(clickRefusal(click(['Adana'], { role: 'button' }), 'list_option', {})).toMatch(
      /does not match the step "list_option"/,
    );
  });

  it('refuses a pay button in any text of the element', () => {
    expect(clickRefusal(click(['Pay 349,00 TL']), 'continue', {})).toMatch(/pay/);
    expect(clickRefusal(click(['Continue', 'Buy now']), 'continue', {})).toMatch(/pay/);
    expect(clickRefusal(click(['Complete order'], { role: 'link' }), 'checkout', {})).toMatch(/pay/);
    expect(clickRefusal(click(['Devam']), 'continue', { pay: ['devam'] })).toMatch(/pay/);
  });

  it('refuses a cookie accept button', () => {
    expect(clickRefusal(click(['Accept all']), 'cookie_reject', {})).toMatch(/cookies/);
    expect(clickRefusal(click(['Tümünü kabul et']), 'cookie_reject', {})).toMatch(/cookies/);
  });

  it('refuses a send-code or verify button', () => {
    for (const t of ['Send code', 'Kod gönder', 'Resend', 'Verify', 'SMS ile doğrula', 'Code anfordern']) {
      expect(clickRefusal(click([t]), 'continue', {}), t).toMatch(/code/);
    }
  });

  it('refuses any click on a page with a one-time code field', () => {
    expect(clickRefusal(click(['Continue'], { otpOnPage: true }), 'continue', {})).toMatch(/one-time code/);
  });

  it('refuses to submit a form with a password field', () => {
    expect(clickRefusal(click(['Continue'], { passwordInForm: true }), 'continue', {})).toMatch(/password/);
  });
});

describe('fieldRefusal', () => {
  const field = (type: string, autocomplete = '', texts: string[] = ['Name']) => ({
    type,
    autocomplete,
    texts,
  });

  it('allows address fields', () => {
    expect(fieldRefusal(field('text', 'name'))).toBeNull();
    expect(fieldRefusal(field('tel', 'tel', ['Phone']))).toBeNull();
    expect(fieldRefusal(field('select', '', ['City']))).toBeNull();
  });

  it('refuses password, hidden, and file fields', () => {
    expect(fieldRefusal(field('password'))).toMatch(/password/);
    expect(fieldRefusal(field('hidden'))).toMatch(/not a text field/);
    expect(fieldRefusal(field('file'))).toMatch(/not a text field/);
  });

  it('refuses card fields by autocomplete', () => {
    for (const ac of ['cc-number', 'cc-exp', 'cc-csc', 'billing cc-name']) {
      expect(fieldRefusal(field('text', ac)), ac).toMatch(/card/);
    }
  });

  it('refuses one-time code and password autocomplete', () => {
    expect(fieldRefusal(field('text', 'one-time-code'))).toMatch(/one-time code/);
    expect(fieldRefusal(field('text', 'new-password'))).toMatch(/password/);
    expect(fieldRefusal(field('text', 'current-password'))).toMatch(/password/);
  });

  it('refuses a field whose label, name, or id names a secret', () => {
    expect(fieldRefusal(field('text', '', ['Şifre']))).toMatch(/secret/);
    expect(fieldRefusal(field('text', '', ['user_password']))).toMatch(/secret/);
    expect(fieldRefusal(field('text', '', ['API key']))).toMatch(/secret/);
    expect(fieldRefusal(field('text', '', ['Name', 'password']))).toMatch(/secret/);
  });
});

describe('probe values', () => {
  it('makes a guest email on example.test', () => {
    expect(guestEmail()).toMatch(/^inspect-[0-9a-f]{8}@example\.test$/);
    expect(guestEmail()).not.toBe(guestEmail());
  });

  it('makes a phone number with the digit count of the field', () => {
    expect(phoneValue({ maxlength: 0, pattern: '', placeholder: '' })).toBe('5550000000');
    expect(phoneValue({ maxlength: 11, pattern: '', placeholder: '' })).toBe('55500000000');
    expect(phoneValue({ maxlength: 0, pattern: '[0-9]{10}', placeholder: '' })).toBe('5550000000');
    expect(phoneValue({ maxlength: 0, pattern: '\\d{11}', placeholder: '' })).toBe('55500000000');
    expect(phoneValue({ maxlength: 20, pattern: '', placeholder: '(5XX) XXX XX XX' })).toBe('5550000000');
    expect(phoneValue({ maxlength: 3, pattern: '', placeholder: 'Your phone' })).toBe('5550000000');
    expect(phoneValue({ maxlength: 0, pattern: '', placeholder: '' })).toMatch(/^\d+$/);
  });

  it('makes a postcode from the pattern or uses 34000', () => {
    expect(postcodeValue({ maxlength: 0, pattern: '' })).toBe('34000');
    expect(postcodeValue({ maxlength: 0, pattern: '\\d{4}' })).toBe('3000');
    expect(postcodeValue({ maxlength: 0, pattern: '^[0-9]{5}$' })).toBe('30000');
    expect(postcodeValue({ maxlength: 4, pattern: '' })).toBe('3000');
  });

  it('finds the field kind by type, autocomplete, and label', () => {
    const k = (label: string, type = 'text', autocomplete = '') => fieldKind({ label, type, autocomplete });
    expect(k('E-posta')).toBe('email');
    expect(k('x', 'email')).toBe('email');
    expect(k('Cep telefonu')).toBe('phone');
    expect(k('Ad Soyad')).toBe('full_name');
    expect(k('Soyad')).toBe('family_name');
    expect(k('Ad')).toBe('given_name');
    expect(k('First name')).toBe('given_name');
    expect(k('Posta kodu')).toBe('postcode');
    expect(k('Adres')).toBe('address');
    expect(k('Adres başlığı')).toBe('title');
    expect(k('x', 'text', 'shipping postal-code')).toBe('postcode');
    expect(k('Kimlik numarası')).toBeNull();
    // Word boundaries: "cep" inside "Recep" and "zip" inside "Zipper" are not field words.
    expect(k('Recep')).toBeNull();
    expect(k('Zipper color')).toBeNull();
    expect(k('Cep')).toBe('phone');
    expect(k('Cep Telefonunuz')).toBe('phone');
    expect(k('Zip code')).toBe('postcode');
    expect(k('İl')).toBe('city');
    expect(k('Adresiniz')).toBe('address');
  });
});
