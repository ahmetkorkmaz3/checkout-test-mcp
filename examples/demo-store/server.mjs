#!/usr/bin/env node
// Small demo store for checkout-test-mcp. No dependencies.
// It has one product, a guest checkout, and a mock card provider with a 3D Secure challenge.
// The mock provider decides by the last 4 digits of the card, the same way Stripe test cards behave.
// Fault injection for demos: start with DEMO_STORE_BUGS=skip-3ds (comma-separated) or call setBugs().

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const PRODUCT = { slug: 'ceramic-mug', name: 'Ceramic Mug', price: 349 };

const CARD_RULES = {
  4242: 'success',
  3220: 'challenge',
  3184: 'challenge',
  '0002': 'declined',
  9995: 'insufficient_funds',
  '0069': 'expired',
};

const tl = (n) => `${n.toFixed(2).replace('.', ',')} TL`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function layout(title, session, body, script = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)} - Demo Store</title>
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:16px;color:#222}
header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:16px}
label{display:block;margin:8px 0 2px}input,select{padding:6px;width:100%;max-width:360px;box-sizing:border-box}
button{margin-top:12px;padding:8px 14px}[role=alert]{color:#b00020;margin-top:12px}
iframe{border:1px solid #ccc;width:100%;max-width:380px}
</style></head>
<body>
<header><a href="/products/${PRODUCT.slug}">Demo Store</a>
<nav><a href="/checkout">Checkout</a> (<span data-testid="cart-count">${cartCount(session)}</span>)</nav></header>
<main>${body}</main>
<script>${script}</script>
</body></html>`;
}

function cartCount(session) {
  return session.cart.reduce((n, i) => n + i.qty, 0);
}

function cartTotal(session) {
  return session.cart.reduce((n, i) => n + i.qty * PRODUCT.price, 0);
}

const productPage = (s) =>
  layout(
    PRODUCT.name,
    s,
    `<h1>${PRODUCT.name}</h1><p id="price">${tl(PRODUCT.price)}</p>
<label for="qty">Quantity</label><input id="qty" type="number" min="1" max="10" value="1">
<button id="add">Add to cart</button>`,
    `fetch('/api/products/${PRODUCT.slug}').then(r=>r.json()).then(p=>{document.getElementById('price').textContent=p.price_text});
document.getElementById('add').addEventListener('click', async () => {
  const qty = Number(document.getElementById('qty').value);
  const r = await fetch('/api/cart/items',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({slug:'${PRODUCT.slug}',qty})});
  const j = await r.json();
  document.querySelector('[data-testid=cart-count]').textContent = j.count;
});`,
  );

const checkoutStart = (s) =>
  layout(
    'Checkout',
    s,
    `<h1>Checkout</h1><p>${cartCount(s)} item(s), total ${tl(cartTotal(s))}</p>
<button id="guest">Continue as guest</button>`,
    `document.getElementById('guest').addEventListener('click',()=>{location.href='/checkout/contact'});`,
  );

const contactPage = (s) =>
  layout(
    'Contact and address',
    s,
    `<h1>Contact and address</h1>
<form id="f">
<label for="email">Email</label><input id="email" type="email" required>
<label for="name">Full name</label><input id="name" required>
<label for="phone">Phone</label><input id="phone" type="tel" required>
<label for="address">Address</label><input id="address" required>
<label for="city">City</label><select id="city"><option value="">Select</option><option>İstanbul</option><option>Ankara</option><option>İzmir</option></select>
<label for="district">District</label><select id="district"><option value="">Select</option><option>Kadıköy</option><option>Beşiktaş</option><option>Çankaya</option><option>Karşıyaka</option></select>
<button type="submit">Continue to payment</button>
</form>`,
    `document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = (id) => document.getElementById(id).value;
  await fetch('/api/checkout/contact',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:v('email'),name:v('name'),phone:v('phone'),address:v('address'),city:v('city'),district:v('district')})});
  location.href='/checkout/payment';
});`,
  );

const paymentPage = (s) =>
  layout(
    'Payment',
    s,
    `<h1>Payment</h1>
<iframe title="Secure card payment input" src="/pay/card-frame" height="170"></iframe>
<div><button id="pay">Pay ${tl(cartTotal(s))}</button></div>
<div id="challenge"></div>
<div id="error" role="alert" hidden></div>`,
    `const err = document.getElementById('error');
function showError(msg){ err.textContent = msg; err.hidden = false; }
async function placeOrder(){
  const r = await fetch('/api/orders',{method:'POST'});
  const j = await r.json();
  location.href = '/checkout/success?order=' + encodeURIComponent(j.order_id);
}
window.addEventListener('message', async (e) => {
  if (!e.data || e.data.type !== '3ds-result') return;
  document.getElementById('challenge').innerHTML = '';
  if (e.data.result === 'complete') return placeOrder();
  showError('Your card was declined. 3D Secure authentication failed.');
});
document.getElementById('pay').addEventListener('click', async () => {
  err.hidden = true;
  const doc = document.querySelector('iframe[title="Secure card payment input"]').contentDocument;
  const val = (sel) => doc.querySelector(sel).value;
  const r = await fetch('/api/payments',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({number:val('[autocomplete=cc-number]'),expiry:val('[autocomplete=cc-exp]'),cvc:val('[autocomplete=cc-csc]')})});
  const j = await r.json();
  if (j.status === 'succeeded') return placeOrder();
  if (j.status === 'challenge_required') {
    const f = document.createElement('iframe');
    f.name = 'three-ds-challenge-' + j.payment_id;
    f.title = '3D Secure challenge';
    f.height = 220;
    f.src = '/pay/challenge?payment=' + encodeURIComponent(j.payment_id);
    document.getElementById('challenge').appendChild(f);
    return;
  }
  showError(j.message || 'Your card was declined.');
});`,
  );

const cardFrame = () => `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui,sans-serif;margin:8px}input{display:block;margin:6px 0;padding:6px;width:300px}</style></head>
<body><input placeholder="Card number" autocomplete="cc-number" inputmode="numeric">
<input placeholder="MM / YY" autocomplete="cc-exp"><input placeholder="CVC" autocomplete="cc-csc"></body></html>`;

const challengeFrame = (paymentId) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui,sans-serif;margin:8px}</style></head>
<body><p><strong>Test 3D Secure 2 challenge</strong></p><p>This is a test payment. Choose a result.</p>
<button id="ok">Complete authentication</button> <button id="fail">Fail authentication</button>
<script>
async function send(result){
  await fetch('/api/payments/${encodeURIComponent(paymentId)}/authenticate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({result})});
  parent.postMessage({type:'3ds-result',result},'*');
}
document.getElementById('ok').onclick=()=>send('complete');
document.getElementById('fail').onclick=()=>send('fail');
</script></body></html>`;

const successPage = (s, orderId) =>
  layout(
    'Order placed',
    s,
    `<h1>Thank you for your order</h1><p>Order number: <strong data-testid="order-number">${esc(orderId)}</strong></p>`,
  );

export function startDemoStore({ port = 4173, host = '127.0.0.1', bugs = [] } = {}) {
  const sessions = new Map();
  const payments = new Map();
  let activeBugs = new Set(bugs);
  const stats = { orders: 0, payments: 0 };

  function session(req, res) {
    const sid = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (sid && sessions.has(sid)) return sessions.get(sid);
    const id = randomBytes(9).toString('base64url');
    const s = { id, cart: [], contact: null, paid: false };
    sessions.set(id, s);
    res.setHeader('set-cookie', `sid=${id}; Path=/; HttpOnly; SameSite=Lax`);
    return s;
  }

  const readJson = (req) =>
    new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
    });

  const send = (res, status, type, body) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  const html = (res, body, status = 200) => send(res, status, 'text/html; charset=utf-8', body);
  const json = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const s = session(req, res);
    const p = url.pathname;
    const m = req.method ?? 'GET';

    if (m === 'GET' && p === '/') return html(res, productPage(s));
    if (m === 'GET' && p === `/products/${PRODUCT.slug}`) return html(res, productPage(s));
    if (m === 'GET' && p === `/api/products/${PRODUCT.slug}`) {
      return json(res, 200, { ...PRODUCT, price_text: tl(PRODUCT.price) });
    }
    if (m === 'POST' && p === '/api/cart/items') {
      const body = await readJson(req);
      const qty = Number(body.qty);
      if (body.slug !== PRODUCT.slug || !Number.isInteger(qty) || qty < 1 || qty > 10) {
        return json(res, 400, { error: 'invalid item' });
      }
      s.cart = [{ slug: PRODUCT.slug, qty }];
      return json(res, 201, { count: cartCount(s) });
    }
    if (m === 'GET' && p === '/checkout') return html(res, checkoutStart(s));
    if (m === 'GET' && p === '/checkout/contact') return html(res, contactPage(s));
    if (m === 'POST' && p === '/api/checkout/contact') {
      s.contact = await readJson(req);
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/checkout/payment') return html(res, paymentPage(s));
    if (m === 'GET' && p === '/pay/card-frame') return html(res, cardFrame());
    if (m === 'GET' && p === '/pay/challenge')
      return html(res, challengeFrame(url.searchParams.get('payment') ?? ''));
    if (m === 'POST' && p === '/api/payments') {
      stats.payments++;
      const body = await readJson(req);
      const digits = String(body.number ?? '').replace(/\D/g, '');
      if (digits.length < 13)
        return json(res, 402, { status: 'declined', message: 'Your card number is incomplete.' });
      let rule = CARD_RULES[digits.slice(-4)] ?? 'declined';
      if (rule === 'challenge' && activeBugs.has('skip-3ds')) rule = 'success';
      if (rule === 'success') {
        s.paid = true;
        return json(res, 200, { status: 'succeeded' });
      }
      if (rule === 'challenge') {
        const id = randomBytes(6).toString('hex');
        payments.set(id, { sid: s.id, state: 'pending' });
        return json(res, 200, { status: 'challenge_required', payment_id: id });
      }
      const messages = {
        declined: 'Your card was declined.',
        insufficient_funds: 'Your card was declined: insufficient funds.',
        expired: 'Your card was declined: the card is expired.',
      };
      return json(res, 402, { status: 'declined', message: messages[rule] });
    }
    const auth = /^\/api\/payments\/([a-f0-9]+)\/authenticate$/.exec(p);
    if (m === 'POST' && auth) {
      const pay = payments.get(auth[1]);
      if (!pay || pay.sid !== s.id) return json(res, 404, { error: 'unknown payment' });
      const body = await readJson(req);
      pay.state = body.result === 'complete' ? 'succeeded' : 'failed';
      if (pay.state === 'succeeded') s.paid = true;
      return json(res, 200, { status: pay.state });
    }
    if (m === 'POST' && p === '/api/orders') {
      if (!s.paid || s.cart.length === 0) return json(res, 409, { error: 'payment required' });
      stats.orders++;
      const orderId = `DS-${String(1000 + stats.orders)}`;
      s.cart = [];
      s.paid = false;
      return json(res, 201, { order_id: orderId });
    }
    if (m === 'GET' && p === '/checkout/success')
      return html(res, successPage(s, url.searchParams.get('order') ?? ''));
    if (m === 'GET' && p === '/favicon.ico') return send(res, 204, 'image/x-icon', '');
    return html(res, layout('Not found', s, '<h1>Not found</h1>'), 404);
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `http://localhost:${actualPort}`,
        port: actualPort,
        stats,
        setBugs: (list) => {
          activeBugs = new Set(list);
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 4173);
  const bugs = (process.env.DEMO_STORE_BUGS ?? '').split(',').filter(Boolean);
  startDemoStore({ port, bugs }).then((s) => {
    process.stderr.write(`Demo store: ${s.url}${bugs.length ? ` (bugs: ${bugs.join(', ')})` : ''}\n`);
  });
}
