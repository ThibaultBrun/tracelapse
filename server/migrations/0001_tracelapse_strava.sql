-- Tracelapse ↔ Pista account link: stores the Strava refresh token against a
-- Pista (Supabase auth) user, plus the new-activity notification opt-in.
-- Applied on the Pista self-host DB (api.pista.bike). RLS enabled with NO policy
-- → only the service role / backend can read/write (tokens stay server-side).
create table if not exists public.tracelapse_strava (
  user_id uuid primary key references auth.users(id) on delete cascade,
  athlete_id bigint unique not null,
  athlete_name text,
  email text,
  access_token text,
  refresh_token text not null,
  expires_at timestamptz,
  scope text,
  notify boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.tracelapse_strava enable row level security;
create index if not exists tracelapse_strava_athlete_idx on public.tracelapse_strava (athlete_id);
