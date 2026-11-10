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

-- DTMF: keypad digits must reach the lead's phone, which a conference does not
-- forward on its own. We play them on the lead's own leg instead.
alter table call_logs add column if not exists dtmf_at timestamptz;
alter table settings add column if not exists local_presence_enabled boolean not null default true;
alter table settings add column if not exists parallel_lines int not null default 1;
