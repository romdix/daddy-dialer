-- Parallel dialling: several numbers rung at once, first answer wins.
create table if not exists call_batches (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  session_id     uuid,
  agent_call_sid text,
  created_at     timestamptz not null default now(),
  ended_at       timestamptz
);

alter table call_logs add column if not exists batch_id uuid;
create index if not exists call_logs_batch on call_logs (batch_id);

-- Local presence: prefer a caller ID in the lead's own area code.
alter table settings add column if not exists local_presence_enabled boolean not null default true;
alter table settings add column if not exists parallel_lines int not null default 1;
