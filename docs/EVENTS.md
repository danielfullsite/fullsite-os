# Catálogo de eventos — Fullsite OS

> El corazón del sistema. Antes de implementar cualquier acción de usuario, **define aquí el evento primero**.

## Convención de nombres

`dominio.entidad.accion.vN` — siempre en **pasado**.

```
orders.ticket.created.v1
orders.item.cancelled.v1
kitchen.course.fired.v1
payments.shift.closed.v1
inventory.item.consumed.v1
```

## Envelope estándar (todo evento)

```jsonc
{
  "id": "uuid",
  "type": "orders.ticket.created.v1",
  "version": 1,
  "occurredAt": "2026-06-12T18:33:00-06:00",
  "actor": { "userId": "...", "deviceId": "POS-03" },
  "payload": { /* específico del evento */ }
}
```

## Eventos sensibles → bloque `audit` obligatorio

Cancelaciones, descuentos, retiros de caja, cortesías, ajustes de inventario.

```jsonc
{
  "type": "orders.item.cancelled.v1",
  "actor": { "userId": "oscar", "deviceId": "POS-03" },
  "payload": { "ticketId": "...", "itemId": "...", "inventoryImpact": true },
  "audit": {
    "requestedBy": "oscar",
    "approvedBy": "mariana",
    "reason": "Orden equivocada",
    "before": { "qty": 1 },
    "after":  { "qty": 0 }
  }
}
```

## Reglas inviolables

1. **Append-only.** Nunca UPDATE ni DELETE de un evento.
2. **Corrección = nuevo evento** (`*.corrected.v1`), nunca editar el original.
3. Todo evento es **inmutable** una vez emitido.
4. Versionar el schema (`vN`); no romper consumidores existentes.

## Catálogo inicial por módulo

### orders
- `orders.ticket.created.v1`
- `orders.item.added.v1`
- `orders.item.cancelled.v1`  *(sensible)*
- `orders.discount.applied.v1` *(sensible)*
- `orders.table.opened.v1` / `orders.table.closed.v1`

### kitchen
- `kitchen.course.fired.v1`
- `kitchen.item.fired.v1`
- `kitchen.item.ready.v1`
- `kitchen.item.served.v1`

### payments
- `payments.payment.captured.v1`
- `payments.tip.added.v1`
- `payments.cash.withdrawn.v1` *(sensible)*
- `payments.cash.deposited.v1`
- `payments.shift.closed.v1`

### inventory
- `inventory.item.consumed.v1`
- `inventory.item.restocked.v1` *(compensación: item cancelado que ya consumió insumo)*
- `inventory.waste.recorded.v1` *(sensible)*
- `inventory.transfer.made.v1`
- `inventory.adjusted.v1` *(sensible)*

### crm
- `crm.customer.visited.v1`
- `crm.loyalty.earned.v1`
- `crm.loyalty.redeemed.v1`

### delivery
- `delivery.driver.assigned.v1`
- `delivery.order.dispatched.v1`
- `delivery.order.delivered.v1`
- `delivery.settlement.closed.v1`

### audit
- Consume **todos** los eventos marcados *(sensible)* y los persiste en el event store inmutable.
