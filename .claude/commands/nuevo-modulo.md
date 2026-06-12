---
description: Crea un nuevo módulo respetando las fronteras event-driven de Fullsite OS
---

Vas a crear un nuevo módulo en `src/modules/`. Sigue las reglas de `CLAUDE.md` al pie de la letra.

Nombre del módulo: $ARGUMENTS

Pasos:
1. Confirma la **responsabilidad única** del módulo en una frase. Si hace más de una cosa, párate y propón dividirlo.
2. Crea `src/modules/<nombre>/README.md` con: responsabilidad única, eventos que emite, eventos que consume, y la regla de frontera.
3. Define los eventos nuevos en `docs/EVENTS.md` usando la convención `dominio.entidad.accion.vN` en pasado. Marca los sensibles.
4. Implementa el módulo SOLO con: handlers que publican eventos + listeners que reaccionan. **Cero imports internos de otros módulos.** Usa contratos de `src/shared/events/`.
5. Verifica: ¿alguna acción muta estado sin emitir evento? Si sí, corrígelo (viola la regla de oro).

Antes de escribir código, muéstrame el diseño de eventos y espera mi OK.
