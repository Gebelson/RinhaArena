-- Supabase Free room capacity for the existing browser-hosted room protocol.
-- Standalone additive migration: no authority, economy or membership migrations.
-- Existing oversized room rows remain intact, but are unavailable to new joins
-- and listings. Their hosts cannot renew them; an expired code can be recreated.
begin;

-- NOT VALID preserves old room records while checking every future insert/update,
-- including writes performed by privileged SQL clients that bypass room RPCs.
do $$
begin
 if not exists(select 1 from pg_constraint where conrelid='public.game_rooms'::regclass and conname='game_rooms_free_team_capacity') then
  alter table public.game_rooms add constraint game_rooms_free_team_capacity
   check(red_size between 1 and 3 and blue_size between 1 and 3 and ffa_size between 2 and 6) not valid;
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.game_rooms'::regclass and conname='game_rooms_free_player_count') then
  alter table public.game_rooms add constraint game_rooms_free_player_count
   check(players_count between 0 and (case when mode_id='ffa' then ffa_size else red_size+blue_size end)) not valid;
 end if;
end $$;

create or replace function public.list_game_rooms() returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'code',r.code,'name',r.name,'modeId',r.mode_id,'levelId',r.level_id,
  'isPrivate',r.password_hash is not null,'playersCount',r.players_count,
  'maxPlayers',case when r.mode_id='ffa' then r.ffa_size else r.red_size+r.blue_size end,
  'teamLimits',case when r.mode_id='ffa' then jsonb_build_object('ffa',r.ffa_size) else jsonb_build_object('red',r.red_size,'blue',r.blue_size) end,
  'respawnTime',r.respawn_time,'friendlyFire',r.friendly_fire
 ) order by r.created_at desc),'[]'::jsonb)
 from public.game_rooms r
 where r.last_active_at>now()-interval '90 seconds'
  and r.red_size between 1 and 3 and r.blue_size between 1 and 3 and r.ffa_size between 2 and 6
  and r.players_count between 0 and (case when r.mode_id='ffa' then r.ffa_size else r.red_size+r.blue_size end);
$$;

create or replace function public.join_game_room(p_code text,p_password text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare r public.game_rooms%rowtype; capacity integer;
begin
 select * into r from public.game_rooms
 where code=left(lower(trim(coalesce(p_code,''))),12) and last_active_at>now()-interval '90 seconds';
 if not found then return jsonb_build_object('ok',false,'error','Sala não encontrada ou criador desconectado.'); end if;
 if r.red_size not between 1 and 3 or r.blue_size not between 1 and 3 or r.ffa_size not between 2 and 6
  or r.players_count<0 then return jsonb_build_object('ok',false,'error','Esta sala excede o limite de 3v3. Crie uma nova sala.'); end if;
 capacity:=case when r.mode_id='ffa' then r.ffa_size else r.red_size+r.blue_size end;
 if r.password_hash is not null and extensions.crypt(left(coalesce(p_password,''),20),r.password_hash)<>r.password_hash then
  return jsonb_build_object('ok',false,'error','Senha incorreta!');
 end if;
 if r.players_count>=capacity then return jsonb_build_object('ok',false,'error','A sala está cheia!'); end if;
 -- The legacy host admits realtime participants and reports the roster through
 -- touch_game_room. This lookup retains that protocol and does not invent members.
 return jsonb_build_object('ok',true,'code',r.code,'name',r.name,'modeId',r.mode_id,'levelId',r.level_id,
  'teamLimits',case when r.mode_id='ffa' then jsonb_build_object('ffa',r.ffa_size) else jsonb_build_object('red',r.red_size,'blue',r.blue_size) end,
  'respawnTime',r.respawn_time,'friendlyFire',r.friendly_fire);
end $$;

create or replace function public.create_game_room(
 p_code text,p_name text,p_password text,p_mode_id text,p_level_id text,
 p_red_size integer,p_blue_size integer,p_ffa_size integer,p_respawn_time integer,p_friendly_fire boolean
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,extensions as $$
declare
 clean_code text:=left(regexp_replace(lower(coalesce(p_code,'')),'[^a-z0-9_-]','','g'),12);
 clean_name text:=left(trim(coalesce(p_name,'')),24);
 token uuid:=gen_random_uuid(); room_json jsonb;
 red_size integer:=coalesce(p_red_size,2); blue_size integer:=coalesce(p_blue_size,2); ffa_size integer:=coalesce(p_ffa_size,6);
begin
 if red_size not between 1 and 3 or blue_size not between 1 and 3 or ffa_size not between 2 and 6 then
  return jsonb_build_object('ok',false,'error','Use de 1 a 3 jogadores por time e no máximo 6 jogadores na sala.');
 end if;
 if clean_code='' then clean_code:=substr(replace(gen_random_uuid()::text,'-',''),1,6); end if;
 if clean_name='' then clean_name:='Sala '||clean_code; end if;
 if coalesce(p_mode_id,'') not in('ctf','deathmatch','ffa') then p_mode_id:='ctf'; end if;
 if coalesce(p_level_id,'') not in('foundry','dojo','skyhaven','feira_suspensa','procedural') then p_level_id:='foundry'; end if;

 -- Reuse only the requested expired code. Never delete unrelated rooms or rows
 -- containing account data. The conflict predicate also handles concurrent creates.
 insert into public.game_rooms(code,name,mode_id,level_id,red_size,blue_size,ffa_size,
  respawn_time,friendly_fire,password_hash,host_token,players_count,created_at,last_active_at)
 values(clean_code,clean_name,p_mode_id,p_level_id,red_size,blue_size,ffa_size,
  greatest(1,least(8,coalesce(p_respawn_time,5))),coalesce(p_friendly_fire,false),
  case when coalesce(p_password,'')='' then null else extensions.crypt(left(p_password,20),extensions.gen_salt('bf')) end,
  token,1,now(),now())
 on conflict(code) do update set name=excluded.name,mode_id=excluded.mode_id,level_id=excluded.level_id,
  red_size=excluded.red_size,blue_size=excluded.blue_size,ffa_size=excluded.ffa_size,respawn_time=excluded.respawn_time,
  friendly_fire=excluded.friendly_fire,password_hash=excluded.password_hash,host_token=excluded.host_token,
  players_count=excluded.players_count,created_at=excluded.created_at,last_active_at=excluded.last_active_at
 where game_rooms.last_active_at<=now()-interval '90 seconds';
 if not found then return jsonb_build_object('ok',false,'error','Já existe uma sala ativa com esse código.'); end if;
 room_json:=public.join_game_room(clean_code,coalesce(p_password,''));
 return jsonb_build_object('ok',true,'code',clean_code,'hostToken',token,'room',room_json);
end $$;

create or replace function public.touch_game_room(p_code text,p_host_token uuid,p_players_count integer) returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.game_rooms%rowtype; occupancy integer:=coalesce(p_players_count,0); capacity integer;
begin
 select * into r from public.game_rooms where code=p_code and host_token=p_host_token for update;
 if not found then return false; end if;
 if r.red_size not between 1 and 3 or r.blue_size not between 1 and 3 or r.ffa_size not between 2 and 6 then return false; end if;
 capacity:=case when r.mode_id='ffa' then r.ffa_size else r.red_size+r.blue_size end;
 if occupancy not between 0 and capacity then return false; end if;
 update public.game_rooms set players_count=occupancy,
  last_active_at=case when occupancy>0 then now() else now()-interval '10 minutes' end
 where code=r.code and host_token=p_host_token;
 return found;
end $$;

-- Keep the existing room API available to the older published frontend.
-- Table privileges/RLS and the shared host-token protocol remain in force.
revoke all on function public.list_game_rooms(),public.join_game_room(text,text),
 public.create_game_room(text,text,text,text,text,integer,integer,integer,integer,boolean),
 public.touch_game_room(text,uuid,integer) from public;
grant execute on function public.list_game_rooms(),public.join_game_room(text,text),
 public.create_game_room(text,text,text,text,text,integer,integer,integer,integer,boolean),
 public.touch_game_room(text,uuid,integer) to anon,authenticated;
notify pgrst,'reload schema';
commit;
