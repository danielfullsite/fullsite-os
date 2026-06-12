import { makeEnvelope, type Actor, type AuditBlock } from '../../shared/events/envelope.js';
import {
  ORDERS_ITEM_ADDED_V1,
  ORDERS_ITEM_CANCELLED_V1,
  KITCHEN_ITEM_FIRED_V1,
  type OrdersItemAddedV1,
  type OrdersItemCancelledV1,
  type KitchenItemFiredV1,
} from '../../shared/events/contracts.js';
import type { EventBus } from '../../shared/bus/event-bus.js';
import type { StoredEvent } from '../../shared/store/event-store.js';

// orders: órdenes y sus líneas. Publica eventos; no toca estado de otros
// módulos. Su read model de líneas se PROYECTA de eventos (estado = fold
// de eventos), nunca se setea a mano.

interface LineState {
  ticketId: string;
  productId: string;
  qty: number;
  fired: boolean; // ya consumió insumo → cancelación con inventoryImpact
  cancelled: boolean;
}

export interface CancelApproval {
  approvedBy: string;
  reason: string;
}

export class OrdersModule {
  private readonly lines = new Map<string, LineState>(); // itemId → estado

  constructor(private readonly bus: EventBus) {
    // Proyecciones: el estado se deriva de los eventos publicados,
    // así el replay desde el store produce exactamente el mismo estado.
    bus.subscribe(ORDERS_ITEM_ADDED_V1, (event) => {
      const p = event.payload as OrdersItemAddedV1;
      this.lines.set(p.itemId, {
        ticketId: p.ticketId,
        productId: p.productId,
        qty: p.qty,
        fired: false,
        cancelled: false,
      });
    });
    bus.subscribe(KITCHEN_ITEM_FIRED_V1, (event) => {
      const p = event.payload as KitchenItemFiredV1;
      const line = this.lines.get(p.itemId);
      if (line) line.fired = true;
    });
    bus.subscribe(ORDERS_ITEM_CANCELLED_V1, (event) => {
      const p = event.payload as OrdersItemCancelledV1;
      const line = this.lines.get(p.itemId);
      if (line) {
        line.cancelled = true;
        line.qty = 0;
      }
    });
  }

  // Mesero agrega platillo a un ticket → orders.item.added.v1
  addItem(
    actor: Actor,
    input: { ticketId: string; productId: string; qty: number },
  ): StoredEvent {
    const payload: OrdersItemAddedV1 = {
      ticketId: input.ticketId,
      itemId: crypto.randomUUID(),
      productId: input.productId,
      qty: input.qty,
    };
    return this.bus.publish(makeEnvelope(ORDERS_ITEM_ADDED_V1, 1, actor, payload));
  }

  // Cancelación — acción SENSIBLE: requiere aprobación de gerente (nivel 2,
  // docs/SECURITY.md). Sin approvedBy no se emite NADA (el bus también lo
  // rechaza: defensa en profundidad). El before/after sale del estado REAL
  // de la línea, nunca hardcodeado.
  cancelItem(actor: Actor, itemId: string, approval?: CancelApproval): StoredEvent {
    if (!approval?.approvedBy) {
      throw new Error(
        'orders.item.cancelled.v1 es un evento sensible: requiere aprobación de gerente (approvedBy)',
      );
    }
    const line = this.lines.get(itemId);
    if (!line) throw new Error(`Línea desconocida: ${itemId}`);
    if (line.cancelled) throw new Error(`Línea ${itemId} ya está cancelada`);

    const payload: OrdersItemCancelledV1 = {
      ticketId: line.ticketId,
      itemId,
      productId: line.productId,
      qty: line.qty,
      inventoryImpact: line.fired, // solo repone si cocina ya lo produjo
    };
    const audit: AuditBlock = {
      requestedBy: actor.userId,
      approvedBy: approval.approvedBy,
      reason: approval.reason,
      before: { qty: line.qty, fired: line.fired },
      after: { qty: 0, cancelled: true },
    };
    return this.bus.publish(
      makeEnvelope(ORDERS_ITEM_CANCELLED_V1, 1, actor, payload, audit),
    );
  }

  line(itemId: string): LineState | undefined {
    return this.lines.get(itemId);
  }
}
