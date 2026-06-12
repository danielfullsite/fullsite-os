# Módulo: Orders

## Responsabilidad única
Órdenes, mesas, asientos, comensales, cursos, descuentos y promociones. Nada más.

## Eventos que emite
`orders.ticket.created.v1`, `orders.item.added.v1`, `orders.item.cancelled.v1` *(sensible)*, `orders.discount.applied.v1` *(sensible)*, `orders.table.opened/closed.v1`

## Eventos que consume
`payments.payment.captured.v1` (para cerrar ticket), `kitchen.item.served.v1` (estado)

## Frontera
No toca inventario ni cocina directamente. Emite eventos; los demás reaccionan.
