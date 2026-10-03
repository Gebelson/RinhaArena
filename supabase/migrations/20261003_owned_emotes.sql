alter table public.player_profiles
  add column if not exists owned_emotes text[] not null default '{}'::text[];
