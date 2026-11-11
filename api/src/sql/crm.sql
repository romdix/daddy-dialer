-- GoHighLevel link per lead.
alter table leads add column if not exists ghl_contact_id text;
alter table leads add column if not exists ghl_pushed_at timestamptz;
create index if not exists leads_ghl on leads (ghl_contact_id);

-- Where the next pull should start, so repeated pulls move forward instead of
-- fetching the same first page forever.
alter table settings add column if not exists ghl_cursor_id text;
alter table settings add column if not exists ghl_cursor_at timestamptz;
