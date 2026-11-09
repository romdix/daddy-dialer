-- Numbers the workspace can call FROM, and which one is used for each call.
create table if not exists caller_ids (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  number       text not null,
  label        text,
  active       boolean not null default true,
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (workspace_id, number)
);

create index if not exists caller_ids_ws on caller_ids (workspace_id);

-- Inbound calls and machine detection need to be recorded on the call itself.
alter table call_logs add column if not exists direction text not null default 'outbound';
alter table call_logs add column if not exists answered_by text;

-- Seed from whatever is already configured so existing installs keep working.
insert into caller_ids (workspace_id, number)
select workspace_id, twilio_number
  from settings
 where coalesce(twilio_number, '') <> ''
on conflict (workspace_id, number) do nothing;
