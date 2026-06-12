// publishEvent — cliente shadow mode para el POS (framework-agnostic).
//
// Reglas:
// 1. FIRE-AND-FORGET: jamás truena ni bloquea. El camino crítico de venta
//    no espera al evento (offline-first, principio #2).
// 2. Cola local persistente: sin internet, el evento se encola y se
//    reintenta al reconectar o en el siguiente publish.
// 3. Reintentos idempotentes: el INSERT usa on_conflict=id + ignore
//    duplicates — reenviar el mismo evento jamás lo duplica.
// 4. fetch crudo al REST API de Supabase (NO el SDK). En dashboard-app,
//    supabase-fetch-patch.ts intercambia el anon key por el JWT del
//    usuario logueado automáticamente (mismo patrón que pos-data.ts).

import type { Envelope } from '../events/envelope.js';

export interface QueueStorage {
  load(): Envelope[];
  save(queue: Envelope[]): void;
}

export class InMemoryQueueStorage implements QueueStorage {
  private queue: Envelope[] = [];
  load(): Envelope[] {
    return [...this.queue];
  }
  save(queue: Envelope[]): void {
    this.queue = [...queue];
  }
}

// Para el browser (POS): sobrevive recargas de página y cierres de app.
export class LocalStorageQueueStorage implements QueueStorage {
  constructor(private readonly key = 'fullsite_event_queue') {}
  load(): Envelope[] {
    try {
      const raw = globalThis.localStorage?.getItem(this.key);
      return raw ? (JSON.parse(raw) as Envelope[]) : [];
    } catch {
      return [];
    }
  }
  save(queue: Envelope[]): void {
    try {
      globalThis.localStorage?.setItem(this.key, JSON.stringify(queue));
    } catch {
      // storage lleno o no disponible: la cola en memoria sigue viva
    }
  }
}

export interface PublisherConfig {
  supabaseUrl: string; // https://xxx.supabase.co
  supabaseKey: string; // anon key (el fetch-patch lo cambia por el JWT)
  storage?: QueueStorage;
  fetchFn?: typeof fetch; // inyectable para tests
  onError?: (message: string) => void; // log, nunca throw
}

export class EventPublisher {
  private readonly storage: QueueStorage;
  private readonly fetchFn: typeof fetch;
  private inflight: Promise<void> | null = null;

  constructor(private readonly config: PublisherConfig) {
    this.storage = config.storage ?? new InMemoryQueueStorage();
    this.fetchFn = config.fetchFn ?? fetch;
  }

  // Fire-and-forget: encola SIEMPRE primero (si truena el flush, el evento
  // ya está a salvo en la cola local) y luego intenta vaciar.
  publish(event: Envelope): void {
    const queue = this.storage.load();
    queue.push(event);
    this.storage.save(queue);
    void this.flush();
  }

  pending(): number {
    return this.storage.load().length;
  }

  // Vacía la cola en orden. Se detiene al primer fallo (preserva orden);
  // lo que quede pendiente se reintenta en el siguiente publish/flush.
  // Llamadas concurrentes comparten el mismo flush en vuelo.
  flush(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.doFlush().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doFlush(): Promise<void> {
    let queue = this.storage.load();
    while (queue.length > 0) {
      const event = queue[0]!;
      const ok = await this.send(event);
      if (!ok) return;
      queue = this.storage.load();
      queue.shift();
      this.storage.save(queue);
    }
  }

  private async send(event: Envelope): Promise<boolean> {
    try {
      const res = await this.fetchFn(
        `${this.config.supabaseUrl}/rest/v1/events?on_conflict=id`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: this.config.supabaseKey,
            Authorization: `Bearer ${this.config.supabaseKey}`,
            Prefer: 'resolution=ignore-duplicates',
          },
          body: JSON.stringify({
            id: event.id,
            type: event.type,
            version: event.version,
            occurred_at: event.occurredAt,
            actor: event.actor,
            payload: event.payload,
            audit: event.audit ?? null,
          }),
        },
      );
      if (res.ok || res.status === 409) return true; // 409 = ya existe (reintento previo)
      this.config.onError?.(`events insert HTTP ${res.status}: ${await res.text()}`);
      // 401/403 = sesión sin autenticar todavía: RETENER en cola y reintentar
      // cuando haya login. Otros 4xx = evento inválido (p.ej. sensible sin
      // audit): descartar con log para no atorar la cola. 5xx = reintentar.
      if (res.status === 401 || res.status === 403) return false;
      return res.status >= 400 && res.status < 500;
    } catch (err) {
      // Red caída: el evento se queda en la cola, se reintenta después.
      this.config.onError?.(`events insert offline: ${String(err)}`);
      return false;
    }
  }
}
