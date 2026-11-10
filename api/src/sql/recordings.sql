-- Recordings are copied to this server so Twilio's storage bill stops growing.
alter table call_logs add column if not exists recording_path text;
alter table call_logs add column if not exists recording_sha256 text;
alter table call_logs add column if not exists recording_bytes bigint;
alter table call_logs add column if not exists recording_copied_at timestamptz;
alter table call_logs add column if not exists recording_purged_at timestamptz;

alter table settings add column if not exists recording_retention_days int not null default 7;
