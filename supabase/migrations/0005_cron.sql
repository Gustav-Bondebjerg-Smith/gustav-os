-- Gustav OS - Fase 7c: cron-locks og action-status til serverless workers.
-- Kør efter 0004_telegram_webhook.sql.

create table if not exists cron_locks (
  name         text primary key,
  locked_until timestamptz not null,
  locked_by    text,
  updated_at   timestamptz not null default now()
);

alter table cron_locks enable row level security;

create or replace function claim_cron_lock(
  lock_name text,
  ttl_seconds integer,
  lock_owner text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed boolean;
begin
  insert into cron_locks (name, locked_until, locked_by, updated_at)
  values (
    lock_name,
    now() + make_interval(secs => greatest(ttl_seconds, 1)),
    lock_owner,
    now()
  )
  on conflict (name) do update
    set locked_until = excluded.locked_until,
        locked_by = excluded.locked_by,
        updated_at = now()
    where cron_locks.locked_until < now()
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

create or replace function release_cron_lock(
  lock_name text,
  lock_owner text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  released boolean;
begin
  update cron_locks
     set locked_until = now(),
         updated_at = now()
   where name = lock_name
     and locked_by = lock_owner
  returning true into released;

  return coalesce(released, false);
end;
$$;

alter table actions add column if not exists processing_started_at timestamptz;
create index if not exists idx_actions_processing_started_at
  on actions (status, processing_started_at);
