-- Local hosted-schema fixture: no protected economy, authority or social feature
-- migrations. Client-owned economy writes and ranking submission are intentional.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create schema storage;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
 select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
grant usage on schema public,auth,storage to anon,authenticated,service_role;
create table public.player_profiles(
 id uuid primary key references auth.users(id),
 nickname text not null default 'Jogador' check(char_length(nickname) between 1 and 12),
 gold integer not null default 0 check(gold>=0),
 rank_points integer not null default 0 check(rank_points>=0),
 matches integer not null default 0 check(matches>=0),
 wins integer not null default 0 check(wins>=0),
 losses integer not null default 0 check(losses>=0),
 avatar text not null default 'avatar-1.webp',hat text not null default 'crown',skin text not null default '#bdaee6',
 friendly_fire boolean not null default false,updated_at timestamptz not null default now(),
 abandon_warnings integer not null default 0,matchmaking_blocked_until timestamptz,last_abandon_at timestamptz,
 owned_characters text[] not null default array['capivara'],selected_character text not null default 'capivara',
 owned_emotes text[] not null default '{}'
);
alter table public.player_profiles enable row level security;
grant select,insert,update on public.player_profiles to authenticated;
create policy legacy_profile_read on public.player_profiles for select to authenticated using(id=auth.uid());
create policy legacy_profile_insert on public.player_profiles for insert to authenticated with check(id=auth.uid());
create policy legacy_profile_update on public.player_profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create table public.player_rankings(
 player_id uuid primary key,player_name text,avatar text,points integer,wins integer,losses integer,matches integer,updated_at timestamptz default now()
);
create function public.submit_player_ranking(p_player_id uuid,p_name text,p_avatar text,p_points integer,p_wins integer,p_losses integer,p_matches integer)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or auth.uid()<>p_player_id then raise exception 'Jogador não autorizado'; end if;
 insert into player_rankings(player_id,player_name,avatar,points,wins,losses,matches)
 values(p_player_id,p_name,p_avatar,p_points,p_wins,p_losses,p_matches)
 on conflict(player_id) do update set player_name=excluded.player_name,avatar=excluded.avatar,points=excluded.points,wins=excluded.wins,losses=excluded.losses,matches=excluded.matches;
 return true;
end $$;
revoke all on function public.submit_player_ranking(uuid,text,text,integer,integer,integer,integer) from public,anon;
grant execute on function public.submit_player_ranking(uuid,text,text,integer,integer,integer,integer) to authenticated;
create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(
 id uuid primary key default gen_random_uuid(),bucket_id text not null references storage.buckets(id),name text not null,
 owner_id text default auth.uid()::text,metadata jsonb not null default '{}',unique(bucket_id,name)
);
alter table storage.objects enable row level security;
grant select,insert,update,delete on storage.objects to authenticated;
