// Contratos de evento del walking skeleton.
// Antes de implementar una acción de usuario, el evento se define AQUÍ
// (y en docs/EVENTS.md). Los módulos solo comparten estos contratos.

export const ORDERS_ITEM_ADDED_V1 = 'orders.item.added.v1';
export const ORDERS_ITEM_CANCELLED_V1 = 'orders.item.cancelled.v1'; // sensible
export const ORDERS_DISCOUNT_APPLIED_V1 = 'orders.discount.applied.v1'; // sensible
export const KITCHEN_ITEM_FIRED_V1 = 'kitchen.item.fired.v1';
export const INVENTORY_ITEM_CONSUMED_V1 = 'inventory.item.consumed.v1';
export const INVENTORY_ITEM_RESTOCKED_V1 = 'inventory.item.restocked.v1';
export const PAYMENTS_PAYMENT_CAPTURED_V1 = 'payments.payment.captured.v1';

// Registro de tipos sensibles: el bus RECHAZA publicarlos sin bloque audit
// completo (la validación pasa ANTES del append — un sensible sin aprobación
// jamás toca el store). Siguiente slice: cash.withdrawn, waste.recorded,
// inventory.adjusted. Debe ir en espejo con el constraint
// sensitive_requires_audit de db/migrations/0002_events_access.sql.
export const SENSITIVE_EVENT_TYPES: ReadonlySet<string> = new Set([
  ORDERS_ITEM_CANCELLED_V1,
  ORDERS_DISCOUNT_APPLIED_V1,
]);

export interface OrdersItemAddedV1 {
  ticketId: string;
  itemId: string; // línea del ticket
  productId: string; // platillo del menú
  qty: number;
}

export interface OrdersItemCancelledV1 {
  ticketId: string;
  itemId: string;
  productId: string;
  qty: number; // cantidad cancelada (estado real de la línea)
  inventoryImpact: boolean; // true si ya se consumió insumo (fired) → inventory repone
}

// Sensible: lleva bloque audit (requestedBy/approvedBy/reason/before/after).
export interface OrdersDiscountAppliedV1 {
  ticketId: string;
  amount: number; // monto descontado en MXN
}

export interface PaymentsPaymentCapturedV1 {
  ticketId: string;
  total: number;
  subtotal: number;
  iva: number;
  descuento: number;
  propina: number;
  metodo: string; // etiqueta del método (Efectivo, Tarjeta, Mixto...)
  pagos: Array<{ metodo: string; monto: number }>; // desglose (mixto = varias formas)
  cuenta: number | 'full'; // número de cuenta en split, o 'full'
}

export interface KitchenItemFiredV1 {
  ticketId: string;
  itemId: string;
  productId: string;
  qty: number;
  station: string; // Latte→Bar, Pizza→Horno, ...
}

export interface InventoryItemConsumedV1 {
  ticketId: string;
  itemId: string;
  productId: string;
  ingredients: Array<{ sku: string; qty: number; unit: string }>;
}

// Compensación: un item cancelado que ya había consumido insumo se repone.
// Corrección = evento nuevo, nunca se edita el consumed original.
export interface InventoryItemRestockedV1 {
  ticketId: string;
  itemId: string;
  productId: string;
  reason: 'order_cancelled';
  ingredients: Array<{ sku: string; qty: number; unit: string }>;
}
