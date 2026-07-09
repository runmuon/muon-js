/** Local HTTP fixture for network tests — real sockets, scriptable faults. */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { gunzipSync } from 'node:zlib';

export type ServerMode = 'ok' | 'garbage-200' | 'garbage-500' | 'empty-200' | 'stall' | number;

export interface ReceivedBatch {
  events: Array<Record<string, unknown>>;
  headers: http.IncomingHttpHeaders;
  bodyKeys: string[];
  raw: Buffer;
  url: string;
  /** HTTP status this batch was answered with (0 = stalled, never answered). */
  status: number;
}

export interface FixtureServer {
  url: string;
  port: number;
  batches: ReceivedBatch[];
  requests: () => number;
  setMode: (mode: ServerMode) => void;
  allEvents: () => Array<Record<string, unknown>>;
  /** Events from batches that were answered with a 2xx (i.e. actually accepted). */
  okEvents: () => Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

export async function startServer(initialMode: ServerMode = 'ok'): Promise<FixtureServer> {
  let mode: ServerMode = initialMode;
  let requestCount = 0;
  const batches: ReceivedBatch[] = [];
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requestCount += 1;
      const raw = Buffer.concat(chunks);
      let events: Array<Record<string, unknown>> = [];
      let bodyKeys: string[] = [];
      try {
        const decoded = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
        const parsed: unknown = JSON.parse(decoded.toString('utf8'));
        if (Array.isArray(parsed)) {
          events = parsed as Array<Record<string, unknown>>;
          bodyKeys = ['<bare-array>'];
        } else if (parsed !== null && typeof parsed === 'object') {
          bodyKeys = Object.keys(parsed);
          const evs = (parsed as { events?: unknown }).events;
          if (Array.isArray(evs)) events = evs as Array<Record<string, unknown>>;
        }
      } catch {
        // unparseable request body — record it raw
      }
      const responseStatus = mode === 'stall' ? 0 : mode === 'ok' || mode === 'garbage-200' || mode === 'empty-200' ? 200 : mode === 'garbage-500' ? 500 : mode;
      batches.push({ events, headers: req.headers, bodyKeys, raw, url: req.url ?? '', status: responseStatus });

      if (mode === 'stall') return; // accept, never answer
      if (mode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ processed: events.length, cache: 'tok-1' }));
        return;
      }
      if (mode === 'garbage-200') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('<<<this is not json>>>');
        return;
      }
      if (mode === 'garbage-500') {
        res.writeHead(500, { 'content-type': 'text/html' });
        res.end('<html>oops');
        return;
      }
      if (mode === 'empty-200') {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(mode, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `status ${mode}` }));
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    batches,
    requests: () => requestCount,
    setMode: (m) => {
      mode = m;
    },
    allEvents: () => batches.flatMap((b) => b.events),
    okEvents: () => batches.filter((b) => b.status >= 200 && b.status < 300).flatMap((b) => b.events),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A TCP port that nothing listens on (opened then closed). */
export async function refusedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
