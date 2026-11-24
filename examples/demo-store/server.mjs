#!/usr/bin/env node
// Small demo store for checkout-test-mcp. No dependencies.
// It has a product listing with one product, a guest checkout, and a mock card provider with a 3D Secure challenge.
// The mock provider decides by the last 4 digits of the card, the same way Stripe test cards behave.
// It also has a phone check with an SMS code. Like many test environments, send-code returns the code
// in its response, so a scenario can read it with "capture".
// Fault injection for demos: start with DEMO_STORE_BUGS=skip-3ds (comma-separated) or call setBugs().
// Bugs: skip-3ds (no 3DS challenge), cookie-banner (a consent dialog over every page until the user
// chooses), login-wall (checkout needs a sign-in and has no guest option), redirect-frame (the payment
// page has an iframe that redirects to a payment host outside the allowlist).
// Redirect routes for the host guard tests: /go/out, /go/in, /frame/out, /api/redirect-out, /img/out,
// /events/out, /chain/*, /tp/redirect, and /login-cookie. The "outside" host is 127.0.0.1 on the same port, or
// a .invalid host. A request that reaches /outside/* on 127.0.0.1 goes into outsideHits, so a test can
// show that the guard stopped it. No route sends a browser to a real remote host.
// /staging-only needs HTTP basic auth with the fixed test user from startDemoStore({ basicAuth }).
// /third-party/* answers 401 with a basic auth challenge and records if a request had an Authorization header.

import { createHash, randomBytes } from 'node:crypto';
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
.terms input{width:auto}
#cookie-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center}
#cookie-backdrop [role=dialog]{background:#fff;padding:16px;max-width:420px}
</style></head>
<body>
<header><a href="/products/${PRODUCT.slug}">Demo Store</a>
<nav><a href="/products">Products</a> <a href="/checkout">Checkout</a> (<span data-testid="cart-count">${cartCount(session)}</span>)</nav></header>
<main>${body}</main>
<footer><a href="/account/verify-phone">Verify phone</a> <a href="/account/returns">Return requests</a></footer>
${session.cookieBanner ? cookieBanner : ''}
<script>${script}</script>
</body></html>`;
}

// A modal consent dialog. It covers the page, so a click on the page fails until the user chooses.
const cookieBanner = `<div id="cookie-backdrop"><div role="dialog" aria-label="Cookie settings">
<p>We use cookies to improve the store.</p>
<button id="cookie-accept">Accept all</button> <button id="cookie-reject">Reject all</button></div></div>
<script>
for (const [id, choice] of [['cookie-accept','accept'],['cookie-reject','reject']]) {
  document.getElementById(id).addEventListener('click', async () => {
    await fetch('/api/cookies',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({choice})});
    document.getElementById('cookie-backdrop').remove();
  });
}
</script>`;

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

const listingPage = (s) =>
  layout(
    'Products',
    s,
    `<h1>Products</h1>
<ul><li><a href="/products/${PRODUCT.slug}">${PRODUCT.name}</a> ${tl(PRODUCT.price)}</li></ul>`,
  );

// A "Reject" button that is not a cookie banner. The crawl must never click it.
const returnsPage = (s) =>
  layout(
    'Return requests',
    s,
    `<h1>Return requests</h1>
<form id="f"><p>Request R-1: Ceramic Mug</p><button type="submit">Reject</button></form>`,
    `document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  await fetch('/api/returns/reject',{method:'POST'});
});`,
  );

const checkoutStart = (s) =>
  layout(
    'Checkout',
    s,
    `<h1>Checkout</h1><p>${cartCount(s)} item(s), total ${tl(cartTotal(s))}</p>
<h2>New customer</h2>
<p>You do not need an account.</p>
<button id="guest">Continue as guest</button>`,
    `document.getElementById('guest').addEventListener('click',()=>{location.href='/checkout/contact'});`,
  );

// The login-wall bug: checkout needs a sign-in and has no guest option. The form does not send anything.
const loginWall = (s) =>
  layout(
    'Sign in',
    s,
    `<h1>Sign in to check out</h1>
<form id="f">
<label for="login-email">Email</label><input id="login-email" type="email" autocomplete="username" required>
<label for="login-password">Password</label><input id="login-password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>`,
    `document.getElementById('f').addEventListener('submit', (e) => e.preventDefault());`,
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

// textMode mimics a Next.js server action: the code is inside a text/x-component body,
// and the first response of the click has no code.
const verifyPhonePage = (s, textMode = false) =>
  layout(
    'Verify phone',
    s,
    `<h1>Verify your phone</h1>
<button id="send">Send code</button>
<label for="code">Verification code</label><input id="code" inputmode="numeric" autocomplete="one-time-code">
<button id="verify">Verify</button>
<p id="ok" data-testid="phone-verified" hidden>Phone verified</p>
<div id="error" role="alert" hidden></div>
<p><a href="https://example.com/help" target="_blank">Help center</a></p>`,
    `const err = document.getElementById('error');
document.getElementById('send').addEventListener('click', async () => {
  if (${textMode}) {
    await fetch('/api/otp/send-code-text?step=check',{method:'POST'});
    await fetch('/api/otp/send-code-text',{method:'POST'});
  } else {
    await fetch('/api/otp/send-code',{method:'POST'});
  }
});
document.getElementById('verify').addEventListener('click', async () => {
  const r = await fetch('/api/otp/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value})});
  if (r.ok) { document.getElementById('ok').hidden = false; err.hidden = true; }
  else { err.textContent = 'The code is wrong.'; err.hidden = false; }
});`,
  );

const paymentPage = (s) =>
  layout(
    'Payment',
    s,
    `<h1>Payment</h1>
<iframe title="Secure card payment input" src="/pay/card-frame" height="170"></iframe>
${s.redirectFrame ? '<iframe src="/frame/out" height="60"></iframe>' : ''}
<label class="terms"><input type="checkbox" id="terms" required> I accept the terms</label>
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
  if (!document.getElementById('terms').checked) return showError('Accept the terms to continue.');
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

// A same-host iframe and a same-host fetch. Both redirect to hosts outside the allowlist.
const redirectsPage = (s) =>
  layout(
    'Partner content',
    s,
    `<h1>Partner content</h1>
<iframe title="Partner frame" src="/frame/out" height="60"></iframe>
<img alt="Partner pixel" src="/img/out" width="1" height="1">
<button id="load">Load data</button>
<p id="state" data-testid="load-state">Not loaded</p>`,
    `new EventSource('/events/out').onerror = (e) => e.target.close();
document.getElementById('load').addEventListener('click', async () => {
  const state = document.getElementById('state');
  try {
    await fetch('/api/redirect-out');
    state.textContent = 'Request done';
  } catch {
    state.textContent = 'Request failed';
  }
});`,
  );

const chainFormPage = (s) =>
  layout(
    'Send form',
    s,
    `<h1>Send form</h1><form method="post" action="/chain/post"><input name="note" value="test"><button>Send</button></form>`,
  );

const sessionPage = (s, signedIn) =>
  layout(
    'Session',
    s,
    `<h1>Session</h1><p data-testid="login-state">${signedIn ? 'Signed in' : 'Signed out'}</p>`,
  );

// A page behind basic auth. It loads data from its own host and from a "third-party" host (127.0.0.1).
const stagingPage = (s, thirdParty) =>
  layout(
    'Staging',
    s,
    `<h1>Staging</h1><p data-testid="auth-state">Authorized</p>
<button id="load">Load data</button>
<p id="state" data-testid="data-state">Not loaded</p>`,
    `document.getElementById('load').addEventListener('click', async () => {
  const state = document.getElementById('state');
  fetch('${thirdParty}/third-party/api', { mode: 'no-cors' }).catch(() => {});
  try {
    const r = await fetch('/staging-only/api');
    state.textContent = r.ok ? 'Data loaded' : 'Data denied';
  } catch {
    state.textContent = 'Data denied';
  }
});`,
  );

const successPage = (s, orderId) =>
  layout(
    'Order placed',
    s,
    `<h1>Thank you for your order</h1><p>Order number: <strong data-testid="order-number">${esc(orderId)}</strong></p>`,
  );

export function startDemoStore({
  port = 4173,
  host = '127.0.0.1',
  bugs = [],
  basicAuth = { username: 'demo', password: 'demo-test-pass' },
} = {}) {
  const sessions = new Map();
  const payments = new Map();
  let activeBugs = new Set(bugs);
  const stats = { orders: 0, payments: 0, return_rejects: 0, cookieAccepted: 0, contacts: 0 };
  // Codes that send-code returned. Tests use them to check that results never show a code.
  const issuedOtps = [];
  // One entry for each request to a basic auth route: the host and if the request had an Authorization header.
  const authRequests = [];
  const outsideHits = [];

  function session(req, res) {
    const sid = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (sid && sessions.has(sid)) return sessions.get(sid);
    const id = randomBytes(9).toString('base64url');
    const s = {
      id,
      cart: [],
      contact: null,
      paid: false,
      otp: null,
      cookieChoice: null,
      cookieBanner: false,
      redirectFrame: false,
    };
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
  const redirect = (res, location, status = 302) => {
    res.writeHead(status, { location });
    res.end();
  };
  const html = (res, body, status = 200) => send(res, status, 'text/html; charset=utf-8', body);
  const json = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const s = session(req, res);
    const p = url.pathname;
    const m = req.method ?? 'GET';
    s.cookieBanner = activeBugs.has('cookie-banner') && !s.cookieChoice;
    const loginRequired = activeBugs.has('login-wall');
    s.redirectFrame = activeBugs.has('redirect-frame');

    if (m === 'GET' && (p.startsWith('/staging-only') || p.startsWith('/third-party/'))) {
      const header = req.headers.authorization;
      authRequests.push({ host: req.headers.host ?? '', path: p, authorization: header !== undefined });
      const expected = `Basic ${Buffer.from(`${basicAuth.username}:${basicAuth.password}`).toString('base64')}`;
      if (p.startsWith('/third-party/') || header !== expected) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="staging"', 'content-type': 'text/plain' });
        return res.end('Unauthorized');
      }
      if (p === '/staging-only/api') return json(res, 200, { ok: true });
      if (p === '/staging-only/go') return redirect(res, '/staging-only');
      const thirdParty = `http://127.0.0.1:${(req.headers.host ?? '').split(':')[1] ?? ''}`;
      return html(res, stagingPage(s, thirdParty));
    }
    const outside = `http://127.0.0.1:${(req.headers.host ?? '').split(':')[1] ?? ''}/outside`;
    if (p.startsWith('/outside/') && (req.headers.host ?? '').startsWith('127.0.0.1')) {
      outsideHits.push(`${m} ${p}`);
      return send(res, 200, 'text/plain', 'outside');
    }
    if (m === 'GET' && p === '/spoof-header') {
      // A site page that sends the error header of the guard proxy. The runner must not trust it.
      res.setHeader('x-checkout-test-guard-error', 'ECONNREFUSED');
      return html(res, layout('Spoof', s, '<h1>Spoof</h1>'));
    }
    if (m === 'GET' && p === '/go/out') return redirect(res, `${outside}/landing`);
    if (m === 'GET' && p === '/img/out') return redirect(res, `${outside}/img`);
    if (m === 'GET' && p === '/go/out-tls') {
      return redirect(res, `${outside.replace('http:', 'https:')}/tls`);
    }
    if (m === 'GET' && p === '/events/out') return redirect(res, `${outside}/events`);
    if (m === 'GET' && p === '/chain/a') return redirect(res, '/chain/b');
    if (m === 'GET' && p === '/chain/b') return redirect(res, '/chain/c');
    if (m === 'GET' && p === '/chain/c') return redirect(res, `${outside}/chain`);
    if (m === 'GET' && p === '/chain/form') return html(res, chainFormPage(s));
    if (m === 'POST' && p === '/chain/post') return redirect(res, '/chain/post2', 307);
    if (m === 'POST' && p === '/chain/post2') return redirect(res, `${outside}/post`, 307);
    if (m === 'GET' && p === '/tp/redirect') return redirect(res, 'http://blocked.invalid/tp');
    if (m === 'GET' && p === '/go/in') return redirect(res, `/products/${PRODUCT.slug}`);
    if (m === 'GET' && p === '/frame/out') return redirect(res, 'http://pay.example.invalid/card');
    if (m === 'GET' && p === '/api/redirect-out') return redirect(res, `${outside}/api`);
    if (m === 'GET' && p === '/redirects') return html(res, redirectsPage(s));
    if (m === 'GET' && p === '/login-cookie') {
      const prev = res.getHeader('set-cookie');
      res.setHeader('set-cookie', [
        ...(Array.isArray(prev) ? prev : prev ? [String(prev)] : []),
        'demo_login=yes; Path=/; HttpOnly; SameSite=Lax',
      ]);
      return redirect(res, '/account/session');
    }
    if (m === 'GET' && p === '/account/session') {
      return html(res, sessionPage(s, /(?:^|;\s*)demo_login=yes(?:;|$)/.test(req.headers.cookie ?? '')));
    }

    if (m === 'GET' && p === '/') return html(res, productPage(s));
    if (m === 'GET' && p === '/products') return html(res, listingPage(s));
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
    if (m === 'POST' && p === '/api/cookies') {
      const body = await readJson(req);
      if (body.choice !== 'accept' && body.choice !== 'reject')
        return json(res, 400, { error: 'invalid choice' });
      s.cookieChoice = body.choice;
      if (body.choice === 'accept') stats.cookieAccepted++;
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/account/returns') return html(res, returnsPage(s));
    if (m === 'POST' && p === '/api/returns/reject') {
      stats.return_rejects++;
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/account/verify-phone') return html(res, verifyPhonePage(s));
    if (m === 'GET' && p === '/account/verify-phone-text') return html(res, verifyPhonePage(s, true));
    if (m === 'POST' && p === '/api/otp/send-code-text') {
      const head = '0:{"a":"$@1","f":""}\n';
      if (url.searchParams.get('step') === 'check') {
        return send(res, 200, 'text/x-component', `${head}1:{"success":true,"otpRequired":false}`);
      }
      s.otp = String(10000 + (randomBytes(4).readUInt32BE(0) % 90000));
      issuedOtps.push(s.otp);
      return send(
        res,
        200,
        'text/x-component',
        `${head}1:{"success":false,"otpRequired":true,"message":"OTP required (Kod: ${s.otp})"}`,
      );
    }
    if (m === 'POST' && p === '/api/otp/send-code') {
      s.otp = String(10000 + (randomBytes(4).readUInt32BE(0) % 90000));
      issuedOtps.push(s.otp);
      return json(res, 200, { data: { otp_code: s.otp, expires_in: 180 } });
    }
    if (m === 'POST' && p === '/api/otp/verify') {
      const body = await readJson(req);
      if (!s.otp || String(body.code) !== s.otp) return json(res, 422, { error: 'wrong code' });
      s.otp = null;
      return json(res, 200, { verified: true });
    }
    if (m === 'GET' && p === '/checkout') return html(res, loginRequired ? loginWall(s) : checkoutStart(s));
    if (m === 'GET' && p === '/checkout/contact')
      return html(res, loginRequired ? loginWall(s) : contactPage(s));
    if (m === 'POST' && p === '/api/checkout/contact') {
      if (loginRequired) return json(res, 401, { error: 'sign in required' });
      stats.contacts++;
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

  // A minimal WebSocket endpoint at /ws: it answers the handshake and records the host. It sends no frames.
  const wsHits = [];
  const wsSockets = new Set();
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws' || typeof key !== 'string') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    wsHits.push(req.headers.host ?? '');
    wsSockets.add(socket);
    socket.on('close', () => wsSockets.delete(socket));
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('error', () => socket.destroy());
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `http://localhost:${actualPort}`,
        port: actualPort,
        stats,
        issuedOtps,
        authRequests,
        outsideHits,
        wsHits,
        setBugs: (list) => {
          activeBugs = new Set(list);
        },
        close: () =>
          new Promise((r) => {
            // An upgraded WebSocket stays open until it is destroyed, and server.close() waits for it.
            for (const ws of wsSockets) ws.destroy();
            server.close(() => r());
            server.closeAllConnections();
          }),
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
