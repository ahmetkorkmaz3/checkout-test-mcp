import { wordsFor } from './words.js';

export type PageKind = 'home' | 'listing' | 'product' | 'cart' | 'login' | 'checkout' | 'result' | 'other';

export interface PageKindInput {
  path: string;
  title: string;
  headings: string[];
  buttons: string[];
  hasPasswordField: boolean;
  hasCardFields: boolean;
}

const ADD_TO_CART = wordsFor('add_to_cart');
const CART = wordsFor('cart');
const CHECKOUT = wordsFor('checkout');
const PAY = wordsFor('pay');
const SUCCESS = wordsFor('success');
const DECLINE = wordsFor('decline');

const RESULT_PATH =
  /(thank|success|confirmation|order-received|siparis-alindi|tesekkur|danke|merci|gracias|grazie|bedankt)/i;
const CART_PATH = /\/(cart|basket|sepet|warenkorb|panier|carrito|carrello|winkelwagen|winkelmand)(\/|$)/i;
const CHECKOUT_PATH = /\/(checkout|odeme|kasse|caisse|pago|cassa|afrekenen)(\/|$)/i;
const LOGIN_PATH = /\/(login|signin|sign-in|giris|anmelden|connexion|acceder|accedi|inloggen)(\/|$)/i;
const LISTING_PATH =
  /\/(urunler|products|produkte|produits|productos|prodotti|producten|collections?|category|categories|kategori|kategorie|categorie|c|search|arama|suche|recherche|buscar|cerca|zoeken)(\/|$)/i;
const PRODUCT_PATH = /\/(urun|product|produkt|produit|producto|prodotto|artikel|item|p)\/[^/]+/i;
// "/" or a bare locale prefix such as "/tr" or "/de-AT".
const HOME_PATH = /^\/?([a-z]{2}([-_][a-z]{2})?)?\/?$/i;

const anyMatch = (re: RegExp, texts: string[]): boolean => texts.some((t) => re.test(t));

/**
 * Guesses the kind of a page from cheap signals. Reasons name the signal, never the page text,
 * because page text can hold personal data.
 */
export function guessPageKind(input: PageKindInput): { kind: PageKind; reasons: string[] } {
  const path = input.path.split(/[?#]/)[0] ?? '';
  const headingTexts = [input.title, ...input.headings];

  if (input.hasCardFields) return { kind: 'checkout', reasons: ['the page has card fields'] };

  if (anyMatch(SUCCESS, headingTexts) || anyMatch(DECLINE, headingTexts) || RESULT_PATH.test(path)) {
    return { kind: 'result', reasons: ['the title, a heading or the path names an order result'] };
  }
  if (CART_PATH.test(path)) return { kind: 'cart', reasons: ['the path names the cart'] };
  if (CHECKOUT_PATH.test(path)) return { kind: 'checkout', reasons: ['the path names the checkout'] };
  if (anyMatch(PAY, input.buttons)) return { kind: 'checkout', reasons: ['the page has a pay button'] };
  if (input.hasPasswordField || LOGIN_PATH.test(path)) {
    return {
      kind: 'login',
      reasons: [input.hasPasswordField ? 'the page has a password field' : 'the path names the login'],
    };
  }
  // Header links often hold "Sepetim", so the cart needs a heading and a checkout button together.
  if (anyMatch(CART, input.headings) && anyMatch(CHECKOUT, input.buttons)) {
    return { kind: 'cart', reasons: ['a heading names the cart and a button leads to checkout'] };
  }
  if (anyMatch(ADD_TO_CART, input.buttons)) {
    return { kind: 'product', reasons: ['the page has an add-to-cart button'] };
  }
  if (PRODUCT_PATH.test(path)) return { kind: 'product', reasons: ['the path looks like a product path'] };
  if (LISTING_PATH.test(path)) return { kind: 'listing', reasons: ['the path looks like a listing path'] };
  if (HOME_PATH.test(path)) return { kind: 'home', reasons: ['the path is the site root'] };
  return { kind: 'other', reasons: ['no signal matched'] };
}
