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
  if p_level_id not in ('foundry', 'dojo', 'skyhaven', 'feira_suspensa', 'procedural') then p_level_id := 'foundry'; end if;

  delete from public.game_rooms where last_active_at <= now() - interval '90 seconds';
  if exists (select 1 from public.game_rooms where code = clean_code) then
    return jsonb_build_object('ok', false, 'error', 'Já existe uma sala ativa com esse código.');
  end if;

  insert into public.game_rooms (
    code, name, mode_id, level_id, red_size, blue_size, ffa_size,
    respawn_time, friendly_fire, password_hash, host_token, players_count
  ) values (
    clean_code, clean_name, p_mode_id, p_level_id,
    greatest(1, least(10, coalesce(p_red_size, 2))),
    greatest(1, least(10, coalesce(p_blue_size, 2))),
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

