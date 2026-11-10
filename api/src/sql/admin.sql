-- Single-tenant mode: users are staff, an env-configured admin manages them.
alter table users add column if not exists can_upload_leads boolean not null default false;
alter table users add column if not exists can_hear_recordings boolean not null default false;
alter table users add column if not exists is_active boolean not null default true;
alter table users add column if not exists caller_id text;
alter table users add column if not exists parallel_lines int not null default 1;
alter table users add column if not exists updated_at timestamptz not null default now();

-- Accounts are soft-deleted: call history and leads keep pointing at them, and
-- the admin can still open the account to move its leads or restore it.
alter table users add column if not exists deleted_at timestamptz;

-- Uploaded lead files, so a whole file can be handed to a rep later.
create table if not exists lead_uploads (
  id          uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  filename    text not null,
  total       integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists lead_uploads_ws on lead_uploads (workspace_id, created_at desc);

alter table leads add column if not exists upload_id uuid references lead_uploads(id) on delete set null;
create index if not exists leads_upload on leads (upload_id);

-- A lead belongs to one rep. Unassigned leads are visible only to the admin.
alter table leads add column if not exists assigned_user_id uuid references users(id) on delete set null;
create index if not exists leads_assigned on leads (assigned_user_id);

-- Per-user call history and statistics.
alter table call_logs add column if not exists user_id uuid references users(id) on delete set null;
create index if not exists call_logs_user on call_logs (user_id, called_at desc);

-- Sessions belong to the rep who built them.
alter table calling_sessions add column if not exists owner_user_id uuid references users(id) on delete set null;
create index if not exists calling_sessions_owner on calling_sessions (owner_user_id, created_at desc);

-- Backfill: existing calls belong to whoever the workspace owner is.
update call_logs c
   set user_id = m.user_id
  from workspace_members m
 where c.user_id is null
   and m.workspace_id = c.workspace_id
   and m.role = 'owner';

-- Single tenant: every account works in the primary (oldest) workspace. Accounts
-- created by the old sign-up flow otherwise sat in their own empty workspace and
-- saw no leads.
insert into workspace_members (workspace_id, user_id, role)
select (select id from workspaces order by created_at asc limit 1), u.id, 'member'
  from users u
 where not exists (
   select 1
     from workspace_members m
    where m.user_id = u.id
      and m.workspace_id = (select id from workspaces order by created_at asc limit 1)
 );

-- Existing leads are left unassigned on purpose: the admin hands them out.
