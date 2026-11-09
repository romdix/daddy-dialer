-- Compliance + follow-up fields. Idempotent.

alter table leads add column if not exists attempts integer not null default 0;
alter table leads add column if not exists callback_at timestamptz;
alter table leads add column if not exists timezone text;

alter table call_logs add column if not exists notes text;

alter table settings add column if not exists enforce_compliance boolean not null default true;
alter table settings add column if not exists call_window_start integer not null default 8;
alter table settings add column if not exists call_window_end integer not null default 21;
alter table settings add column if not exists call_window_days text not null default '1,2,3,4,5';
alter table settings add column if not exists max_attempts integer not null default 0;
alter table settings add column if not exists default_timezone text;

create index if not exists leads_callback on leads (workspace_id, callback_at)
  where callback_at is not null;

-- 30s was too short: call screening on modern phones delays the answer.
-- Only move rows still on the old default.
alter table settings alter column ring_timeout_sec set default 60;
update settings set ring_timeout_sec = 60 where ring_timeout_sec = 30;
