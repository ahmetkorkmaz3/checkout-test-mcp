import { describe, expect, it } from 'vitest';
import { BlockedHostCounter, pathPattern } from '../../src/inspect/crawl.js';

describe('pathPattern', () => {
  it.each([
    ['/', '/'],
    ['/products', '/products'],
    ['/products/ceramic-mug', '/products/*'],
    ['/api/products/ceramic-mug', '/api/products/*'],
    ['/urun/merci-kalem', '/urun/*'],
    ['/collections/mugs/products/blue-mug', '/collections/*/products/*'],
    ['/orders/12345', '/orders/*'],
    ['/orders/0f8fad5b-d9cb-469f-a165-70867728950e/items', '/orders/*/items'],
    ['/session/0123456789abcdef', '/session/*'],
    ['/merci-kalem-p-123456', '/*'],
    ['/api/cart/items', '/api/cart/items'],
    ['/account/verify-phone', '/account/verify-phone'],
    ['/search?q=mug', '/search'],
  ])('%s -> %s', (input, expected) => {
    expect(pathPattern(input)).toBe(expected);
  });
});

describe('BlockedHostCounter', () => {
  it('counts hosts and sorts by count', () => {
    const c = new BlockedHostCounter();
    c.onBlocked('https://cdn.example.com/a.js?u=1');
    c.onBlocked('https://pixel.example.net/p');
    c.onBlocked('https://pixel.example.net/q');
    c.onBlocked('not a url');
    expect(c.list()).toEqual([
      { host: 'pixel.example.net', count: 2 },
      { host: '(invalid url)', count: 1 },
      { host: 'cdn.example.com', count: 1 },
    ]);
  });
});
