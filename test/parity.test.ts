// Tests del comparador de paridad (lógica pura, sin red).
import { describe, expect, it } from 'vitest';
import { compareParity, type LegacyAction } from '../tools/parity/compare.js';
import type { Envelope } from '../src/shared/events/envelope.js';

const added = (ticketId: string, producto: string, qty = 1): Envelope => ({
  id: crypto.randomUUID(),
  type: 'orders.item.added.v1',
  version: 1,
  occurredAt: new Date().toISOString(),
  actor: { userId: 'mesero-1', deviceId: 'POS-TEST' },
  payload: { ticketId, itemId: 'i1', productId: producto, qty, clientId: 'amalay' },
});

const cancelled = (
  ticketId: string,
  producto: string,
  qty = 1,
  approvedBy: string | null = 'Daniel',
): Envelope => ({
  id: crypto.randomUUID(),
  type: 'orders.item.cancelled.v1',
  version: 1,
  occurredAt: new Date().toISOString(),
  actor: { userId: 'mesero-1', deviceId: 'POS-TEST' },
  payload: { ticketId, itemId: 'i1', productId: producto, qty, clientId: 'amalay' },
  ...(approvedBy
    ? {
        audit: {
          requestedBy: 'mesero-1',
          approvedBy,
          reason: 'test',
          before: { qty },
          after: { qty: 0 },
        },
      }
    : {}),
});

const legacyAdded = (order_id: string, item: string, cantidad = 1): LegacyAction => ({
  order_id,
  action: 'item_added',
  actor: 'mesero-1',
  details: { item, cantidad },
});

const legacyCancelled = (
  order_id: string,
  item: string,
  cantidad = 1,
  approved_by = 'Daniel',
): LegacyAction => ({
  order_id,
  action: 'item_cancelled',
  actor: 'mesero-1',
  reason: 'test',
  approved_by,
  details: { item, cantidad },
});

describe('comparador de paridad', () => {
  it('paridad perfecta: misma historia en ambos streams', () => {
    const legacy = [
      legacyAdded('t1', 'CAFE LATTE CALIENTE'),
      legacyAdded('t1', 'CROISSANT', 2),
      legacyCancelled('t1', 'CROISSANT', 2),
    ];
    const events = [
      added('t1', 'CAFE LATTE CALIENTE'),
      added('t1', 'CROISSANT', 2),
      cancelled('t1', 'CROISSANT', 2),
    ];
    const r = compareParity(legacy, events);
    expect(r.ok).toBe(true);
    expect(r.matched).toBe(3);
    expect(r.diffs).toHaveLength(0);
  });

  it('detecta evento faltante (quedó en cola offline)', () => {
    const legacy = [legacyAdded('t1', 'LATTE'), legacyAdded('t1', 'BAGEL')];
    const events = [added('t1', 'LATTE')];
    const r = compareParity(legacy, events);
    expect(r.ok).toBe(false);
    expect(r.diffs).toEqual([
      expect.objectContaining({ ticketId: 't1', missingIn: 'events' }),
    ]);
  });

  it('detecta evento duplicado o de más (falta en legado)', () => {
    const legacy = [legacyAdded('t1', 'LATTE')];
    const events = [added('t1', 'LATTE'), added('t1', 'LATTE')];
    const r = compareParity(legacy, events);
    expect(r.ok).toBe(false);
    expect(r.diffs).toEqual([
      expect.objectContaining({ ticketId: 't1', missingIn: 'legacy' }),
    ]);
  });

  it('anulación de orden: 1 fila legada con N items ≡ N eventos voidOrder', () => {
    const legacy: LegacyAction[] = [
      {
        order_id: 't9',
        action: 'order_cancelled',
        actor: 'mesero-1',
        reason: 'cliente se fue',
        approved_by: 'Daniel',
        details: {
          items: [
            { nombre: 'LATTE', cantidad: 1, subtotal: 85 },
            { nombre: 'BAGEL', cantidad: 2, subtotal: 120 },
          ],
        },
      },
    ];
    const events = [
      cancelled('t9', 'LATTE', 1),
      cancelled('t9', 'BAGEL', 2),
    ];
    const r = compareParity(legacy, events);
    expect(r.ok).toBe(true);
    expect(r.matched).toBe(2);
  });

  it('mismatch de qty NO matchea (qty es parte de la llave)', () => {
    const legacy = [legacyAdded('t1', 'LATTE', 2)];
    const events = [added('t1', 'LATTE', 1)];
    const r = compareParity(legacy, events);
    expect(r.ok).toBe(false);
    expect(r.diffs).toHaveLength(2); // falta el de qty=2 en events y sobra el de qty=1
  });

  it('cancelación sin approvedBy en events se marca aunque haya match', () => {
    const legacy = [legacyCancelled('t1', 'LATTE', 1, '')];
    const events = [cancelled('t1', 'LATTE', 1, null)];
    const r = compareParity(legacy, events);
    expect(r.unauditedCancellations).toBe(1);
    expect(r.ok).toBe(false);
  });

  it('acciones legadas sin contraparte shadow (item_modified) se ignoran', () => {
    const legacy: LegacyAction[] = [
      { order_id: 't1', action: 'item_modified', actor: 'mesero-1', details: { item: 'LATTE' } },
      legacyAdded('t1', 'LATTE'),
    ];
    const events = [added('t1', 'LATTE')];
    const r = compareParity(legacy, events);
    expect(r.ok).toBe(true);
    expect(r.legacyOps).toBe(1);
  });
});
