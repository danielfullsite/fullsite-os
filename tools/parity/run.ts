// CLI del comparador de paridad.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run parity            (hoy)
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run parity 2026-06-12 (un día)
//
// Lee pos_audit_log y events del mismo día y reporta divergencias.
// Exit code 0 = paridad, 1 = divergencia (útil para cron/CI).

import { compareParity, type LegacyAction } from './compare.ts';
import type { Envelope } from '../../src/shared/events/envelope.js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? '';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en el entorno.');
  process.exit(2);
}

const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error(`Fecha inválida: ${day} (formato YYYY-MM-DD)`);
  process.exit(2);
}
const from = `${day}T00:00:00-06:00`; // día operativo en hora de Monterrey
const to = `${day}T23:59:59-06:00`;

async function fetchAll<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}&limit=${page}&offset=${offset}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

interface EventRow {
  id: string;
  type: string;
  version: number;
  occurred_at: string;
  actor: Envelope['actor'];
  payload: Record<string, unknown>;
  audit: Envelope['audit'] | null;
}

const [legacy, eventRows] = await Promise.all([
  fetchAll<LegacyAction>(
    `pos_audit_log?select=order_id,action,actor,reason,approved_by,details` +
      `&created_at=gte.${from}&created_at=lte.${to}` +
      `&action=in.(item_added,item_cancelled,order_cancelled,payment_processed,discount_applied)&order=created_at.asc`,
  ),
  fetchAll<EventRow>(
    `events?select=id,type,version,occurred_at,actor,payload,audit` +
      `&occurred_at=gte.${from}&occurred_at=lte.${to}` +
      `&type=in.(orders.item.added.v1,orders.item.cancelled.v1,payments.payment.captured.v1,orders.discount.applied.v1)&order=sequence.asc`,
  ),
]);

// POS-TEST = dispositivo de smoke tests (eventos sintéticos, sin contraparte
// legada). La tabla es append-only así que se filtran aquí, no se borran.
const events: Envelope[] = eventRows
  .filter((r) => r.actor?.deviceId !== 'POS-TEST')
  .map((r) => ({
  id: r.id,
  type: r.type,
  version: r.version,
  occurredAt: r.occurred_at,
  actor: r.actor,
  payload: r.payload,
  ...(r.audit ? { audit: r.audit } : {}),
}));

const report = compareParity(legacy, events);

console.log(`\n══ Paridad shadow mode — ${day} ══`);
console.log(`  legado (pos_audit_log): ${report.legacyOps} operaciones`);
console.log(`  shadow (events):        ${report.eventOps} operaciones`);
console.log(`  coinciden:              ${report.matched}`);

if (report.diffs.length > 0) {
  console.log(`\n  DIVERGENCIAS (${report.diffs.length}):`);
  const byTicket = new Map<string, typeof report.diffs>();
  for (const d of report.diffs) {
    const arr = byTicket.get(d.ticketId) ?? [];
    arr.push(d);
    byTicket.set(d.ticketId, arr);
  }
  for (const [ticket, ds] of byTicket) {
    console.log(`  ticket ${ticket || '(sin id)'}:`);
    for (const d of ds) {
      console.log(`    ${d.op} — falta en ${d.missingIn === 'events' ? 'EVENTS (shadow no lo emitió o sigue en cola offline)' : 'LEGADO (¿evento duplicado o logAudit falló?)'}`);
    }
  }
}

if (report.unauditedCancellations > 0) {
  console.log(`\n  ⚠️  ${report.unauditedCancellations} cancelaciones SIN approvedBy en events — imposible si el constraint está activo, investigar.`);
}

console.log(report.ok ? '\n  ✅ PARIDAD OK — los eventos cuentan la misma historia que el legado.\n' : '\n  ❌ DIVERGENCIA — revisar antes de avanzar de fase.\n');

// Persistir el resultado en parity_reports (lo lee el dashboard/chat del POS).
// --no-save para corridas locales exploratorias.
if (!process.argv.includes('--no-save')) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/parity_reports`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      day,
      legacy_ops: report.legacyOps,
      event_ops: report.eventOps,
      matched: report.matched,
      diffs: report.diffs,
      unaudited_cancellations: report.unauditedCancellations,
      ok: report.ok,
    }),
  });
  console.log(res.ok ? '  reporte guardado en parity_reports' : `  ⚠️ no se pudo guardar el reporte: HTTP ${res.status} ${await res.text()}`);
}

process.exit(report.ok ? 0 : 1);
