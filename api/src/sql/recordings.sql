-- Recordings are copied to this server so Twilio's storage bill stops growing.
alter table call_logs add column if not exists recording_path text;
alter table call_logs add column if not exists recording_sha256 text;
alter table call_logs add column if not exists recording_bytes bigint;
alter table call_logs add column if not exists recording_copied_at timestamptz;
alter table call_logs add column if not exists recording_purged_at timestamptz;

alter table settings add column if not exists recording_retention_days int not null default 7;

-- Answering-machine detection is billed per call, so it must be switchable.
alter table settings add column if not exists amd_enabled boolean not null default true;

-- Voicemail drop: play a message into the machine instead of hanging up.
alter table settings add column if not exists voicemail_drop_enabled boolean not null default false;
alter table settings add column if not exists voicemail_script text;
