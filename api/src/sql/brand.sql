-- Instance branding (single row). Lets the same build run under any name.
create table if not exists app_brand (
  id            integer primary key default 1 check (id = 1),
  name          text not null default 'Power Dialer',
  initials      text not null default 'PD',
  accent        text not null default '#22C55E',
  logo_url      text,
  support_email text,
  updated_at    timestamptz not null default now()
);

insert into app_brand (id) values (1) on conflict (id) do nothing;
