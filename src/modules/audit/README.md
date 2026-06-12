# Módulo: Audit

## Responsabilidad única
Event store **inmutable** de todas las acciones sensibles. Fuente de verdad para fraude y cumplimiento.

## Eventos que emite
(no emite; persiste)

## Eventos que consume
Todos los eventos marcados *(sensible)*: cancelaciones, descuentos, retiros, cortesías, ajustes

## Frontera
Append-only absoluto. Nadie más escribe aquí. Nunca UPDATE/DELETE.
