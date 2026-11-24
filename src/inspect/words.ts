import { z } from 'zod';

export const WordKind = z.enum([
  'add_to_cart',
  'cart',
  'checkout',
  'guest',
  'login',
  'pay',
  'terms',
  'success',
  'decline',
  'cookie_reject',
  'cookie_accept',
]);
export type WordKind = z.infer<typeof WordKind>;

/**
 * Phrases per kind in English, Turkish, German, French, Spanish, Italian and Dutch.
 * The `pay` list decides what the probe must never click. It lists full phrases, so a
 * checkout step button such as "Ödeme Adımına Geç" does not match. Any phrase that can be
 * a pay button on some shop (for example "Commander" or "Complete checkout") stays in `pay`.
 * `checkout` keeps only explicit step phrases. Use matchesKind: pay wins on every overlap.
 * `cookie_accept` exists only so the probe can avoid it.
 */
export const WORD_LISTS: Record<WordKind, readonly string[]> = {
  add_to_cart: [
    'add to cart',
    'add to bag',
    'add to basket',
    'sepete ekle',
    'sepete at',
    'sepetime ekle',
    'in den warenkorb',
    'zum warenkorb hinzufügen',
    'in den einkaufswagen',
    'ajouter au panier',
    'ajouter au sac',
    'añadir al carrito',
    'agregar al carrito',
    'añadir a la cesta',
    'aggiungi al carrello',
    'aggiungi al cestino',
    'toevoegen aan winkelwagen',
    'in winkelwagen',
    'voeg toe aan winkelmand',
    'in winkelmandje',
  ],
  cart: [
    'cart',
    'basket',
    'shopping bag',
    'view cart',
    'sepet',
    'sepetim',
    'sepeti görüntüle',
    'warenkorb',
    'einkaufswagen',
    'panier',
    'mon panier',
    'carrito',
    'cesta',
    'carrello',
    'winkelwagen',
    'winkelmand',
  ],
  checkout: [
    'proceed to checkout',
    'go to checkout',
    'continue to checkout',
    'continue to payment',
    'ödeme adımına geç',
    'ödemeye geç',
    'sepeti onayla',
    'zur kasse',
    'zur kasse gehen',
    'zum checkout',
    'weiter zur zahlung',
    'passer à la caisse',
    'passer la commande',
    'passer commande',
    'ir a la caja',
    'tramitar pedido',
    'proceder al pago',
    'vai alla cassa',
    'procedi al checkout',
    "procedi all'ordine",
    'naar de kassa',
  ],
  guest: [
    'continue as guest',
    'guest checkout',
    'checkout as guest',
    'continue without an account',
    'continue without account',
    'continue without signing in',
    'üye olmadan devam et',
    'üye olmadan alışveriş',
    'misafir olarak devam et',
    'üyeliksiz devam et',
    'als gast fortfahren',
    'weiter als gast',
    'ohne registrierung fortfahren',
    "continuer en tant qu'invité",
    'continuer sans compte',
    'continuar como invitado',
    'continuar sin cuenta',
    'compra como invitado',
    'continua come ospite',
    'procedi come ospite',
    'continua senza account',
    'doorgaan als gast',
    'verder als gast',
    'doorgaan zonder account',
  ],
  login: [
    'log in',
    'login',
    'sign in',
    'giriş yap',
    'giriş',
    'üye girişi',
    'anmelden',
    'einloggen',
    'se connecter',
    'connexion',
    'iniciar sesión',
    'acceder',
    'accedi',
    'inloggen',
    'aanmelden',
  ],
  pay: [
    'pay',
    'buy now',
    'order now',
    'jetzt kaufen',
    'kaufen',
    'bestellen',
    'acheter',
    'comprar',
    'pagar',
    'satın al',
    'hemen al',
    'ödeme yap',
    'sipariş ver',
    'acquista ora',
    'ordina adesso',
    'koop nu',
    'bestelling bevestigen',
    'commander',
    'commander maintenant',
    'alışverişi tamamla',
    'finalizar compra',
    'pagar y finalizar compra',
    'afrekenen',
    'complete checkout',
    'checkout with paypal',
    'express checkout',
    'secure checkout',
    'buy now and checkout',
    'pay now',
    'pay securely',
    'pay with card',
    'submit order',
    'place order',
    'place your order',
    'complete order',
    'complete purchase',
    'confirm order',
    'confirm and pay',
    'öde',
    'güvenli öde',
    'şimdi öde',
    'siparişi tamamla',
    'siparişi onayla',
    'ödemeyi tamamla',
    'bezahlen',
    'jetzt bezahlen',
    'zahlungspflichtig bestellen',
    'kostenpflichtig bestellen',
    'jetzt bestellen',
    'bestellung abschicken',
    'bestellung abschließen',
    'payer',
    'payer maintenant',
    'valider la commande',
    'confirmer la commande',
    'pagar ahora',
    'confirmar y pagar',
    'pagar pedido',
    'realizar pedido',
    'confirmar pedido',
    'pagare',
    'paga ora',
    'conferma ordine',
    'completa ordine',
    "effettua l'ordine",
    'betalen',
    'nu betalen',
    'bestelling plaatsen',
    'bestelling afronden',
    'bestellen en betalen',
  ],
  terms: [
    'terms and conditions',
    'terms of service',
    'terms of use',
    'i accept the terms',
    'i agree',
    'ön bilgilendirme formu',
    'mesafeli satış sözleşmesi',
    'kullanım koşulları',
    'şartlar ve koşullar',
    'sözleşmeyi okudum',
    'agb',
    'allgemeine geschäftsbedingungen',
    'nutzungsbedingungen',
    'conditions générales',
    'cgv',
    'términos y condiciones',
    'condiciones de compra',
    'termini e condizioni',
    'condizioni generali',
    'algemene voorwaarden',
  ],
  success: [
    'siparişin alındı',
    'siparişiniz alındı',
    'siparişiniz tamamlandı',
    'teşekkürler',
    'order confirmed',
    'order received',
    'order complete',
    'order placed',
    'thank you',
    'vielen dank für ihre bestellung',
    'bestellung erfolgreich',
    'bestellbestätigung',
    'merci pour votre commande',
    'commande confirmée',
    'gracias por tu pedido',
    'pedido confirmado',
    'grazie per il tuo ordine',
    'ordine confermato',
    'bedankt voor je bestelling',
    'bestelling bevestigd',
    'bestelling ontvangen',
  ],
  decline: [
    'onaylanmadı',
    'yetersiz',
    'reddedildi',
    'başarısız',
    'declined',
    'card declined',
    'payment failed',
    'insufficient funds',
    'not authorized',
    'authentication failed',
    'zahlung abgelehnt',
    'karte abgelehnt',
    'fehlgeschlagen',
    'paiement refusé',
    'refusé',
    'échec',
    'pago rechazado',
    'rechazado',
    'fondos insuficientes',
    'pagamento rifiutato',
    'rifiutato',
    'fondi insufficienti',
    'betaling mislukt',
    'geweigerd',
    'onvoldoende saldo',
  ],
  cookie_reject: [
    'reject all',
    'reject',
    'decline all',
    'deny',
    'only necessary',
    'necessary only',
    'reject non-essential',
    'reddet',
    'tümünü reddet',
    'hepsini reddet',
    'sadece gerekli',
    'yalnızca zorunlu',
    'alle ablehnen',
    'ablehnen',
    'nur notwendige',
    'nur essenzielle',
    'tout refuser',
    'refuser',
    'refuser tout',
    'rechazar todo',
    'rechazar',
    'solo necesarias',
    'rifiuta tutto',
    'rifiuta',
    'solo necessari',
    'alles weigeren',
    'weigeren',
    'alleen noodzakelijke',
    'alles afwijzen',
    'afwijzen',
  ],
  cookie_accept: [
    'accept all',
    'accept',
    'accept cookies',
    'allow all',
    'got it',
    'kabul et',
    'tümünü kabul et',
    'hepsini kabul et',
    'kabul ediyorum',
    'çerezleri kabul et',
    'alle akzeptieren',
    'akzeptieren',
    'alle cookies zulassen',
    'zustimmen',
    'tout accepter',
    'accepter',
    'aceptar todo',
    'aceptar',
    'accetta tutto',
    'accetta',
    'alles accepteren',
    'accepteren',
    'akkoord',
  ],
};

/**
 * Labels that count only when they are the whole label, so "Complete checkout" does not match.
 * They stay out of WORD_LISTS, because a bare word is too weak as a phrase.
 */
export const EXACT_ONLY: Partial<Record<WordKind, readonly string[]>> = {
  checkout: ['checkout', 'check out', 'kasse', 'kassa', 'caisse', 'cassa', 'caja', 'ödeme'],
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turns one phrase into a pattern part. Folding happens inside the pattern, because
 * "İ" and "I" do not fold to "i" in JS, and one RegExp cannot lower-case its input.
 */
function phrasePattern(phrase: string): string {
  return escapeRe(phrase.trim())
    .replace(/['’]/g, "['’]")
    .replace(/ß/g, 'ss')
    .replace(/ss/gi, '(?:ss|ß)')
    .replace(/[iıİI]/g, '[iıİI]')
    .replace(/\s+/g, '\\s+');
}

/**
 * Builds a case-insensitive, Unicode-aware pattern for the whole phrases of one kind.
 * It folds Turkish İ/ı and German ß. Plain \b fails on ş, ö, ü and İ, so the boundaries
 * use letter and digit classes. The pattern has no g flag, so .test is safe to repeat.
 */
export function wordsFor(kind: WordKind, extra: Partial<Record<WordKind, string[]>> = {}): RegExp {
  const phrases = [...WORD_LISTS[kind], ...(extra[kind] ?? [])].filter((p) => p.trim() !== '');
  // Longest first, so the alternation prefers the most specific phrase.
  const parts = [...new Set(phrases)].sort((a, b) => b.length - a.length).map(phrasePattern);
  const phrase = `(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`;
  const exact = (EXACT_ONLY[kind] ?? []).map(phrasePattern);
  const body = exact.length > 0 ? `${phrase}|^\\s*(?:${exact.join('|')})\\s*$` : phrase;
  return new RegExp(`(?:${body})`, 'iu');
}

const defaults = new Map<WordKind, RegExp>();
function compiled(kind: WordKind, extra?: Partial<Record<WordKind, string[]>>): RegExp {
  if (extra && Object.keys(extra).length > 0) return wordsFor(kind, extra);
  let re = defaults.get(kind);
  if (!re) {
    re = wordsFor(kind);
    defaults.set(kind, re);
  }
  return re;
}

/**
 * Decides whether a text is of one kind. Use it for every clickable decision.
 * Pay wins: for any kind except `pay`, a text that also matches `pay` is not a match.
 * It also folds text to NFC, so decomposed letters match.
 */
export function matchesKind(
  kind: WordKind,
  text: string,
  extra?: Partial<Record<WordKind, string[]>>,
): boolean {
  const t = text.normalize('NFC');
  if (kind !== 'pay' && compiled('pay', extra).test(t)) return false;
  return compiled(kind, extra).test(t);
}
