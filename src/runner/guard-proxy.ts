import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

export interface GuardProxyInput {
  /** The host rule of the guard. The proxy checks the host only, because a CONNECT tunnel has no path. */
  isHostAllowed(hostname: string): boolean;
  /** Called for each refused request. The URL has no user name or password. A CONNECT URL has no path. */
  onBlocked(url: string): void;
}

export interface GuardProxy {
  /** The proxy address for Playwright, for example "http://127.0.0.1:53111". */
  server: string;
  close(): Promise<void>;
}

/** Set on the 502 response when the proxy cannot reach an allowed host. The runner reads it. */
export const PROXY_ERROR_HEADER = 'x-checkout-test-guard-error';

/** Errors that mean that the host cannot be reached at all. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
]);

/** Headers that apply to one connection only. The proxy does not forward them. */
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * A forward proxy on 127.0.0.1 for one guarded browser. It is the network-layer backstop of the host guard:
 * every request of the browser goes through it, also redirect follow-ups that the route handler never sees.
 * It forwards plain http requests and tunnels CONNECT requests without TLS interception.
 * A host that fails the host rule gets 403 and never gets a request.
 */
export async function startGuardProxy(input: GuardProxyInput): Promise<GuardProxy> {
  const sockets = new Set<Duplex>();
  const track = (s: Duplex) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  };

  const server = createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:' || !input.isHostAllowed(target.hostname)) {
      report(input, `${target.protocol}//${target.host}${target.pathname}${target.search}`);
      res
        .writeHead(403, { 'content-type': 'text/plain' })
        .end('Blocked by the checkout-test-mcp host guard.');
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined && !HOP_HEADERS.has(k)) headers[k] = v;
    }
    const upstream = httpRequest(
      {
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (up) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (v !== undefined && !HOP_HEADERS.has(k)) out[k] = v;
        }
        res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
        up.pipe(res);
      },
    );
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      // A host that the proxy cannot reach gets a 502 that the runner reads as target_unreachable.
      // A connection that breaks later breaks the browser connection too, as it does without the proxy.
      if (res.headersSent || !UNREACHABLE_CODES.has(err.code ?? '')) {
        res.destroy();
        return;
      }
      res.writeHead(502, { 'content-type': 'text/plain', [PROXY_ERROR_HEADER]: err.code ?? 'error' });
      res.end('The checkout-test-mcp guard proxy could not reach the host.');
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('connection', track);

  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    let target: URL;
    try {
      target = new URL(`http://${req.url ?? ''}`);
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const port = Number(target.port || 443);
    if (!input.isHostAllowed(target.hostname)) {
      report(input, `https://${target.hostname}${port === 443 ? '' : `:${port}`}/`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream: Socket = connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    let open = false;
    upstream.once('connect', () => {
      open = true;
    });
    upstream.on('error', () => {
      // Chromium shows a failed tunnel as ERR_TUNNEL_CONNECTION_FAILED. An open tunnel only closes.
      if (open) client.destroy();
      else client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    client.on('close', () => upstream.destroy());
  });

  // Chromium sends WebSockets through CONNECT. A plain upgrade request is refused.
  server.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function report(input: GuardProxyInput, url: string): void {
  try {
    input.onBlocked(url);
  } catch {
    // A listener error must not keep the refused request open.
  }
}
