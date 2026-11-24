import { describe, expect, it } from 'vitest';
import { type ClickFacts, clickRefusal, fieldRefusal } from '../../src/inspect/actions.js';
import { fieldKind, guestEmail, phoneValue, postcodeValue } from '../../src/inspect/probe.js';

const click = (texts: string[], more: Partial<ClickFacts> = {}): ClickFacts => ({
  texts,
  otpOnPage: false,
  passwordInForm: false,
  ...more,
});

describe('clickRefusal', () => {
  it('allows step buttons', () => {
    for (const t of [
      'Add to cart',
      'Checkout',
      'Continue as guest',
      'Continue to payment',
      'Reject all',
      'İstanbul',
    ]) {
      expect(clickRefusal(click([t]), {})).toBeNull();
    }
  });

  it('refuses a pay button in any text of the element', () => {
    expect(clickRefusal(click(['Pay 349,00 TL']), {})).toMatch(/pay/);
    expect(clickRefusal(click(['Go', 'Buy now']), {})).toMatch(/pay/);
    expect(clickRefusal(click(['Siparişi tamamla']), { pay: ['siparişi tamamla'] })).toMatch(/pay/);
  });

  it('refuses a cookie accept button', () => {
    expect(clickRefusal(click(['Accept all']), {})).toMatch(/cookies/);
    expect(clickRefusal(click(['Tümünü kabul et']), {})).toMatch(/cookies/);
  });

  it('refuses a send-code or verify button', () => {
    for (const t of ['Send code', 'Kod gönder', 'Resend', 'Verify', 'SMS ile doğrula', 'Code anfordern']) {
      expect(clickRefusal(click([t]), {}), t).toMatch(/code/);
    }
  });

  it('refuses any click on a page with a one-time code field', () => {
    expect(clickRefusal(click(['Continue'], { otpOnPage: true }), {})).toMatch(/one-time code/);
  });

  it('refuses to submit a form with a password field', () => {
    expect(clickRefusal(click(['Sign in'], { passwordInForm: true }), {})).toMatch(/password/);
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
  });
});
