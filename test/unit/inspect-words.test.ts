import { describe, expect, it } from 'vitest';
import { guessPageKind } from '../../src/inspect/page-kind.js';
import { type WordKind, wordsFor } from '../../src/inspect/words.js';
import { InspectConfig } from '../../src/schemas/config.js';

const m = (kind: WordKind, text: string): boolean => wordsFor(kind).test(text);

describe('wordsFor', () => {
  it.each([
    ['add_to_cart', 'SEPETE EKLE'],
    ['add_to_cart', 'Sepete Ekle'],
    ['add_to_cart', 'In den Warenkorb'],
    ['add_to_cart', 'Ajouter au panier'],
    ['add_to_cart', 'Añadir al carrito'],
    ['add_to_cart', 'Aggiungi al carrello'],
    ['add_to_cart', 'Toevoegen aan winkelwagen'],
    ['cart', 'Sepetim'],
    ['checkout', 'Ödeme Adımına Geç'],
    ['checkout', 'ÖDEME ADIMINA GEÇ'],
    ['checkout', 'Zur Kasse'],
    ['guest', 'Üye Olmadan Devam Et'],
    ['guest', 'ÜYE OLMADAN DEVAM ET'],
    ['guest', 'Continue as guest'],
    ['login', 'Giriş Yap'],
    ['login', 'GİRİŞ YAP'],
    ['pay', 'Güvenli Öde'],
    ['pay', 'GÜVENLİ ÖDE'],
    ['pay', 'Place order'],
    ['pay', 'Jetzt bezahlen'],
    ['terms', 'Ön Bilgilendirme Formu'],
    ['terms', 'ÖN BİLGİLENDİRME FORMU'],
    ['success', 'Siparişin alındı'],
    ['success', 'SİPARİŞİN ALINDI'],
    ['decline', 'Ödeme onaylanmadı'],
    ['decline', 'ÖDEME ONAYLANMADI'],
    ['decline', 'Yetersiz bakiye'],
    ['cookie_reject', 'Reddet'],
    ['cookie_reject', 'Reject all'],
    ['cookie_accept', 'Kabul Et'],
  ] as [WordKind, string][])('%s matches %s', (kind, text) => {
    expect(m(kind, text)).toBe(true);
  });

  it('folds German ß and ss in both directions', () => {
    expect(wordsFor('checkout', { checkout: ['Straße'] }).test('STRASSE')).toBe(true);
    expect(wordsFor('checkout', { checkout: ['strasse'] }).test('Straße')).toBe(true);
  });

  it('matches whole phrases only', () => {
    expect(m('pay', 'Payment')).toBe(false);
    expect(m('pay', 'Ödeme')).toBe(false);
    expect(m('pay', 'Pay')).toBe(true);
    expect(m('pay', 'Click to pay!')).toBe(true);
  });

  it('is safe to call test twice on the same regex', () => {
    const re = wordsFor('pay');
    expect(re.test('Place order')).toBe(true);
    expect(re.test('Place order')).toBe(true);
  });

  it('adds extra phrases and escapes them', () => {
    const re = wordsFor('pay', { pay: ['Buy (now)'] });
    expect(re.test('Buy (now)')).toBe(true);
    expect(re.test('Buy now')).toBe(false);
  });

  // Safety: the probe must never click a pay button, and must never confuse kinds.
  it.each([
    'Sepete Ekle',
    'Add to cart',
    'Ödeme Adımına Geç',
    'Proceed to checkout',
    'Zur Kasse',
    'Ir a pagar',
  ])('pay does not match %s', (text) => expect(m('pay', text)).toBe(false));
  it.each(['Güvenli Öde', 'Place order', 'Jetzt bezahlen'])('add_to_cart does not match %s', (text) =>
    expect(m('add_to_cart', text)).toBe(false),
  );
  it.each(['Güvenli Öde', 'Place order'])('checkout does not match %s', (text) =>
    expect(m('checkout', text)).toBe(false),
  );
  it.each(['Accept all', 'Kabul Et', 'Tümünü Kabul Et'])('cookie_reject does not match %s', (text) =>
    expect(m('cookie_reject', text)).toBe(false),
  );
});

describe('inspect.words config', () => {
  it('accepts known kinds', () => {
    expect(InspectConfig.safeParse({ words: { pay: ['Bestellen'] } }).success).toBe(true);
  });
  it('rejects an unknown kind', () => {
    expect(InspectConfig.safeParse({ words: { payy: ['x'] } }).success).toBe(false);
  });
});

describe('guessPageKind', () => {
  const base = {
    path: '/x',
    title: 'X',
    headings: ['X'],
    buttons: [],
    hasPasswordField: false,
    hasCardFields: false,
  };
  it('guesses a product page from its add-to-cart button', () => {
    expect(guessPageKind({ ...base, path: '/urun/x', buttons: ['Sepete Ekle'] }).kind).toBe('product');
  });
  it('guesses the other kinds', () => {
    expect(guessPageKind({ ...base, path: '/' }).kind).toBe('home');
    expect(guessPageKind({ ...base, path: '/tr' }).kind).toBe('home');
    expect(guessPageKind({ ...base, path: '/urunler' }).kind).toBe('listing');
    expect(guessPageKind({ ...base, path: '/sepet' }).kind).toBe('cart');
    expect(guessPageKind({ ...base, path: '/odeme' }).kind).toBe('checkout');
    expect(guessPageKind({ ...base, hasCardFields: true }).kind).toBe('checkout');
    expect(guessPageKind({ ...base, buttons: ['Güvenli Öde'] }).kind).toBe('checkout');
    expect(guessPageKind({ ...base, hasPasswordField: true }).kind).toBe('login');
    expect(guessPageKind({ ...base, headings: ['Siparişin alındı'] }).kind).toBe('result');
    expect(guessPageKind({ ...base, headings: ['Ödeme onaylanmadı'] }).kind).toBe('result');
    expect(guessPageKind({ ...base, path: '/zzz' }).kind).toBe('other');
  });
  it('does not call a product page with a header cart link a cart', () => {
    const r = guessPageKind({ ...base, path: '/urun/x', buttons: ['Sepetim', 'Sepete Ekle'] });
    expect(r.kind).toBe('product');
  });
  it('never puts page text in the reasons', () => {
    const r = guessPageKind({ ...base, headings: ['Siparişin alındı'] });
    expect(r.reasons.join(' ')).not.toContain('Sipariş');
  });
});
