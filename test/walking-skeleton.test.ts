import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryEventStore } from '../src/shared/store/event-store.js';
import { EventBus } from '../src/shared/bus/event-bus.js';
import { OrdersModule } from '../src/modules/orders/index.js';
import { KitchenModule } from '../src/modules/kitchen/index.js';
import { InventoryModule } from '../src/modules/inventory/index.js';
import { AuditModule } from '../src/modules/audit/index.js';
import {
  ORDERS_ITEM_ADDED_V1,
  ORDERS_ITEM_CANCELLED_V1,
  KITCHEN_ITEM_FIRED_V1,
  INVENTORY_ITEM_CONSUMED_V1,
  INVENTORY_ITEM_RESTOCKED_V1,
  type OrdersItemAddedV1,
  type KitchenItemFiredV1,
  type InventoryItemConsumedV1,
  type InventoryItemRestockedV1,
} from '../src/shared/events/contracts.js';
import { makeEnvelope, type Actor } from '../src/shared/events/envelope.js';

// Walking skeleton: UN flujo real de punta a punta.
// Mesero agrega latte → kitchen lo dispara → inventory descuenta receta
// → gerente aprueba cancelación → audit la persiste inmutable
// → inventory repone lo consumido.

const mesero: Actor = { userId: 'frida', deviceId: 'POS-01' };

describe('walking skeleton — flujo completo', () => {
  let store: InMemoryEventStore;
  let auditStore: InMemoryEventStore;
  let bus: EventBus;
  let orders: OrdersModule;
  let inventory: InventoryModule;
  let audit: AuditModule;

  beforeEach(() => {
    store = new InMemoryEventStore();
    auditStore = new InMemoryEventStore();
    bus = new EventBus(store);
    orders = new OrdersModule(bus);
    new KitchenModule(bus);
    inventory = new InventoryModule(bus);
    audit = new AuditModule(bus, auditStore);
  });

  it('cada acción emite su evento, en orden, con envelope válido', () => {
    orders.addItem(mesero, { ticketId: 'T-100', productId: 'latte', qty: 2 });

    const events = store.readAll();
    expect(events.map((e) => e.type)).toEqual([
      ORDERS_ITEM_ADDED_V1,
      KITCHEN_ITEM_FIRED_V1,
      INVENTORY_ITEM_CONSUMED_V1,
    ]);

    // Envelope válido en todos
    for (const e of events) {
      expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(e.version).toBe(1);
      expect(e.occurredAt).toBeTruthy();
      expect(e.actor).toEqual(mesero);
      expect(e.payload).toBeTruthy();
    }

    // Correlación: el mismo item viaja por todo el flujo
    const added = events[0]!.payload as OrdersItemAddedV1;
    const fired = events[1]!.payload as KitchenItemFiredV1;
    const consumed = events[2]!.payload as InventoryItemConsumedV1;
    expect(fired.itemId).toBe(added.itemId);
    expect(consumed.itemId).toBe(added.itemId);
    expect(fired.station).toBe('Bar'); // latte → Bar

    // Receta descontada (qty 2 → doble)
    expect(consumed.ingredients).toEqual([
      { sku: 'cafe-grano', qty: 36, unit: 'g' },
      { sku: 'leche-entera', qty: 480, unit: 'ml' },
    ]);
    expect(inventory.stock.get('cafe-grano')).toBe(-36);

    // Outbox drenada: nada pendiente
    expect(bus.pendingCount()).toBe(0);
  });

  it('cancelación aprobada: approvedBy + before/after REALES + audit + restock', () => {
    const added = orders.addItem(mesero, { ticketId: 'T-100', productId: 'latte', qty: 2 });
    const item = added.payload as OrdersItemAddedV1;
    expect(inventory.stock.get('cafe-grano')).toBe(-36);

    orders.cancelItem(mesero, item.itemId, {
      approvedBy: 'monica',
      reason: 'Orden equivocada',
    });

    const cancelled = store.readAll().find((e) => e.type === ORDERS_ITEM_CANCELLED_V1)!;
    expect(cancelled.audit?.approvedBy).toBe('monica');
    expect(cancelled.audit?.requestedBy).toBe('frida');
    expect(cancelled.audit?.reason).toBe('Orden equivocada');
    // before/after derivados del estado real de la línea (qty era 2, no 1)
    expect(cancelled.audit?.before).toEqual({ qty: 2, fired: true });
    expect(cancelled.audit?.after).toEqual({ qty: 0, cancelled: true });

    // audit lo persistió en su trail inmutable
    const trail = audit.trail();
    expect(trail).toHaveLength(1);
    expect(trail[0]!.id).toBe(cancelled.id);

    // inventory repuso EXACTAMENTE lo consumido (evento nuevo, no edición)
    const restocked = store.readAll().find((e) => e.type === INVENTORY_ITEM_RESTOCKED_V1)!;
    const rp = restocked.payload as InventoryItemRestockedV1;
    expect(rp.reason).toBe('order_cancelled');
    expect(rp.ingredients).toEqual([
      { sku: 'cafe-grano', qty: 36, unit: 'g' },
      { sku: 'leche-entera', qty: 480, unit: 'ml' },
    ]);
    expect(inventory.stock.get('cafe-grano')).toBe(0);
    expect(inventory.stock.get('leche-entera')).toBe(0);
    expect(bus.pendingCount()).toBe(0);
  });

  it('cancelar SIN aprobación truena y no emite nada (módulo Y bus)', () => {
    const added = orders.addItem(mesero, { ticketId: 'T-100', productId: 'latte', qty: 1 });
    const item = added.payload as OrdersItemAddedV1;
    const before = store.readAll().length;

    // Capa 1: el módulo rechaza
    expect(() => orders.cancelItem(mesero, item.itemId)).toThrow(/aprobación de gerente/);

    // Capa 2: aunque alguien brinque el módulo, el BUS rechaza el publish
    expect(() =>
      bus.publish(
        makeEnvelope(ORDERS_ITEM_CANCELLED_V1, 1, mesero, {
          ticketId: 'T-100',
          itemId: item.itemId,
          productId: 'latte',
          qty: 1,
          inventoryImpact: true,
        }),
      ),
    ).toThrow(/audit completo/);

    expect(store.readAll().length).toBe(before); // cero eventos emitidos
    expect(audit.trail()).toHaveLength(0);
  });

  it('NINGÚN UPDATE/DELETE sobre los stores; eventos deep-frozen', () => {
    const added = orders.addItem(mesero, { ticketId: 'T-100', productId: 'latte', qty: 1 });
    const item = added.payload as OrdersItemAddedV1;
    orders.cancelItem(mesero, item.itemId, { approvedBy: 'monica', reason: 'test' });

    // Todas las operaciones de escritura fueron appends — ni una mutación
    const writes = store.operationsLog.filter((op) => op !== 'read');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((op) => op === 'append')).toBe(true);

    const auditWrites = auditStore.operationsLog.filter((op) => op !== 'read');
    expect(auditWrites.every((op) => op === 'append')).toBe(true);

    // Deep-freeze: ni el nivel superior NI el payload son mutables
    const first = store.readAll()[0]!;
    expect(() => {
      (first as { type: string }).type = 'hacked';
    }).toThrow();
    expect(() => {
      (first.payload as { qty: number }).qty = 99;
    }).toThrow();
    expect(() => {
      (first.actor as { userId: string }).userId = 'impostor';
    }).toThrow();
  });

  it('un handler que truena NO tumba el flujo; la entrega queda pendiente y se reintenta', () => {
    let intentos = 0;
    let entregado = false;
    bus.subscribe(ORDERS_ITEM_ADDED_V1, () => {
      intentos += 1;
      if (intentos === 1) throw new Error('KDS desconectado');
      entregado = true;
    });

    orders.addItem(mesero, { ticketId: 'T-200', productId: 'latte', qty: 1 });

    // El flujo completo corrió a pesar del handler roto
    expect(store.readAll().map((e) => e.type)).toContain(INVENTORY_ITEM_CONSUMED_V1);
    // La entrega fallida quedó pendiente, con error registrado
    expect(bus.pendingCount()).toBe(1);
    expect(bus.pendingErrors()[0]).toContain('KDS desconectado');

    // Reintento: solo re-invoca al handler fallido (idempotencia por handler)
    const eventsBefore = store.readAll().length;
    bus.redrain();
    expect(entregado).toBe(true);
    expect(bus.pendingCount()).toBe(0);
    expect(store.readAll().length).toBe(eventsBefore); // sin eventos duplicados
  });
});
