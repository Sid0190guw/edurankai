import { describe, it, expect, vi, beforeEach } from 'vitest';
import { on, emit, recentEventFailures, eventRegistry } from './events';

describe('event bus', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));

  it('delivers a payload to every subscriber', async () => {
    const seen: string[] = [];
    const off1 = on<{ id: string }>('t.a', { name: 'one' }, (p) => { seen.push('one:' + p.id); });
    const off2 = on<{ id: string }>('t.a', { name: 'two' }, (p) => { seen.push('two:' + p.id); });

    const r = await emit('t.a', { id: 'x' });
    expect(seen.sort()).toEqual(['one:x', 'two:x']);
    expect(r.handled).toBe(2);
    expect(r.failed).toEqual([]);
    off1(); off2();
  });

  // The bug this whole design exists to prevent: one failing side effect silently skipping others.
  it('isolates a throwing handler so siblings still run', async () => {
    const seen: string[] = [];
    const off1 = on('t.b', { name: 'boom' }, () => { throw new Error('handler exploded'); });
    const off2 = on('t.b', { name: 'fine' }, () => { seen.push('ran'); });

    const r = await emit('t.b', {});
    expect(seen).toEqual(['ran']);              // sibling still ran
    expect(r.handled).toBe(1);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].handler).toBe('boom');
    off1(); off2();
  });

  it('never throws out of emit, so a domain action cannot fail because of a listener', async () => {
    const off = on('t.c', { name: 'rejects' }, async () => { throw new Error('async boom'); });
    await expect(emit('t.c', {})).resolves.toBeDefined();
    off();
  });

  // Swallowing is what let the AICTE cast bug hide for months.
  it('records failures rather than swallowing them', async () => {
    const off = on('t.d', { name: 'noisy' }, () => { throw new Error('recorded please'); });
    await emit('t.d', {});
    const f = recentEventFailures().filter((x) => x.event === 't.d');
    expect(f.length).toBeGreaterThan(0);
    expect(f[f.length - 1].error).toContain('recorded please');
    off();
  });

  it('surfaces the real reason from a drizzle-style error cause', async () => {
    const off = on('t.e', { name: 'pg' }, () => {
      const e: any = new Error('UPDATE roles SET ...');   // message is only the failed SQL
      e.cause = { message: 'cannot cast type record to text[]' };
      throw e;
    });
    const r = await emit('t.e', {});
    expect(r.failed[0].error).toBe('cannot cast type record to text[]');
    off();
  });

  it('awaits async handlers before resolving', async () => {
    let done = false;
    const off = on('t.f', { name: 'slow' }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    await emit('t.f', {});
    expect(done).toBe(true);   // would be false if emit did not await
    off();
  });

  it('stamps meta and passes the actor through', async () => {
    let got: any = null;
    const off = on('t.g', { name: 'meta' }, (_p, meta) => { got = meta; });
    await emit('t.g', {}, { actorId: 'user-1', correlationId: 'corr-9' });
    expect(got.actorId).toBe('user-1');
    expect(got.correlationId).toBe('corr-9');
    expect(typeof got.emittedAt).toBe('string');
    off();
  });

  it('is a no-op when nothing is listening', async () => {
    const r = await emit('t.nobody', { a: 1 });
    expect(r.handled).toBe(0);
    expect(r.failed).toEqual([]);
  });

  it('unsubscribing stops delivery', async () => {
    let n = 0;
    const off = on('t.h', { name: 'counter' }, () => { n++; });
    await emit('t.h', {});
    off();
    await emit('t.h', {});
    expect(n).toBe(1);
  });

  it('reports what is wired up', async () => {
    const off = on('t.i', { name: 'introspect-me' }, () => {});
    const entry = eventRegistry().find((e) => e.event === 't.i');
    expect(entry?.handlers).toContain('introspect-me');
    off();
  });
});
