// mail-engine/src/server.ts — the engine's own HTTP API.
//
// This is the "Mail API" box at the top of the section 4 pipeline, and the port Postfix pipes
// inbound mail into. It is deliberately node:http with no framework: the engine has to start when
// the application does not, and every dependency is one more thing that can stop it starting.
//
// BINDING. 127.0.0.1 by default. An SMTP submission API reachable from the network with no
// authentication is an open relay wearing a JSON hat, so the default is a port nothing outside this
// host can reach, and moving it off loopback without a shared secret produces a startup warning.
//
// AUTHENTICATION. The same HMAC as the outbound event contract, in the other direction: the caller
// signs "<timestamp>.<body>" with the shared secret. Symmetric, replay-resistant, and it means
// there is exactly one authentication mechanism in this system to get right.
//
// THE GAUGES ARE SAMPLED, NOT COUNTED. Queue depth, dead letters and unpublished events are read
// from the spool at scrape time rather than tracked incrementally. Counters that mirror a directory
// always drift from it eventually; a number that is measured cannot.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Engine } from './engine.js';
import { verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from './publish/http.js';
import { M, metrics } from './metrics.js';
import { reasonOf } from './logger.js';
import { maximumQueueLifetimeMs, humanDuration } from './queue/retry.js';

/** Requests older than this are refused even with a valid signature. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 30 * 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limit) throw new Error(`request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createEngineServer(engine: Engine) {
  const { config, logger, pipeline, spool, publisher, inbound, keys, worker } = engine;
  const log = logger.child({ component: 'engine-api' });

  /**
   * Signature check. Returns null when the request is allowed, or an error string when it is not.
   * With no secret configured the API is open — and only on loopback, which configWarnings() shouts
   * about at startup if that is not where it is bound.
   */
  const authorize = (req: IncomingMessage, body: Buffer): string | null => {
    if (!config.appSharedSecret) return null;
    const signature = String(req.headers[SIGNATURE_HEADER] || '');
    const timestamp = String(req.headers[TIMESTAMP_HEADER] || '');
    if (!signature || !timestamp) return 'missing signature';
    const age = Math.abs(Date.now() - Number(timestamp));
    if (!Number.isFinite(age) || age > MAX_CLOCK_SKEW_MS) return 'stale or unreadable timestamp';
    if (!verifySignature(config.appSharedSecret, timestamp, body.toString('utf8'), signature)) return 'bad signature';
    return null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;
    const started = Date.now();

    try {
      // ---- health, unauthenticated by design (a probe should not need a secret) ----
      if (route === 'GET /healthz') {
        const stats = await spool.stats();
        return json(res, 200, {
          ok: true,
          hostname: config.hostname,
          domains: config.domains,
          transport: engine.transport.name,
          deliveryEnabled: config.deliveryEnabled,
          workerRunning: worker.isRunning(),
          queue: stats,
          eventsPending: await publisher.pending(),
          inboundPending: await inbound.pending(),
          dkim: await keys.status(config.domains),
          maxQueueLifetime: humanDuration(maximumQueueLifetimeMs({
            maxAttempts: config.maxAttempts, baseDelayMs: config.retryBaseDelayMs,
            factor: config.retryFactor, maxDelayMs: config.retryMaxDelayMs, jitter: config.retryJitter,
          })),
          warnings: engine.warnings,
        });
      }

      if (route === 'GET /metrics') {
        const stats = await spool.stats();
        metrics.gauge(M.queueDepth, 'Messages waiting in the queue', stats.ready + stats.deferred);
        metrics.gauge(M.queueDeferred, 'Messages waiting for their next attempt', stats.deferred);
        metrics.gauge(M.queueDeadLetters, 'Messages that ran out of retries', stats.dead);
        metrics.gauge(M.eventsPending, 'Delivery events the application has not accepted', await publisher.pending());
        const text = metrics.render();
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        return res.end(text);
      }

      if (route === 'GET /stats') {
        return json(res, 200, {
          queue: await spool.stats(),
          eventsPending: await publisher.pending(),
          inboundPending: await inbound.pending(),
          suppressions: (await publisher.listSuppressions()).length,
          metrics: metrics.snapshot(),
        });
      }

      // ---- everything below requires the signature -------------------------------
      const body = await readBody(req);
      const denied = authorize(req, body);
      if (denied) {
        log.warn('request refused', { route, reason: denied, remote: req.socket.remoteAddress });
        return json(res, 401, { ok: false, error: denied });
      }

      if (route === 'POST /submit') {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        } catch {
          return json(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const result = await pipeline.submit(payload as unknown as Parameters<typeof pipeline.submit>[0]);
        // 202 for accepted: the message is queued, not delivered, and the difference is the entire
        // subject of this engine. A 200 here would be a claim nobody can honour yet.
        return json(res, result.accepted ? 202 : 422, { ok: result.accepted, ...result });
      }

      if (route === 'POST /inbound') {
        const envelopeTo = String(req.headers['x-mail-to'] || '').split(',').map((s) => s.trim()).filter(Boolean);
        const envelopeFrom = String(req.headers['x-mail-from'] || '').trim();
        if (!envelopeTo.length) return json(res, 400, { ok: false, error: 'x-mail-to is required' });
        const outcome = await inbound.process(body, { from: envelopeFrom, to: envelopeTo });
        if (outcome.accepted) return json(res, 200, { ok: true, ...outcome });
        // The status code is what the piping MTA turns into an SMTP reply: 4xx keeps the message at
        // the sender, 5xx tells them to stop. Getting this backwards either loses mail or creates a
        // retry loop, so it is driven by the processor's own `retryable` verdict.
        return json(res, outcome.retryable ? 503 : 550, { ok: false, ...outcome });
      }

      if (route === 'POST /queue/flush') {
        const pass = await worker.runOnce();
        const events = await publisher.flush();
        const delivered = await inbound.flushInbound();
        return json(res, 200, { ok: true, pass, eventsPublished: events, inboundDelivered: delivered });
      }

      if (route === 'GET /suppressions') {
        return json(res, 200, { ok: true, entries: await publisher.listSuppressions() });
      }

      if (req.method === 'DELETE' && url.pathname.startsWith('/suppressions/')) {
        const address = decodeURIComponent(url.pathname.slice('/suppressions/'.length));
        const removed = await publisher.unsuppress(address);
        return json(res, removed ? 200 : 404, { ok: removed, recipient: address });
      }

      if (route === 'GET /queue/dead') {
        const entries = await spool.listDead(50);
        return json(res, 200, {
          ok: true,
          entries: entries.map((e) => ({
            messageId: e.messageId, to: e.pending, subject: e.message.subject,
            attempts: e.attempt, deadAt: e.deadAt ? new Date(e.deadAt).toISOString() : null, reason: e.deadReason,
          })),
        });
      }

      if (route === 'POST /queue/requeue') {
        const { messageId } = JSON.parse(body.toString('utf8') || '{}') as { messageId?: string };
        if (!messageId) return json(res, 400, { ok: false, error: 'messageId is required' });
        const ok = await spool.requeueDead(messageId);
        return json(res, ok ? 200 : 404, { ok, messageId });
      }

      return json(res, 404, { ok: false, error: `no route for ${route}` });
    } catch (err) {
      log.error('request failed', { route, reason: reasonOf(err), ms: Date.now() - started });
      metrics.counter(M.mtaErrors, 'Errors raised by the MTA layer', { stage: 'api' });
      return json(res, 500, { ok: false, error: reasonOf(err) });
    }
  });

  return server;
}

/** Start the API and the delivery worker together, with a shutdown that drains rather than drops. */
export async function startEngine(engine: Engine): Promise<() => Promise<void>> {
  const server = createEngineServer(engine);
  await new Promise<void>((resolve) => server.listen(engine.config.httpPort, engine.config.httpHost, resolve));
  engine.logger.info('mail engine listening', {
    host: engine.config.httpHost, port: engine.config.httpPort, hostname: engine.config.hostname,
  });

  // Not awaited: start() is the worker's own loop and only returns when it is told to stop.
  void engine.worker.start();

  // The application may have been unreachable for a while. Try the backlog straight away rather
  // than waiting for the next message to trigger a flush.
  void engine.publisher.flush().catch(() => 0);
  void engine.inbound.flushInbound().catch(() => 0);

  let closing = false;
  return async () => {
    if (closing) return;
    closing = true;
    engine.logger.info('shutting down');
    engine.worker.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await engine.transport.close().catch(() => { /* best effort */ });
    // One last attempt to hand over what is already recorded. Anything still unsent stays on disk.
    await engine.publisher.flush().catch(() => 0);
    engine.logger.info('shutdown complete', {
      eventsPending: await engine.publisher.pending().catch(() => -1),
      inboundPending: await engine.inbound.pending().catch(() => -1),
    });
  };
}
