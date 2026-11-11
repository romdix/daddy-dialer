-- GoHighLevel link per lead.
alter table leads add column if not exists ghl_contact_id text;
alter table leads add column if not exists ghl_pushed_at timestamptz;
create index if not exists leads_ghl on leads (ghl_contact_id);
