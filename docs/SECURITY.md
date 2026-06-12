# Modelo de seguridad — Fullsite OS

> El feature más fuerte de NetSilver. Lo igualamos y le sumamos AI.

## Niveles de permiso

### Nivel 1 — Permiso de usuario
Lo que el usuario puede hacer por su rol:
```
Puede descontar
Puede cancelar
Puede retirar caja
```

### Nivel 2 — Aprobación de gerente
Cuando el usuario no tiene permiso:
```
Sin permiso
   ↓
PIN de gerente
   OR  aprobación en app de gerente
   OR  FaceID
   OR  Passkey
```

### Nivel 3 — Aprobación corporativa
Acciones de alto impacto requieren aprobación regional.

### Nivel 4 — AI Fraud Agent
Aunque la acción se haya aprobado, el agente marca patrones sospechosos:
```
Aprobación concedida
   ↓
AI detecta patrón sospechoso → flag
```

## Regla de auditoría

**Toda** acción que pase por aprobación (niveles 2–3) emite un evento de auditoría con:

```
quién (requestedBy)
qué
cuándo
por qué (reason)
aprobado por (approvedBy)
dispositivo
antes / después
```

Estos eventos son inmutables y append-only (ver `EVENTS.md`). El módulo `audit` es el único dueño del event store de auditoría.

## Patrones que vigila el Fraud Agent

- Cancelaciones excesivas
- Descuentos excesivos
- Cortesías excesivas
- Irregularidades de caja
- Abuso de gerente (un mismo aprobador firmando demasiado)
