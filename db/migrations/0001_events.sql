-- 0001_events.sql — Event store append-only (fuente de verdad)
-- Regla de oro: NUNCA UPDATE ni DELETE sobre esta tabla. Corrección = nuevo evento.
-- (Ya aplicada en Supabase el 2026-06-12.)

create table if not exists events (
  sequence     bigint generated always as identity primary key, -- orden total de llegada
  id           uuid not null unique,                            -- id del envelope (idempotencia)
  type         text not null,                                   -- 'orders.item.added.v1'
  version      int not null,
  occurred_at  timestamptz not null,                            -- cuándo pasó (reloj del cliente, offline-first)
  recorded_at  timestamptz not null default now(),              -- cuándo llegó al store
  actor        jsonb not null,                                  -- { "userId": ..., "deviceId": ... }
  payload      jsonb not null,
  audit        jsonb                                            -- null salvo eventos sensibles
);

create index if not exists events_type_idx on events (type);
create index if not exists events_occurred_at_idx on events (occurred_at);

-- Capa 1: trigger — ni siquiera el rol postgres muta sin dropear el trigger primero.
create or replace function reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'events is append-only: % not allowed', tg_op;
end $$;

drop trigger if exists events_immutable on events;
create trigger events_immutable
  before update or delete on events
  for each row execute function reject_mutation();

-- Capa 2: permisos — los roles de la app ni siquiera pueden intentarlo.
revoke update, delete on events from anon, authenticated;
