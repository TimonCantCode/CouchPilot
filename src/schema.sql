create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  pw_hash text,
  created_at timestamptz not null default now()
);

-- Install token: lookup via hash, display via encrypted copy
create table if not exists configs (
  user_id uuid primary key references users(id) on delete cascade,
  token_hash text unique not null,
  token_enc text not null,
  settings jsonb not null default '{}',
  secrets_enc text,
  updated_at timestamptz not null default now()
);

-- Migrations from older versions (idempotent)
alter table users alter column email drop not null;
alter table users alter column pw_hash drop not null;
alter table users add column if not exists parent_id uuid references users(id) on delete cascade;
alter table users add column if not exists label text;
alter table configs add column if not exists has_history boolean not null default false;
alter table configs add column if not exists last_seen timestamptz;
create index if not exists users_parent_idx on users(parent_id);
create index if not exists configs_job_idx on configs(has_history, last_seen);
