-- Dialer schema. Safe to run on every boot (idempotent).

create extension if not exists pg_trgm;

create table if not exists workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  password_hash text not null,
  full_name     text,
  created_at    timestamptz not null default now()
);
create unique index if not exists users_email_lower on users (lower(email));

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  role         text not null default 'owner',
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- Login sessions -----------------------------------------------------------
create table if not exists auth_sessions (
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Leads --------------------------------------------------------------------
create table if not exists leads (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  business_name text not null default '',
  phone         text not null,
  phone_norm    text not null,
  address       text,
  city          text,
  state         text,
  zip           text,
  website       text,
  email         text,
  notes         text,
  status        text not null default 'new',
  outcome       text,
  last_called_at timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint leads_unique_phone unique (workspace_id, phone_norm)
);

create index if not exists leads_ws_status on leads (workspace_id, status);
create index if not exists leads_ws_outcome on leads (workspace_id, outcome);
create index if not exists leads_ws_city on leads (workspace_id, lower(city));
create index if not exists leads_ws_state on leads (workspace_id, lower(state));
create index if not exists leads_ws_last_called on leads (workspace_id, last_called_at desc nulls last);
create index if not exists leads_trgm on leads using gin (
  (business_name || ' ' || phone || ' ' || coalesce(city,'') || ' ' || coalesce(address,'')) gin_trgm_ops
);

-- Calling sessions ---------------------------------------------------------
create table if not exists calling_sessions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name         text not null,
  status       text not null default 'pending',
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz
);
create index if not exists calling_sessions_ws on calling_sessions (workspace_id, created_at desc);

create table if not exists session_leads (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references calling_sessions(id) on delete cascade,
  lead_id     uuid not null references leads(id) on delete cascade,
  queue_order integer not null,
  status      text not null default 'pending',
  outcome     text,
  called_at   timestamptz,
  unique (session_id, lead_id)
);
create index if not exists session_leads_order on session_leads (session_id, queue_order);

-- Call log -----------------------------------------------------------------
create table if not exists call_logs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  lead_id          uuid references leads(id) on delete set null,
  session_id       uuid references calling_sessions(id) on delete set null,
  provider         text not null default 'twilio',
  provider_call_id text,
  direction        text not null default 'outbound',
  from_number      text,
  to_number        text,
  status           text not null default 'queued',
  outcome          text,
  duration_sec     integer not null default 0,
  recording_url    text,
  recording_sid    text,
  transcript       text,
  error            text,
  called_at        timestamptz not null default now(),
  ended_at         timestamptz
);
create index if not exists call_logs_ws_time on call_logs (workspace_id, called_at desc);
create unique index if not exists call_logs_sid on call_logs (provider, provider_call_id)
  where provider_call_id is not null;

-- Per-workspace phone settings --------------------------------------------
create table if not exists settings (
  workspace_id        uuid primary key references workspaces(id) on delete cascade,
  provider            text not null default 'twilio',
  twilio_account_sid  text,
  twilio_auth_token   text,
  twilio_number       text,
  twilio_twiml_app    text,
  twilio_api_key_sid  text,
  twilio_api_key_secret text,
  telnyx_api_key      text,
  telnyx_connection_id text,
  telnyx_number       text,
  recording_enabled   boolean not null default true,
  ring_timeout_sec    integer not null default 30,
  updated_at          timestamptz not null default now()
);
