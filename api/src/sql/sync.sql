-- GoHighLevel sync: tag-on-import, quality gate, nightly top-up.
alter table settings add column if not exists ghl_sync_enabled boolean not null default false;
alter table settings add column if not exists ghl_sync_tag text not null default 'dialer-imported';
alter table settings add column if not exists ghl_sync_hour integer not null default 6;
alter table settings add column if not exists ghl_sync_amount integer not null default 100;
alter table settings add column if not exists ghl_skip_recent_days integer not null default 90;
alter table settings add column if not exists ghl_last_sync_at timestamptz;

-- Set when the contact was tagged back in GoHighLevel, so a failure is retried
-- rather than quietly losing the bookmark.
alter table leads add column if not exists ghl_tagged_at timestamptz;

create index if not exists leads_ghl_untagged on leads (workspace_id)
  where ghl_tagged_at is null and ghl_contact_id is not null;
