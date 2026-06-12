# Arquitectura — Fullsite OS

> Versión refinada del blueprint *FULLSITE OS 2.0* (reverse-engineered de NetSilver).
> El documento original era una visión; aquí queda como referencia técnica accionable.

## Resumen

NetSilver no es un POS: es un **sistema de control operativo distribuido**. Por eso los restaurantes confían en él — si un módulo falla, el restaurante no se detiene. Fullsite copia esa **confiabilidad operativa** y rediseña la arquitectura alrededor de eventos y AI.

## Lo que revelan los configs de NetSilver

Arquitectura distribuida con componentes independientes:

1. POS Client
2. SQL Server Database
3. Printing Service
4. Ecommerce Service
5. Web API
6. Mobile Comandero API
7. PinPad Service
8. Background Services

Lección: **aislamiento de fallos**. El comandero móvil tiene versión sincronizada (APK) → los meseros móviles son ciudadanos de primera clase, no web responsive.

## Modelo de Fullsite

Microservicios event-driven como **visión final**. **Monolito modular como punto de partida** (ver `adr/0001`). Las fronteras son las mismas; solo cambia el transporte.

```
Fullsite OS
├── Orders        → órdenes, mesas, comensales, cursos, descuentos, promos
├── Kitchen       → KDS, firebutton, ruteo, estaciones, estados
├── Payments      → efectivo, tarjeta, mixto, propinas, depósitos, corte
├── Inventory     → recetas, consumo, merma, traspasos, ajustes
├── CRM           → clientes, lealtad, visitas, ticket promedio
├── Delivery      → repartidor, ruta, settlement, GPS, ETA
├── Reporting     → X/Z, cortes, analítica
├── AI Agent      → sales, kitchen, fraud, food cost, GM
├── Notification  → telegram, email, push
├── Audit         → event store inmutable
├── Device        → impresoras, cajón, pinpad, scanner, KDS, displays
└── Sync          → cola offline, conflictos, replicación
```

## Offline-first (no negociable)

```
Internet caído
   ↓ seguir vendiendo
   ↓ seguir imprimiendo
   ↓ seguir mandando a cocina
   ↓ seguir cobrando
   ↓ sincronizar después
```

SQLite local como fuente de verdad operativa; sync diferido a Postgres al reconectar.

## Firebutton / Coursing

Cursos: Entradas → Fuertes → Postres. Acciones: `Fire Course`, `Fire Item`, `Fire All`. El KDS reacciona al instante (vía evento).

## Ruteo de cocina

```
Producto → Estación → KDS → Impresora
```
Latte→Bar · Pizza→Horno · Açaí→Pantry · Ribeye→Parrilla.

## Caja

Ledger de caja append-only: Fondo inicial · Retiro · Depósito · Corrección · Cierre.
**Nunca** editar saldo directo. Toda corrección es un evento.

## Corte de turno

X Report (informativo) · Z Report (final) · Cierre de gerente · Cierre corporativo.

## Motor de promociones (rule engine, no hardcode)

```
SI martes Y categoría = Bowls → 15% descuento
```

## Lealtad

Visitas · Gasto · Productos favoritos · Ticket promedio · **Fecha de retorno predicha** (input para CRM/AI).

## Capa AI (donde Fullsite gana)

- **Sales Agent** — upsells, cross-sells, combos, boosters de margen.
- **Kitchen Agent** — carga por estación, tiempos de ticket, cuellos de botella.
- **Fraud Agent** — cancelaciones/descuentos/cortesías excesivas, irregularidades de caja, abuso de gerente.
- **Food Cost Agent** — inflación de insumos, varianza de receta, merma, erosión de margen.
- **General Manager** — cada mañana: pronóstico de ventas y labor, riesgos de inventario, qué empujar, qué dejar de vender.

Todos consumen el **stream de eventos**. Ninguno vive en el path crítico de la venta.

## Regla dorada

Cada acción → un evento. Cada evento alimenta Analytics, AI, Inventory, Audit, Reporting, Forecasting, Operations. Sin excepciones.
