create extension if not exists pgcrypto with schema extensions;

create table if not exists public.game_rooms (
  code text primary key,
  name text not null,
  mode_id text not null,
  level_id text not null,
  red_size smallint not null default 2,
  blue_size smallint not null default 2,
  ffa_size smallint not null default 6,
  respawn_time smallint not null default 5,
  friendly_fire boolean not null default false,
  password_hash text,
  host_token uuid not null,
  players_count smallint not null default 0,
  created_at timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

alter table public.game_rooms enable row level security;
revoke all on public.game_rooms from anon, authenticated;

create or replace function public.list_game_rooms()
returns jsonb
language sql
security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', r.code,
    'name', r.name,
    'modeId', r.mode_id,
    'levelId', r.level_id,
    'isPrivate', r.password_hash is not null,
    'playersCount', r.players_count,
    'maxPlayers', case when r.mode_id = 'ffa' then r.ffa_size else r.red_size + r.blue_size end,
    'teamLimits', case when r.mode_id = 'ffa'
      then jsonb_build_object('ffa', r.ffa_size)
      else jsonb_build_object('red', r.red_size, 'blue', r.blue_size)
    end,
    'respawnTime', r.respawn_time,
    'friendlyFire', r.friendly_fire
  ) order by r.created_at desc), '[]'::jsonb)
  from public.game_rooms r
  where r.last_active_at > now() - interval '90 seconds';
$$;

create or replace function public.create_game_room(
  p_code text,
  p_name text,
  p_password text,
  p_mode_id text,
  p_level_id text,
  p_red_size integer,
  p_blue_size integer,
  p_ffa_size integer,
  p_respawn_time integer,
  p_friendly_fire boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  clean_code text := left(regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9_-]', '', 'g'), 12);
  clean_name text := left(trim(coalesce(p_name, '')), 24);
  token uuid := gen_random_uuid();
  room_json jsonb;
begin
  if clean_code = '' then clean_code := substr(replace(gen_random_uuid()::text, '-', ''), 1, 6); end if;
  if clean_name = '' then clean_name := 'Sala ' || clean_code; end if;
  if p_mode_id not in ('ctf', 'deathmatch', 'ffa') then p_mode_id := 'ctf'; end if;
  if p_level_id not in ('foundry', 'dojo', 'skyhaven', 'procedural') then p_level_id := 'foundry'; end if;

  delete from public.game_rooms where last_active_at <= now() - interval '90 seconds';
  if exists (select 1 from public.game_rooms where code = clean_code) then
    return jsonb_build_object('ok', false, 'error', 'Já existe uma sala ativa com esse código.');
  end if;

  insert into public.game_rooms (
    code, name, mode_id, level_id, red_size, blue_size, ffa_size,
    respawn_time, friendly_fire, password_hash, host_token, players_count
  ) values (
    clean_code, clean_name, p_mode_id, p_level_id,
    greatest(1, least(5, coalesce(p_red_size, 2))),
    greatest(1, least(5, coalesce(p_blue_size, 2))),
    greatest(2, least(10, coalesce(p_ffa_size, 6))),
    greatest(1, least(8, coalesce(p_respawn_time, 5))),
    coalesce(p_friendly_fire, false),
    case when coalesce(p_password, '') = '' then null else crypt(left(p_password, 20), gen_salt('bf')) end,
    token, 1
  );

  room_json := public.join_game_room(clean_code, coalesce(p_password, ''));
  return jsonb_build_object(
    'ok', true,
    'code', clean_code,
    'hostToken', token,
    'room', room_json
  );
end;
$$;

create or replace function public.join_game_room(p_code text, p_password text default '')
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  r public.game_rooms%rowtype;
begin
  select * into r from public.game_rooms
  where code = left(lower(trim(coalesce(p_code, ''))), 12)
    and last_active_at > now() - interval '90 seconds';
  if not found then return jsonb_build_object('ok', false, 'error', 'Sala não encontrada ou criador desconectado.'); end if;
  if r.password_hash is not null and crypt(left(coalesce(p_password, ''), 20), r.password_hash) <> r.password_hash then
    return jsonb_build_object('ok', false, 'error', 'Senha incorreta!');
  end if;
  if r.players_count >= (case when r.mode_id = 'ffa' then r.ffa_size else r.red_size + r.blue_size end) then
    return jsonb_build_object('ok', false, 'error', 'A sala está cheia!');
  end if;
  return jsonb_build_object(
    'ok', true,
    'code', r.code,
    'name', r.name,
    'modeId', r.mode_id,
    'levelId', r.level_id,
    'teamLimits', case when r.mode_id = 'ffa'
      then jsonb_build_object('ffa', r.ffa_size)
      else jsonb_build_object('red', r.red_size, 'blue', r.blue_size)
    end,
    'respawnTime', r.respawn_time,
    'friendlyFire', r.friendly_fire
  );
end;
$$;

create or replace function public.touch_game_room(p_code text, p_host_token uuid, p_players_count integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.game_rooms
  set players_count = greatest(0, least(10, coalesce(p_players_count, 0))),
      last_active_at = case when coalesce(p_players_count, 0) > 0 then now() else now() - interval '10 minutes' end
  where code = p_code and host_token = p_host_token;
  return found;
end;
$$;

revoke all on function public.list_game_rooms() from public;
revoke all on function public.create_game_room(text,text,text,text,text,integer,integer,integer,integer,boolean) from public;
revoke all on function public.join_game_room(text,text) from public;
revoke all on function public.touch_game_room(text,uuid,integer) from public;

grant execute on function public.list_game_rooms() to anon, authenticated;
grant execute on function public.create_game_room(text,text,text,text,text,integer,integer,integer,integer,boolean) to anon, authenticated;
grant execute on function public.join_game_room(text,text) to anon, authenticated;
grant execute on function public.touch_game_room(text,uuid,integer) to anon, authenticated;
