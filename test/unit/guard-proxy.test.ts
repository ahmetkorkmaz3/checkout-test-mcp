import { createServer, request, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type GuardProxy,
  PROXY_ERROR_HEADER,
  parseAuthority,
  startGuardProxy,
} from '../../src/runner/guard-proxy.js';

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
    if (req.url === '/spoof') {
      res.writeHead(200, { 'content-type': 'text/plain', [PROXY_ERROR_HEADER]: 'ECONNREFUSED' });
      res.end('site');
      return;
    }
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
    expect(res.headers[PROXY_ERROR_HEADER]).toBe(proxy.errorToken);
    expect(proxy.errorToken).toMatch(/^[0-9a-f]{32}$/);
  });

  it('removes the proxy error header from a site response', async () => {
    const res = await viaProxy(`http://localhost:${upstreamPort}/spoof`);
    expect(res.status).toBe(200);
    expect(res.headers[PROXY_ERROR_HEADER]).toBeUndefined();
  });

  it('reads a CONNECT authority without a default port', () => {
    expect(parseAuthority('example.test:80')).toEqual({ hostname: 'example.test', port: 80 });
    expect(parseAuthority('Example.TEST:443')).toEqual({ hostname: 'example.test', port: 443 });
    expect(parseAuthority('[::1]:8080')).toEqual({ hostname: '[::1]', port: 8080 });
    expect(parseAuthority('example.test')).toBeNull();
    expect(parseAuthority('example.test:0')).toBeNull();
    expect(parseAuthority('example.test:70000')).toBeNull();
    expect(parseAuthority('user@example.test:80')).toBeNull();
    expect(parseAuthority('a.test/x:80')).toBeNull();
  });

  it('adds one close listener to a kept-alive upstream socket, also after 30 requests', async () => {
    const warnings: Error[] = [];
    const onWarning = (w: Error) => warnings.push(w);
    process.on('warning', onWarning);
    const sockets = new Set<import('node:net').Socket>();
    const keep = createServer((req, res) => {
      sockets.add(req.socket);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    keep.keepAliveTimeout = 10_000;
    await new Promise<void>((r) => keep.listen(0, '127.0.0.1', () => r()));
    const addr = keep.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      for (let i = 0; i < 30; i++) {
        const res = await viaProxy(`http://localhost:${port}/n${i}`);
        expect(res.status).toBe(200);
      }
      // Warnings come on the next tick.
      await new Promise((r) => setImmediate(r));
      // One upstream socket served all requests, so the agent reused it.
      expect(sockets.size).toBe(1);
      expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([]);
    } finally {
      process.off('warning', onWarning);
      keep.closeAllConnections();
      await new Promise<void>((r) => keep.close(() => r()));
    }
  });

  it('closes an open upstream stream within 1 s of close()', async () => {
    let upstreamClosed = false;
    const stream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      req.socket.on('close', () => {
        upstreamClosed = true;
      });
    });
    await new Promise<void>((r) => stream.listen(0, '127.0.0.1', () => r()));
    const addr = stream.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const own = await startGuardProxy({ isHostAllowed: (h) => h === 'localhost', onBlocked: () => {} });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port: Number(new URL(own.server).port),
            path: `http://localhost:${port}/events`,
          },
          (res) => res.once('data', () => resolve()),
        );
        req.on('error', () => {});
        req.on('timeout', reject);
        req.end();
      });
      const started = Date.now();
      await own.close();
      await expect.poll(() => upstreamClosed, { timeout: 1000, interval: 20 }).toBe(true);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      stream.closeAllConnections();
      await new Promise<void>((r) => stream.close(() => r()));
    }
  });

  it('refuses a request that is not in absolute form', async () => {
    const res = await viaProxy('/relative');
    expect(res.status).toBe(400);
  });
});
