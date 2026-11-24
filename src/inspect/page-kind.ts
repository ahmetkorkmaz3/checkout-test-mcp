import { matchesKind } from './words.js';

export type PageKind = 'home' | 'listing' | 'product' | 'cart' | 'login' | 'checkout' | 'result' | 'other';

export interface PageKindInput {
  path: string;
  title: string;
  headings: string[];
  buttons: string[];
  hasPasswordField: boolean;
  hasCardFields: boolean;
}

// Path words match whole segments, so "/urun/merci-kalem" is not a result page.
const RESULT_PATH =
  /\/(thank-you|thankyou|thanks|success|order-confirmation|confirmation|order-received|order-complete|siparis-alindi|tesekkurler|tesekkur|danke|merci|gracias|grazie|bedankt)(\/|$)/i;
const CART_PATH = /\/(cart|basket|sepet|warenkorb|panier|carrito|carrello|winkelwagen|winkelmand)(\/|$)/i;
const CHECKOUT_PATH = /\/(checkout|odeme|kasse|caisse|pago|cassa|afrekenen)(\/|$)/i;
const LOGIN_PATH = /\/(login|signin|sign-in|giris|anmelden|connexion|acceder|accedi|inloggen)(\/|$)/i;
const LISTING_PATH =
  /\/(urunler|products|produkte|produits|productos|prodotti|producten|collections?|category|categories|kategori|kategorie|categorie|c|search|arama|suche|recherche|buscar|cerca|zoeken)(\/|$)/i;
const PRODUCT_PATH = /\/(urun|product|produkt|produit|producto|prodotto|artikel|item|p)\/[^/]+/i;
// "/" or a bare locale prefix such as "/tr" or "/de-AT".
const HOME_PATH = /^\/?([a-z]{2}([-_][a-z]{2})?)?\/?$/i;
// A decline word alone is not a result ("Yetersiz stok" is a stock warning). It needs a payment or order word.
const PAYMENT_CONTEXT =
  /(ödeme|odeme|payment|card|kart|karte|zahlung|paiement|pago|pagamento|betaling|sipariş|order|bestell|commande|pedido|ordine)/iu;

const any = (kind: Parameters<typeof matchesKind>[0], texts: string[]): boolean =>
  texts.some((t) => matchesKind(kind, t));

/**
 * Guesses the kind of a page from cheap signals. Reasons name the signal, never the page text,
 * because page text can hold personal data.
 */
export function guessPageKind(input: PageKindInput): { kind: PageKind; reasons: string[] } {
  const path = (input.path.split(/[?#]/)[0] ?? '').normalize('NFC');
  const headingTexts = [input.title, ...input.headings];

  if (input.hasCardFields) return { kind: 'checkout', reasons: ['the page has card fields'] };

  const declined = headingTexts.some((t) => matchesKind('decline', t) && PAYMENT_CONTEXT.test(t));
  if (any('success', headingTexts) || declined || RESULT_PATH.test(path)) {
    return { kind: 'result', reasons: ['the title, a heading or the path names an order result'] };
  }
  const cartAt = path.search(CART_PATH);
  const checkoutAt = path.search(CHECKOUT_PATH);
  // In "/sepet/odeme" the deeper segment decides.
  if (checkoutAt >= 0 && checkoutAt > cartAt)
    return { kind: 'checkout', reasons: ['the path names the checkout'] };
  if (cartAt >= 0) return { kind: 'cart', reasons: ['the path names the cart'] };
  // Before the pay button check: a product page can hold both "Add to cart" and "Buy now".
  if (any('add_to_cart', input.buttons)) {
    return { kind: 'product', reasons: ['the page has an add-to-cart button'] };
  }
  if (any('pay', input.buttons)) return { kind: 'checkout', reasons: ['the page has a pay button'] };
  if (input.hasPasswordField || LOGIN_PATH.test(path)) {
    return {
      kind: 'login',
      reasons: [input.hasPasswordField ? 'the page has a password field' : 'the path names the login'],
    };
  }
  // Header links often hold "Sepetim", so the cart needs a heading and a checkout button together.
  if (any('cart', input.headings) && any('checkout', input.buttons)) {
    return { kind: 'cart', reasons: ['a heading names the cart and a button leads to checkout'] };
  }
  if (PRODUCT_PATH.test(path)) return { kind: 'product', reasons: ['the path looks like a product path'] };
  if (LISTING_PATH.test(path)) return { kind: 'listing', reasons: ['the path looks like a listing path'] };
  if (HOME_PATH.test(path)) return { kind: 'home', reasons: ['the path is the site root'] };
  return { kind: 'other', reasons: ['no signal matched'] };
}
