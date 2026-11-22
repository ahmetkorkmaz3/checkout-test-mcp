import type { CardBehaviour } from '../schemas/common.js';

/**
 * The only place in the code base where card numbers exist.
 * Every entry is a card that the provider publishes for test mode. Each entry needs a source URL.
 * Do not add a card without a published source. Do not load cards from config.
 */
export interface TestCard {
  id: string;
  provider: string;
  brand: string;
  number: string;
  expiry: string;
  cvc: string;
  behaviour: CardBehaviour;
  description: string;
  source_url: string;
}

const STRIPE_SOURCE = 'https://docs.stripe.com/testing';

export const TEST_CARDS: readonly TestCard[] = [
  {
    id: 'stripe/visa-success',
    provider: 'stripe',
    brand: 'visa',
    number: '4242424242424242',
    expiry: '12 / 34',
    cvc: '123',
    behaviour: 'success',
    description: 'Payment succeeds without 3D Secure.',
    source_url: STRIPE_SOURCE,
  },
  {
    id: 'stripe/3ds2-challenge-required',
    provider: 'stripe',
    brand: 'visa',
    number: '4000000000003220',
    expiry: '12 / 34',
    cvc: '123',
    behaviour: 'challenge_required',
    description: '3D Secure 2 authentication must be completed with a challenge.',
    source_url: STRIPE_SOURCE,
  },
  {
    id: 'stripe/3ds-always-authenticate',
    provider: 'stripe',
    brand: 'visa',
    number: '4000002760003184',
    expiry: '12 / 34',
    cvc: '123',
    behaviour: 'challenge_required',
    description: 'Requires 3D Secure authentication on every payment.',
    source_url: STRIPE_SOURCE,
  },
  {
    id: 'stripe/declined-generic',
    provider: 'stripe',
    brand: 'visa',
    number: '4000000000000002',
    expiry: '12 / 34',
    cvc: '123',
    behaviour: 'declined_generic',
    description: 'Declined with a generic decline code.',
    source_url: STRIPE_SOURCE,
  },
  {
    id: 'stripe/declined-insufficient-funds',
    provider: 'stripe',
    brand: 'visa',
    number: '4000000000009995',
    expiry: '12 / 34',
    cvc: '123',
    behaviour: 'declined_insufficient_funds',
    description: 'Declined because of insufficient funds.',
    source_url: STRIPE_SOURCE,
  },
  {
    id: 'stripe/declined-expired',
    provider: 'stripe',
    brand: 'visa',
    number: '4000000000000069',
    expiry: '12 / 34',
    cvc: '123',
    behaviour: 'declined_expired',
    description: 'Declined because the card is expired.',
    source_url: STRIPE_SOURCE,
  },
];

const BY_ID = new Map(TEST_CARDS.map((c) => [c.id, c]));
const BY_NUMBER = new Map(TEST_CARDS.map((c) => [c.number, c]));

export function getTestCard(id: string): TestCard | undefined {
  return BY_ID.get(id);
}

export function isRegisteredTestCardNumber(digits: string): boolean {
  return BY_NUMBER.has(digits);
}
