-- Dispositions ("tags") are data now, not code: the admin can add, rename,
-- recolour, reorder and retire them from the dashboard.
create table if not exists outcomes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key          text not null,
  label        text not null,
  color        text not null default 'zinc',
  kind         text not null default 'custom',
  sort         integer not null default 100,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create unique index if not exists outcomes_ws_key on outcomes (workspace_id, key);

-- Seed the tags the app shipped with, once per workspace.
insert into outcomes (workspace_id, key, label, color, kind, sort)
select w.id, v.key, v.label, v.color, v.kind, v.sort
  from workspaces w
 cross join (values
   ('connected_dm',        'Connected — DM',         'green',  'connected', 10),
   ('connected_gk',        'Connected — Gatekeeper', 'green',  'connected', 20),
   ('connected_other',     'Connected — Other',      'green',  'connected', 30),
   ('appointment_set',     'Appointment Set',        'emerald','positive',  40),
   ('callback_requested',  'Callback Requested',     'sky',    'callback',  50),
   ('voicemail',           'Voicemail',              'violet', 'voicemail', 60),
   ('ivr',                 'IVR / Phone Menu',       'violet', 'ivr',       70),
   ('no_answer',           'No Answer',              'zinc',   'no_answer', 80),
   ('busy',                'Busy',                   'amber',  'busy',      90),
   ('not_interested',      'Not Interested',         'amber',  'negative', 100),
   ('bad_number',          'Bad Number',             'red',    'bad',      110),
   ('do_not_call',         'Do Not Call',            'rose',   'dnc',      120),
   ('dialed',              'Dialed',                 'zinc',   'system',   130)
 ) as v(key, label, color, kind, sort)
on conflict (workspace_id, key) do nothing;

-- GoHighLevel connection.
alter table settings add column if not exists ghl_token text;
alter table settings add column if not exists ghl_location_id text;
alter table settings add column if not exists ghl_pipeline_id text;
alter table settings add column if not exists ghl_stage_id text;
