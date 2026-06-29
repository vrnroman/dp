-- Stores personal data, and the app has no sign-in (auth tier none) — the reviewer should flag it.
create table if not exists customers (
  id          bigint generated always as identity primary key,
  email       text not null,
  phone       text,
  full_name   text,
  created_at  timestamptz not null default now()
);
