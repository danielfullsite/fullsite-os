# ADR 0001 — Monolito modular primero, microservicios después

- **Estado:** Aceptado
- **Fecha:** 2026-06-12
- **Contexto:** Founder solo. El blueprint pide microservicios event-driven puros.

## Decisión

Arrancamos Fullsite OS como **monolito modular**, no como microservicios distribuidos.

- Un solo deploy.
- Los 12 "servicios" del blueprint son **módulos** en `src/modules/` con fronteras estrictas.
- Comunicación **solo por eventos** (event bus interno; outbox en Postgres).
- Ningún módulo importa código interno de otro. Contratos compartidos en `src/shared/`.

## Por qué

Un solo desarrollador no puede sostener 12 servicios distribuidos (CI/CD, observabilidad, redes, versionado de APIs, latencia) sin que el overhead operativo mate la velocidad de producto. La complejidad distribuida no aporta valor mientras haya un solo equipo y poca escala.

## Cómo preservamos la visión

Las **fronteras** son idénticas a las de la arquitectura final. Como los módulos ya se comunican por eventos y no se importan entre sí, extraer cualquiera a microservicio real más adelante es cambiar el **transporte** del bus (de in-process a red), no reescribir lógica.

## Cuándo extraer un servicio

Solo cuando un módulo concreto lo justifique por:
- escala independiente (ej. `kitchen`/KDS bajo mucha carga),
- aislamiento de fallos crítico,
- o un equipo dedicado.

Cualquier extracción se documenta en un nuevo ADR.

## Consecuencias

- (+) Velocidad de desarrollo alta para un solo founder.
- (+) Migración futura barata gracias a fronteras limpias.
- (−) Disciplina manual: es fácil "hacer trampa" e importar otro módulo. El subagente `architecture-guardian` y el comando `/revisar-evento` ayudan a evitarlo.
