# Fullsite OS

El Restaurant Operating System AI-native. Reverse-engineered de NetSilver, rediseñado sobre eventos.

> **NetSilver ayuda a los restaurantes a sobrevivir. Fullsite los ayuda a crecer.**

## Empezar con Claude Code

```bash
git init
claude            # Claude Code leerá CLAUDE.md automáticamente
```

`CLAUDE.md` es la memoria del proyecto: léela antes que nada.

## Estructura

```
CLAUDE.md                    ← memoria del proyecto (reglas no negociables)
docs/
  ARCHITECTURE.md            ← blueprint técnico
  EVENTS.md                  ← catálogo de eventos (el corazón del sistema)
  SECURITY.md                ← niveles de permiso y aprobación
  adr/0001-...               ← por qué monolito modular primero
.claude/
  commands/                  ← /nuevo-modulo, /revisar-evento
  agents/                    ← architecture-guardian
src/modules/                 ← 12 módulos = servicios futuros
```

## Las 5 reglas no negociables

1. Cada acción genera un evento (regla de oro).
2. Offline-first: el restaurante nunca se detiene.
3. Append-only: la historia jamás se reescribe.
4. Fronteras de módulo estrictas: se comunican por eventos.
5. Inventory solo recibe eventos, nunca se edita directo.

## Estado

Repo del OS 2.0 propietario (north star a mediano plazo). No reemplaza lo que ya corre en producción (sidecar Wansoft, dashboard, query bot).
