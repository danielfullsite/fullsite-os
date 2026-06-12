import type { Envelope } from '../events/envelope.js';
import { SENSITIVE_EVENT_TYPES } from '../events/contracts.js';
import type { EventStore, StoredEvent } from '../store/event-store.js';

// Bus en proceso con patrón outbox:
//
//   publish() → validar (sensible ⇒ audit completo)  ← ANTES del append
//             → store.append(evento)                  ← persistido PRIMERO
//             → outbox.enqueue(id)                    ← pendiente de despachar
//             → drain()                               ← entrega en orden
//
// El estado pending/dispatched vive en la outbox, NUNCA en el evento
// (el evento es inmutable). Entrega idempotente POR HANDLER: si el handler
// 2 de 3 truena, el re-drain no vuelve a invocar al 1 (evita doble consumo
// de inventario). Las entregas fallidas quedan pending y se reintentan en
// el siguiente publish() o con redrain().
//
// Siguiente slice: OutboxEntry migra a tabla en Postgres (CLAUDE.md §6).

export type EventHandler = (event: StoredEvent) => void;

interface Subscription {
  id: number;
  type: string;
  handler: EventHandler;
}

interface OutboxEntry {
  eventId: string;
  status: 'pending' | 'dispatched';
  delivered: Set<number>; // ids de subscription ya entregados (idempotencia)
  attempts: number;
  lastError?: string;
}

export class EventBus {
  private readonly subscriptions: Subscription[] = [];
  private readonly outbox: OutboxEntry[] = [];
  private readonly byId = new Map<string, StoredEvent>();
  private draining = false;
  private nextSubId = 1;

  constructor(private readonly store: EventStore) {}

  subscribe(type: string, handler: EventHandler): void {
    this.subscriptions.push({ id: this.nextSubId++, type, handler });
  }

  publish(event: Envelope): StoredEvent {
    // Validación ANTES del append: un sensible sin aprobación jamás
    // llega al store (defensa primaria; audit re-valida al persistir).
    if (SENSITIVE_EVENT_TYPES.has(event.type)) {
      const a = event.audit;
      if (!a?.approvedBy || !a.requestedBy || !a.reason) {
        throw new Error(
          `${event.type} es sensible: requiere audit completo (requestedBy, approvedBy, reason)`,
        );
      }
    }
    const stored = this.store.append(event);
    this.byId.set(stored.id, stored);
    this.outbox.push({
      eventId: stored.id,
      status: 'pending',
      delivered: new Set(),
      attempts: 0,
    });
    this.drain();
    return stored;
  }

  // Reintenta entregas pendientes (handlers que tronaron en un drain previo).
  redrain(): void {
    this.drain();
  }

  // Drena la outbox en orden. Reentrante-seguro: si un subscriber publica
  // durante el drain (kitchen publica fired al recibir added), la entrada
  // nueva la procesa el mismo loop. Un handler que truena NO tumba el
  // drain: su entrega queda pendiente y el resto del flujo continúa.
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    // Un handler fallido NO se re-martilla dentro del mismo drain;
    // se reintenta hasta el siguiente publish()/redrain().
    const attempted = new Set<string>(); // `${eventId}:${subId}`
    try {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const entry of this.outbox) {
          if (entry.status !== 'pending') continue;
          const event = this.byId.get(entry.eventId)!;
          let allDelivered = true;
          for (const sub of this.subscriptions) {
            if (sub.type !== event.type) continue;
            if (entry.delivered.has(sub.id)) continue; // idempotencia
            const key = `${entry.eventId}:${sub.id}`;
            if (attempted.has(key)) {
              allDelivered = false;
              continue; // ya falló en este drain, no re-martillar
            }
            attempted.add(key);
            entry.attempts += 1;
            try {
              sub.handler(event);
              entry.delivered.add(sub.id);
              progressed = true;
            } catch (err) {
              allDelivered = false;
              entry.lastError = err instanceof Error ? err.message : String(err);
            }
          }
          if (allDelivered && entry.status === 'pending') {
            entry.status = 'dispatched';
            progressed = true;
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  pendingCount(): number {
    return this.outbox.filter((e) => e.status === 'pending').length;
  }

  pendingErrors(): string[] {
    return this.outbox
      .filter((e) => e.status === 'pending' && e.lastError)
      .map((e) => `${this.byId.get(e.eventId)!.type}: ${e.lastError}`);
  }
}
