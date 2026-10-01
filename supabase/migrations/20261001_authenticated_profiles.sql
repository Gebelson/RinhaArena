create table if not exists public.player_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null default 'Jogador' check (char_length(nickname) between 1 and 12),
  gold integer not null default 0 check (gold >= 0),
  rank_points integer not null default 0 check (rank_points >= 0),
  matches integer not null default 0 check (matches >= 0),
  wins integer not null default 0 check (wins >= 0),
  losses integer not null default 0 check (losses >= 0),
  avatar text not null default 'avatar-1.webp',
  hat text not null default 'crown',
  skin text not null default '#bdaee6',
  friendly_fire boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.player_profiles enable row level security;
revoke all on public.player_profiles from anon;
grant select, insert, update on public.player_profiles to authenticated;

drop policy if exists "players read own profile" on public.player_profiles;
create policy "players read own profile" on public.player_profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists "players create own profile" on public.player_profiles;
create policy "players create own profile" on public.player_profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists "players update own profile" on public.player_profiles;
create policy "players update own profile" on public.player_profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
