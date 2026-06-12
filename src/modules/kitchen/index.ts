import { makeEnvelope } from '../../shared/events/envelope.js';
import {
  ORDERS_ITEM_ADDED_V1,
  KITCHEN_ITEM_FIRED_V1,
  type OrdersItemAddedV1,
  type KitchenItemFiredV1,
} from '../../shared/events/contracts.js';
import type { EventBus } from '../../shared/bus/event-bus.js';

// kitchen: escucha items agregados y los dispara a su estación.
// Ruteo (docs/ARCHITECTURE.md): Producto → Estación → KDS → Impresora.

const STATION_BY_PRODUCT: Record<string, string> = {
  latte: 'Bar',
  pizza: 'Horno',
  acai: 'Pantry',
  ribeye: 'Parrilla',
};

export class KitchenModule {
  constructor(private readonly bus: EventBus) {
    bus.subscribe(ORDERS_ITEM_ADDED_V1, (event) => {
      const added = event.payload as OrdersItemAddedV1;
      const payload: KitchenItemFiredV1 = {
        ticketId: added.ticketId,
        itemId: added.itemId,
        productId: added.productId,
        qty: added.qty,
        station: STATION_BY_PRODUCT[added.productId] ?? 'Cocina',
      };
      // El KDS dispara el item → kitchen.item.fired.v1
      bus.publish(makeEnvelope(KITCHEN_ITEM_FIRED_V1, 1, event.actor, payload));
    });
  }
}
