-- Guestbook schema. The platform runs every .sql file in this folder, in order, on
-- each deploy. Migrations are plain SQL files so they are easy to read and safe to re-run.

create table if not exists notes (
  id          bigint generated always as identity primary key,
  author_email text not null,
  body        text not null,
  photo_url   text,
  created_at  timestamptz not null default now()
);

-- Warm first open: a brand-new app should never be a blank screen. Seed one welcome
-- note so the very first visit already has something in it. Runs once.
insert into notes (author_email, body)
select 'the-platform', 'Welcome to your guestbook. It is live on the internet right now. Sign in and leave the first real note.'
where not exists (select 1 from notes);
