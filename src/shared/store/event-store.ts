import type { Envelope } from '../events/envelope.js';

// El store SOLO sabe agregar y leer. No existe update ni delete en la
// interfaz — el equivalente en Postgres es db/migrations/0001_events.sql
// (trigger events_immutable + revoke update/delete).

export interface StoredEvent extends Envelope {
  sequence: number; // orden total
  recordedAt: string;
}

export interface EventStore {
  append(event: Envelope): StoredEvent;
  readAll(): readonly StoredEvent[];
}

// Congela el evento COMPLETO (payload, actor, audit incluidos): ningún
// subscriber puede reescribir historia ni en memoria.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// Implementación en memoria para el walking skeleton y los tests.
// Registra cada operación ejecutada para que el test verifique
// mecánicamente que NUNCA hubo mutación.
export class InMemoryEventStore implements EventStore {
  private readonly events: StoredEvent[] = [];
  readonly operationsLog: string[] = [];

  append(event: Envelope): StoredEvent {
    this.operationsLog.push('append');
    const stored: StoredEvent = {
      ...event,
      sequence: this.events.length + 1,
      recordedAt: new Date().toISOString(),
    };
    this.events.push(deepFreeze(stored));
    return stored;
  }

  readAll(): readonly StoredEvent[] {
    this.operationsLog.push('read');
    return [...this.events];
  }
}
