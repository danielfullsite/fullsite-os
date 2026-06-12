# CLAUDE.md — Fullsite OS

> Memoria del proyecto para Claude Code. Léela completa antes de tocar código.
> Fuente de la visión: `docs/ARCHITECTURE.md` (reverse-engineered de NetSilver).

---

## 1. Qué es Fullsite

El **Restaurant Operating System** más inteligente del mundo. AI-native. Monterrey, MX.
Founder solo (Daniel). Cliente ancla y banco de pruebas: **AMALAY Coffee & Market** (San Pedro).

NetSilver ayuda a los restaurantes a **sobrevivir**.
Fullsite los ayuda a **crecer**.

NetSilver es un POS. Fullsite es el sistema operativo sobre el que opera el restaurante.

---

## 2. Regla de oro — NO NEGOCIABLE

**Cada acción genera un evento. Cada evento alimenta:**
Analytics · AI · Inventory · Audit · Reporting · Forecasting · Operations.

**Sin excepciones.** Si un cambio de código no produce un evento auditable cuando debería, está mal hecho. Antes de implementar cualquier acción de usuario, define primero el evento que emite (`docs/EVENTS.md`).

---

## 3. Principios de arquitectura (en orden de prioridad)

1. **Event-driven, append-only.** El estado se deriva de eventos. La historia NUNCA se reescribe; solo se agregan eventos. Para "corregir" algo se emite un evento de corrección, no se hace UPDATE.
2. **Offline-first.** El restaurante debe seguir vendiendo, imprimiendo, mandando a cocina y cobrando aunque se caiga el internet. Sync diferido al reconectar. Esto es lo que hace que NetSilver sea confiable; lo igualamos o no existimos.
3. **Fronteras de módulo estrictas.** Cada módulo tiene UNA responsabilidad. No mete mano en las tablas/estado de otro módulo. Se comunican por eventos.
4. **Inventory recibe eventos, nunca se edita directo.** El POS jamás modifica inventario a mano; emite eventos de consumo/merma y el módulo de inventory reacciona.
5. **Auditoría inmutable de acciones sensibles.** Cancelaciones, descuentos, retiros de caja, cortesías → evento con quién/qué/cuándo/por qué/aprobado-por/dispositivo/antes/después.

Si alguna instrucción del usuario choca con (1)–(5), señálalo antes de implementar.

---

## 4. Decisión clave: monolito modular PRIMERO

El blueprint dice "nunca construyas un monolito". Para un founder solo, arrancar con 12 microservicios distribuidos es una trampa (devops, despliegues, latencia, observabilidad — todo x12).

**Por eso empezamos como MONOLITO MODULAR:**

- Un solo deploy. Los "servicios" son **módulos** dentro de `src/modules/` con fronteras estrictas.
- Se comunican por un **event bus interno** (no llamadas directas entre módulos).
- Las fronteras se respetan desde el día 1 → extraer un módulo a microservicio después es trivial (cambias el transporte del bus, no la lógica).

**Regla práctica:** ningún módulo importa código interno de otro módulo. Solo publica/escucha eventos y usa contratos compartidos (`src/shared/`).

Ver `docs/adr/0001-monolito-modular-primero.md`.

---

## 5. Módulos (= servicios futuros)

| Módulo | Responsabilidad única | Ver |
|---|---|---|
| `orders` | Órdenes, mesas, asientos, comensales, cursos, descuentos, promos | `src/modules/orders/README.md` |
| `kitchen` | KDS, firebutton, ruteo a estaciones, estados de producción | `src/modules/kitchen/README.md` |
| `payments` | Efectivo, tarjeta, pagos mixtos, propinas, corte de turno | `src/modules/payments/README.md` |
| `inventory` | Recetas, consumo, merma, traspasos, ajustes (event-in only) | `src/modules/inventory/README.md` |
| `crm` | Clientes, lealtad, visitas, ticket promedio, retorno predicho | `src/modules/crm/README.md` |
| `delivery` | Repartidores, rutas, settlement, GPS, ETA | `src/modules/delivery/README.md` |
| `reporting` | X/Z reports, cortes, analítica derivada de eventos | `src/modules/reporting/README.md` |
| `ai-agent` | Sales, Kitchen, Fraud, Food Cost, General Manager | `src/modules/ai-agent/README.md` |
| `notification` | Telegram, email, push, alertas | `src/modules/notification/README.md` |
| `audit` | Event store inmutable de acciones sensibles | `src/modules/audit/README.md` |
| `device` | Impresoras, cajones, pinpads, scanners, KDS, displays | `src/modules/device/README.md` |
| `sync` | Cola offline, resolución de conflictos, replicación | `src/modules/sync/README.md` |

---

## 6. Stack recomendado (ajustable — discútelo antes de cambiarlo)

Elegido para **un solo desarrollador**, offline-first, y reaprovechar lo que Daniel ya domina (Supabase, Tailwind, Python para agentes).

- **Lenguaje núcleo:** TypeScript en todo el monorepo (un solo lenguaje = menos carga mental para solo founder).
- **Monorepo:** pnpm workspaces.
- **Cliente POS:** React + Tailwind como PWA o Tauri (escritorio). Base de datos **local SQLite** para offline-first.
- **Datos / event store:** Postgres (Supabase). Tabla de eventos **append-only** como fuente de verdad.
- **Sync offline-first:** PowerSync o ElectricSQL sobre Supabase (sincroniza SQLite local ↔ Postgres). Esto resuelve el principio #2 sin reinventarlo.
- **Agentes AI:** servicio aparte (puede seguir en Python, donde Daniel ya tiene los 30 agentes). Consume el stream de eventos; no vive dentro del path crítico de venta.
- **Bus de eventos interno:** empezar simple (emisor en proceso + tabla de outbox en Postgres). NO traer Kafka todavía.

> Lo que ya corre en producción (sidecar de Wansoft → Telegram, dashboard, query bot) **no se toca**. Este repo es el OS 2.0 propietario, north star a mediano plazo, no un reemplazo de un día para otro.

---

## 7. Convenciones de código

**Eventos** (lo más importante del repo):
- Nombre: `dominio.entidad.accion.vN` en **pasado**. Ej: `orders.ticket.created.v1`, `payments.shift.closed.v1`, `inventory.item.consumed.v1`.
- Todo evento lleva: `id`, `type`, `occurredAt`, `actor` (usuario/dispositivo), `payload`, `version`.
- Eventos sensibles añaden bloque `audit`: `requestedBy`, `approvedBy`, `reason`, `before`, `after`.
- Nunca borres ni edites un evento. Corrección = nuevo evento.

**Módulos:**
- Cada módulo expone solo: (a) handlers que publican eventos, (b) listeners que reaccionan a eventos. Nada de imports cruzados.
- Contratos de evento compartidos van en `src/shared/events/`.

**General:**
- Identificadores y nombres de archivo en inglés; comentarios y docs pueden ir en español.
- Migraciones de DB versionadas y nunca destructivas en tablas de eventos.

---

## 8. Modelo de seguridad / aprobaciones

Cuatro niveles (ver `docs/SECURITY.md`):
1. Permiso de usuario (puede descontar / cancelar / retirar).
2. Aprobación de gerente (PIN, app, FaceID o passkey).
3. Aprobación corporativa (regional).
4. AI Fraud Agent (marca patrones sospechosos aunque la acción haya sido aprobada).

Toda acción que requiera aprobación **debe** emitir un evento de auditoría con `approvedBy`.

---

## 9. Realidades del negocio (contexto para no romper supuestos)

- AMALAY es el cliente real donde se prueba todo. Si algo afecta operación de AMALAY, es producción.
- Wansoft tiene un bug conocido: no corrige número de comensales al cerrar mesa → infla el ticket promedio por mesero. Cualquier analítica derivada debe contemplarlo.
- Filtros de personal que NO entran en rankings de meseros: APLICACIONES, MESERO EVENTO, Oscar Ricardo (supervisor caja), Hector Enrique (cajero). Preservar si se migra lógica de parser.

---

## 10. Cómo trabajar en este repo (para Claude Code)

1. Antes de implementar una acción de usuario → diseña el evento primero (`docs/EVENTS.md`).
2. Antes de tocar dos módulos en un mismo cambio → pregúntate si no estás violando una frontera. Probablemente debas comunicarlos por evento.
3. Nada de UPDATE/DELETE sobre tablas de eventos o auditoría.
4. Si vas a meter una dependencia pesada (Kafka, k8s, microservicios reales) → para y propón un ADR primero.
5. Usa `/nuevo-modulo` y `/revisar-evento` (en `.claude/commands/`).
