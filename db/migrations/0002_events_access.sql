-- 0002_events_access.sql — Acceso para shadow mode + blindaje extra
-- El POS (usuarios logueados) puede INSERTAR y LEER eventos. Nada más.
-- anon: cero acceso (consistente con la postura RLS del dashboard).

alter table events enable row level security;

create policy events_insert_authenticated on events
  for insert to authenticated
  with check (true);

create policy events_select_authenticated on events
  for select to authenticated
  using (true);

grant insert, select on events to authenticated;
-- la columna identity necesita la secuencia:
grant usage, select on sequence events_sequence_seq to authenticated;

-- Blindaje a nivel BD (mejor que Wansoft: la regla vive en Postgres, no
-- solo en la app): un evento sensible NO PUEDE existir sin bloque audit
-- con approvedBy. Ni un bug del POS lo puede colar.
alter table events add constraint sensitive_requires_audit check (
  type not in (
    'orders.item.cancelled.v1',
    'orders.discount.applied.v1',
    'payments.cash.withdrawn.v1',
    'inventory.waste.recorded.v1',
    'inventory.adjusted.v1'
  )
  or (audit is not null and audit->>'approvedBy' is not null)
);

-- Sanidad del envelope: campos mínimos siempre presentes.
alter table events add constraint envelope_actor_complete check (
  actor ? 'userId' and actor ? 'deviceId'
);
