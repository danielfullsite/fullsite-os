import { makeEnvelope } from '../../shared/events/envelope.js';
import {
  KITCHEN_ITEM_FIRED_V1,
  ORDERS_ITEM_CANCELLED_V1,
  INVENTORY_ITEM_CONSUMED_V1,
  INVENTORY_ITEM_RESTOCKED_V1,
  type KitchenItemFiredV1,
  type OrdersItemCancelledV1,
  type InventoryItemConsumedV1,
  type InventoryItemRestockedV1,
} from '../../shared/events/contracts.js';
import type { EventBus } from '../../shared/bus/event-bus.js';

// inventory: event-in only (principio #4). NADIE edita inventario directo;
// este módulo reacciona a eventos y emite consumo/reposición por receta.
//
// - Descuenta al FIRED (cuando cocina produce), no al added.
// - Cancelación con inventoryImpact → emite restocked (corrección = evento
//   nuevo, jamás se edita el consumed original).
// - El stock se PROYECTA de los eventos consumed/restocked emitidos —
//   el replay desde el store reproduce el stock exacto.
//
// Receta hardcodeada mínima para el walking skeleton; el siguiente slice
// conecta las recetas reales.

interface RecipeLine {
  sku: string;
  qty: number;
  unit: string;
}

const RECIPES: Record<string, RecipeLine[]> = {
  latte: [
    { sku: 'cafe-grano', qty: 18, unit: 'g' },
    { sku: 'leche-entera', qty: 240, unit: 'ml' },
  ],
};

export class InventoryModule {
  // Read model: SOLO se muta en las proyecciones de eventos propios.
  readonly stock = new Map<string, number>();
  // qué se consumió por línea, para reponer exactamente eso al cancelar
  private readonly consumedByItem = new Map<string, RecipeLine[]>();

  constructor(private readonly bus: EventBus) {
    // Comandos (reaccionan a eventos de otros módulos → emiten los propios)
    bus.subscribe(KITCHEN_ITEM_FIRED_V1, (event) => {
      const fired = event.payload as KitchenItemFiredV1;
      const recipe = RECIPES[fired.productId];
      if (!recipe) return; // sin receta registrada, no hay consumo que emitir

      const ingredients = recipe.map((line) => ({
        ...line,
        qty: line.qty * fired.qty,
      }));
      const payload: InventoryItemConsumedV1 = {
        ticketId: fired.ticketId,
        itemId: fired.itemId,
        productId: fired.productId,
        ingredients,
      };
      bus.publish(makeEnvelope(INVENTORY_ITEM_CONSUMED_V1, 1, event.actor, payload));
    });

    bus.subscribe(ORDERS_ITEM_CANCELLED_V1, (event) => {
      const cancelled = event.payload as OrdersItemCancelledV1;
      if (!cancelled.inventoryImpact) return; // nunca se disparó: nada que reponer
      const consumed = this.consumedByItem.get(cancelled.itemId);
      if (!consumed || consumed.length === 0) return;

      const payload: InventoryItemRestockedV1 = {
        ticketId: cancelled.ticketId,
        itemId: cancelled.itemId,
        productId: cancelled.productId,
        reason: 'order_cancelled',
        ingredients: consumed,
      };
      bus.publish(makeEnvelope(INVENTORY_ITEM_RESTOCKED_V1, 1, event.actor, payload));
    });

    // Proyecciones (estado = fold de eventos propios)
    bus.subscribe(INVENTORY_ITEM_CONSUMED_V1, (event) => {
      const p = event.payload as InventoryItemConsumedV1;
      for (const ing of p.ingredients) {
        this.stock.set(ing.sku, (this.stock.get(ing.sku) ?? 0) - ing.qty);
      }
      this.consumedByItem.set(p.itemId, p.ingredients.map((i) => ({ ...i })));
    });

    bus.subscribe(INVENTORY_ITEM_RESTOCKED_V1, (event) => {
      const p = event.payload as InventoryItemRestockedV1;
      for (const ing of p.ingredients) {
        this.stock.set(ing.sku, (this.stock.get(ing.sku) ?? 0) + ing.qty);
      }
      this.consumedByItem.delete(p.itemId);
    });
  }
}
