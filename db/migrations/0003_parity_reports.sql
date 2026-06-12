-- 0003_parity_reports.sql — Resultados del comparador de paridad (fase shadow)
-- Una fila por corrida. El dashboard/chat del POS lee de aquí para responder
-- "¿cómo va la paridad?". Solo escribe el cron (service_role); authenticated lee.

create table if not exists parity_reports (
  id bigint generated always as identity primary key,
  day date not null,
  ran_at timestamptz not null default now(),
  legacy_ops integer not null,
  event_ops integer not null,
  matched integer not null,
  diffs jsonb not null default '[]'::jsonb,
  unaudited_cancellations integer not null default 0,
  ok boolean not null
);

create index if not exists idx_parity_reports_day on parity_reports (day desc);

alter table parity_reports enable row level security;

create policy parity_select_authenticated on parity_reports
  for select to authenticated
  using (true);

grant select on parity_reports to authenticated;
