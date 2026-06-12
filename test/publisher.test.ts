import { describe, it, expect } from 'vitest';
import { EventPublisher, InMemoryQueueStorage } from '../src/shared/publisher/publish-event.js';
import { makeEnvelope, type Actor } from '../src/shared/events/envelope.js';
import { ORDERS_ITEM_ADDED_V1 } from '../src/shared/events/contracts.js';

const mesero: Actor = { userId: 'frida', deviceId: 'POS-01' };

function envelope() {
  return makeEnvelope(ORDERS_ITEM_ADDED_V1, 1, mesero, {
    ticketId: 'T-1',
    itemId: 'i-1',
    productId: 'latte',
    qty: 1,
  });
}

describe('EventPublisher — shadow mode offline-first', () => {
  it('publica a Supabase REST con on_conflict=id (reintento idempotente)', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const pub = new EventPublisher({
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'anon',
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return new Response('[]', { status: 201 });
      }) as typeof fetch,
    });

    pub.publish(envelope());
    await pub.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://x.supabase.co/rest/v1/events?on_conflict=id');
    const row = JSON.parse(calls[0]!.body);
    expect(row.type).toBe(ORDERS_ITEM_ADDED_V1);
    expect(row.occurred_at).toBeTruthy();
    expect(row.actor).toEqual(mesero);
    expect(pub.pending()).toBe(0);
  });

  it('sin internet: encola, NUNCA truena, y reenvía al reconectar en orden', async () => {
    let online = false;
    const sent: string[] = [];
    const errors: string[] = [];
    const pub = new EventPublisher({
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'anon',
      storage: new InMemoryQueueStorage(),
      onError: (m) => errors.push(m),
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        if (!online) throw new TypeError('fetch failed');
        sent.push(JSON.parse(String(init?.body)).id);
        return new Response('[]', { status: 201 });
      }) as typeof fetch,
    });

    const e1 = envelope();
    const e2 = envelope();
    pub.publish(e1); // no truena aunque no hay red
    pub.publish(e2);
    await pub.flush();
    expect(pub.pending()).toBe(2); // a salvo en la cola
    expect(errors.length).toBeGreaterThan(0);

    online = true; // reconecta
    await pub.flush();
    expect(sent).toEqual([e1.id, e2.id]); // orden preservado
    expect(pub.pending()).toBe(0);
  });

  it('evento rechazado por la BD (4xx) se descarta con log, no atora la cola', async () => {
    const errors: string[] = [];
    let calls = 0;
    const pub = new EventPublisher({
      supabaseUrl: 'https://x.supabase.co',
      supabaseKey: 'anon',
      onError: (m) => errors.push(m),
      fetchFn: (async () => {
        calls += 1;
        // p.ej. constraint sensitive_requires_audit
        return new Response('check constraint violation', { status: 400 });
      }) as typeof fetch,
    });

    pub.publish(envelope());
    await pub.flush();
    expect(calls).toBe(1);
    expect(pub.pending()).toBe(0); // descartado, no bloquea los siguientes
    expect(errors[0]).toContain('HTTP 400');
  });
});
