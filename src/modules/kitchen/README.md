# Módulo: Kitchen

## Responsabilidad única
KDS, firebutton, ruteo a estaciones e impresoras, cursos y estados de producción (Pending → Fired → Preparing → Ready → Served).

## Eventos que emite
`kitchen.course.fired.v1`, `kitchen.item.fired.v1`, `kitchen.item.ready.v1`, `kitchen.item.served.v1`

## Eventos que consume
`orders.item.added.v1`, `orders.ticket.created.v1`

## Frontera
No conoce precios ni pagos. Solo producción. Rutea Producto → Estación → KDS → Impresora.
