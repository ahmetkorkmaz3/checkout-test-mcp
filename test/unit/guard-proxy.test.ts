import { createServer, request, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GuardProxy, PROXY_ERROR_HEADER, startGuardProxy } from '../../src/runner/guard-proxy.js';

// A local upstream server. The proxy allows only "localhost". All "outside" hosts are .invalid or a refused port.
let upstream: Server;
let upstreamPort = 0;
let proxy: GuardProxy;
let proxyPort = 0;
const blocked: string[] = [];
const hits: string[] = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream');
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const addr = upstream.address();
  upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;
  proxy = await startGuardProxy({
    isHostAllowed: (host) => host === 'localhost',
    onBlocked: (url) => blocked.push(url),
  });
  proxyPort = Number(new URL(proxy.server).port);
});

afterAll(async () => {
  await proxy.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

function viaProxy(path: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connectVia(authority: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('guard proxy', () => {
  it('forwards an http request to an allowed host', async () => {
    const res = await viaProxy(`http://localhost:${upstreamPort}/ok?x=1`);
    expect(res.status).toBe(200);
    expect(res.body).toBe('upstream');
    expect(hits).toContain('GET /ok?x=1');
  });

  it('refuses an http request to a host outside the allowlist and reports it without credentials', async () => {
    const before = hits.length;
    const res = await viaProxy(`http://user:pw@127.0.0.1:${upstreamPort}/secret`);
    expect(res.status).toBe(403);
    expect(hits.length).toBe(before);
    expect(blocked).toContain(`http://127.0.0.1:${upstreamPort}/secret`);
    expect(blocked.join(' ')).not.toContain('pw');
  });

  it('refuses a CONNECT tunnel to a host outside the allowlist and reports the host', async () => {
    expect(await connectVia('outside.invalid:443')).toBe(403);
    expect(await connectVia(`127.0.0.1:${upstreamPort}`)).toBe(403);
    expect(blocked).toContain('https://outside.invalid/');
    expect(blocked).toContain(`https://127.0.0.1:${upstreamPort}/`);
  });

  it('opens a CONNECT tunnel to an allowed host', async () => {
    expect(await connectVia(`localhost:${upstreamPort}`)).toBe(200);
  });

  it('answers 502 with the error header when an allowed host cannot be reached', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const addr = closed.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await new Promise<void>((r) => closed.close(() => r()));
    const res = await viaProxy(`http://localhost:${port}/`);
    expect(res.status).toBe(502);
    expect(res.headers[PROXY_ERROR_HEADER]).toBe('ECONNREFUSED');
  });

  it('refuses a request that is not in absolute form', async () => {
    const res = await viaProxy('/relative');
    expect(res.status).toBe(400);
  });
});
