import { SENSITIVE_EVENT_TYPES } from '../../shared/events/contracts.js';
import type { EventBus } from '../../shared/bus/event-bus.js';
import type { EventStore, StoredEvent } from '../../shared/store/event-store.js';

// audit: consume todos los eventos sensibles y los persiste en su propio
// store inmutable (append-only). Quién/qué/cuándo/por qué/aprobado-por.

// Nota de diseño (decidido tras auditoría 2026-06-12): en Postgres el trail
// de audit NO es una tabla aparte — es una vista del mismo event store
// (`select * from events where audit is not null`), que ya es inmutable por
// trigger + revoke. En el monolito este módulo mantiene su trail como
// proyección en memoria para consultas rápidas del Fraud Agent.

export class AuditModule {
  constructor(bus: EventBus, private readonly auditStore: EventStore) {
    for (const type of SENSITIVE_EVENT_TYPES) {
      bus.subscribe(type, (event) => this.persist(event));
    }
  }

  private persist(event: StoredEvent): void {
    // Defensa en profundidad: el bus ya rechazó sensibles sin aprobación
    // ANTES del append; si esto truena, hay un bug en el bus.
    if (!event.audit?.approvedBy) {
      throw new Error(`Evento sensible ${event.type} sin bloque audit.approvedBy`);
    }
    this.auditStore.append(event);
  }

  trail(): readonly StoredEvent[] {
    return this.auditStore.readAll();
  }
}
