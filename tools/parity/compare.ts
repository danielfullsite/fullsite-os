// Comparador de paridad — Fase shadow del strangler.
//
// Compara el stream legado (pos_audit_log) contra el stream de eventos
// (tabla events) y reporta divergencias. READ-ONLY: no emite eventos ni
// escribe nada — es la herramienta que decide cuándo los eventos son
// dignos de convertirse en fuente de verdad.
//
// Mapeo legado ↔ shadow:
//   item_added                → orders.item.added.v1
//   item_cancelled            → orders.item.cancelled.v1 (sin voidOrder)
//   order_cancelled (N items) → N × orders.item.cancelled.v1 (voidOrder=true)
//
// Match por multiconjunto dentro de cada ticket: ticket + producto + qty
// (+ approvedBy en cancelaciones). No por timestamp: la cola offline del
// POS puede entregar eventos con minutos de retraso y eso NO es divergencia.

import type { Envelope } from '../../src/shared/events/envelope.js';

// Fila de pos_audit_log (solo los campos que usa el comparador).
export interface LegacyAction {
  order_id: string | null;
  action: string;
  actor: string;
  reason?: string | null;
  approved_by?: string | null;
  details?: {
    item?: string;
    cantidad?: number;
    precio?: number;
    items?: { nombre: string; cantidad: number; subtotal: number }[];
  } | null;
}

// Operación normalizada: la moneda común de ambos streams.
interface Op {
  kind: 'added' | 'cancelled';
  ticketId: string;
  producto: string;
  qty: number;
  approvedBy: string | null; // solo cancelaciones
}

export interface ParityDiff {
  ticketId: string;
  op: string; // descripción humana de la operación
  missingIn: 'events' | 'legacy';
}

export interface ParityReport {
  legacyOps: number;
  eventOps: number;
  matched: number;
  diffs: ParityDiff[];
  /** cancelaciones en events sin approvedBy — no debería existir NUNCA (la BD las rechaza) */
  unauditedCancellations: number;
  ok: boolean;
}

const opKey = (o: Op): string =>
  `${o.kind}|${o.ticketId}|${o.producto}|${o.qty}|${o.approvedBy ?? ''}`;

const describe = (o: Op): string =>
  o.kind === 'added'
    ? `+ ${o.qty}x ${o.producto}`
    : `✗ ${o.qty}x ${o.producto} (aprobó: ${o.approvedBy ?? 'NADIE'})`;

export function legacyToOps(rows: LegacyAction[]): Op[] {
  const ops: Op[] = [];
  for (const r of rows) {
    const ticketId = r.order_id ?? '';
    if (r.action === 'item_added' && r.details?.item) {
      ops.push({
        kind: 'added',
        ticketId,
        producto: r.details.item,
        qty: r.details.cantidad ?? 1,
        approvedBy: null,
      });
    } else if (r.action === 'item_cancelled' && r.details?.item) {
      ops.push({
        kind: 'cancelled',
        ticketId,
        producto: r.details.item,
        qty: r.details.cantidad ?? 1,
        approvedBy: r.approved_by ?? null,
      });
    } else if (r.action === 'order_cancelled' && r.details?.items) {
      // anulación de orden: el legado guarda UNA fila con N items;
      // el shadow emite N eventos — los expandimos para comparar 1:1.
      for (const i of r.details.items) {
        ops.push({
          kind: 'cancelled',
          ticketId,
          producto: i.nombre,
          qty: i.cantidad,
          approvedBy: r.approved_by ?? null,
        });
      }
    }
    // item_modified, order_created, etc.: aún sin evento shadow — fuera de alcance.
  }
  return ops;
}

export function eventsToOps(events: Envelope[]): Op[] {
  const ops: Op[] = [];
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'orders.item.added.v1') {
      ops.push({
        kind: 'added',
        ticketId: String(p.ticketId ?? ''),
        producto: String(p.productId ?? ''),
        qty: Number(p.qty ?? 1),
        approvedBy: null,
      });
    } else if (e.type === 'orders.item.cancelled.v1') {
      ops.push({
        kind: 'cancelled',
        ticketId: String(p.ticketId ?? ''),
        producto: String(p.productId ?? ''),
        qty: Number(p.qty ?? 1),
        approvedBy: e.audit?.approvedBy ?? null,
      });
    }
  }
  return ops;
}

export function compareParity(legacy: LegacyAction[], events: Envelope[]): ParityReport {
  const legacyOps = legacyToOps(legacy);
  const eventOps = eventsToOps(events);

  // Multiconjunto: clave → conteo. La diferencia de conteos es la divergencia.
  const counts = new Map<string, { op: Op; legacy: number; events: number }>();
  for (const o of legacyOps) {
    const k = opKey(o);
    const e = counts.get(k) ?? { op: o, legacy: 0, events: 0 };
    e.legacy += 1;
    counts.set(k, e);
  }
  for (const o of eventOps) {
    const k = opKey(o);
    const e = counts.get(k) ?? { op: o, legacy: 0, events: 0 };
    e.events += 1;
    counts.set(k, e);
  }

  const diffs: ParityDiff[] = [];
  let matched = 0;
  for (const { op, legacy: l, events: ev } of counts.values()) {
    matched += Math.min(l, ev);
    for (let i = 0; i < l - ev; i++) {
      diffs.push({ ticketId: op.ticketId, op: describe(op), missingIn: 'events' });
    }
    for (let i = 0; i < ev - l; i++) {
      diffs.push({ ticketId: op.ticketId, op: describe(op), missingIn: 'legacy' });
    }
  }

  const unauditedCancellations = eventOps.filter(
    (o) => o.kind === 'cancelled' && !o.approvedBy,
  ).length;

  return {
    legacyOps: legacyOps.length,
    eventOps: eventOps.length,
    matched,
    diffs,
    unauditedCancellations,
    ok: diffs.length === 0 && unauditedCancellations === 0,
  };
}
