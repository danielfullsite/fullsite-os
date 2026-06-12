---
description: Revisa que un evento cumpla las reglas inviolables del event store
---

Revisa el evento o flujo descrito en: $ARGUMENTS

Checklist contra `docs/EVENTS.md` y `CLAUDE.md`:

1. **Nombre**: ¿sigue `dominio.entidad.accion.vN` en pasado?
2. **Envelope**: ¿lleva `id`, `type`, `version`, `occurredAt`, `actor`, `payload`?
3. **Sensible**: si es cancelación/descuento/retiro/cortesía/ajuste, ¿incluye bloque `audit` con `requestedBy`, `approvedBy`, `reason`, `before`, `after`?
4. **Append-only**: ¿el código hace algún UPDATE o DELETE sobre eventos? → ERROR, debe ser un evento de corrección nuevo.
5. **Frontera**: ¿el emisor pertenece al módulo dueño de esa entidad? ¿algún consumidor importa código de otro módulo en vez de escuchar el evento?
6. **Regla de oro**: ¿la acción de usuario asociada realmente emite este evento? ¿hay alguna mutación de estado que NO emita evento?

Reporta cada punto como ✅ o ❌ con la corrección concreta.
