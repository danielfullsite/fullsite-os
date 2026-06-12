// Envelope estándar — todo evento del sistema viaja en este sobre.
// Ver docs/EVENTS.md. La historia nunca se reescribe; solo se agregan eventos.

export interface Actor {
  userId: string;
  deviceId: string;
}

// Bloque obligatorio en eventos sensibles (cancelaciones, descuentos,
// retiros de caja, cortesías, ajustes de inventario).
export interface AuditBlock {
  requestedBy: string;
  approvedBy: string;
  reason: string;
  before: unknown;
  after: unknown;
}

export interface Envelope<T = unknown> {
  id: string; // uuid
  type: string; // 'dominio.entidad.accion.vN', en pasado
  version: number;
  occurredAt: string; // ISO-8601
  actor: Actor;
  payload: T;
  audit?: AuditBlock;
}

// Evento sensible: el compilador rechaza emitirlo sin bloque audit completo.
export interface SensitiveEnvelope<T = unknown> extends Envelope<T> {
  audit: AuditBlock;
}

// dominio.entidad.accion.vN — acción en pasado (termina en consonante+ed
// en inglés; validamos forma general + versión coherente).
const TYPE_PATTERN = /^[a-z][a-z-]*\.[a-z][a-z-]*\.[a-z]+\.v(\d+)$/;

export function makeEnvelope<T>(
  type: string,
  version: number,
  actor: Actor,
  payload: T,
  audit?: AuditBlock,
): Envelope<T> {
  const match = TYPE_PATTERN.exec(type);
  if (!match) {
    throw new Error(`Tipo de evento inválido: '${type}' (esperado dominio.entidad.accion.vN)`);
  }
  if (Number(match[1]) !== version) {
    throw new Error(`Versión incoherente: type='${type}' pero version=${version}`);
  }
  return {
    id: crypto.randomUUID(),
    type,
    version,
    occurredAt: new Date().toISOString(),
    actor,
    payload,
    ...(audit ? { audit } : {}),
  };
}
