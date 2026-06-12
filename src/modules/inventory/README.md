# Módulo: Inventory

## Responsabilidad única
Recetas, consumo, merma, traspasos y ajustes. **Solo recibe eventos**, nunca se edita desde el POS.

## Eventos que emite
`inventory.item.consumed.v1`, `inventory.waste.recorded.v1` *(sensible)*, `inventory.transfer.made.v1`, `inventory.adjusted.v1` *(sensible)*

## Eventos que consume
`orders.item.added.v1`, `orders.item.cancelled.v1`, `kitchen.item.served.v1`

## Frontera
El POS JAMÁS modifica inventario directo. Este módulo deriva todo de eventos.
