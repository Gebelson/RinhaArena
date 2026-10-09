-- Standalone profile presentation for the existing, client-managed account schema.
-- Apply this file alone: it does not require the 20261006 economy/authority/social
-- migrations or 20261007_player_profile.sql. Existing account writes remain valid.
begin;

alter table public.player_profiles
 add column if not exists profile_bio text not null default '' check(char_length(profile_bio)<=160),
 add column if not exists profile_banner text not null default 'character' check(profile_banner in('character','ocean','sunset','forest')),
 add column if not exists history_public boolean not null default false;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('profile-avatars','profile-avatars',true,262144,array['image/webp'])
on conflict(id) do update set public=true,file_size_limit=262144,allowed_mime_types=array['image/webp'];

drop policy if exists profile_avatar_insert on storage.objects;
create policy profile_avatar_insert on storage.objects for insert to authenticated with check(
 bucket_id='profile-avatars' and owner_id=(select auth.uid())::text
 and split_part(name,'/',1)=(select auth.uid())::text
 and name~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$'
);
drop policy if exists profile_avatar_read on storage.objects;
create policy profile_avatar_read on storage.objects for select to authenticated using(
 bucket_id='profile-avatars' and owner_id=(select auth.uid())::text and split_part(name,'/',1)=(select auth.uid())::text
);
drop policy if exists profile_avatar_delete on storage.objects;
create policy profile_avatar_delete on storage.objects for delete to authenticated using(
 bucket_id='profile-avatars' and owner_id=(select auth.uid())::text and split_part(name,'/',1)=(select auth.uid())::text
 and not exists(select 1 from public.player_profiles p where p.id=(select auth.uid()) and p.avatar='uploaded:'||name)
);
-- No object UPDATE policy: every upload gets an immutable UUID filename.

-- The legacy table grants include future columns. Guard only the added fields,
-- using the effective SQL role (the definer RPC executes as its trusted owner).
-- Invoker security is essential here: a definer trigger would erase that distinction.
create or replace function public.guard_compatible_profile_presentation() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
declare presentation_changed boolean;
begin
 if tg_op='INSERT' then
  presentation_changed:=new.profile_bio is distinct from '' or new.profile_banner is distinct from 'character' or new.history_public is distinct from false;
 else
  presentation_changed:=new.profile_bio is distinct from old.profile_bio or new.profile_banner is distinct from old.profile_banner or new.history_public is distinct from old.history_public;
 end if;
 if presentation_changed and current_user in('anon','authenticated') then
  raise exception 'Use update_player_presentation para editar a apresentação';
 end if;
 -- Built-in avatars and unchanged legacy values stay compatible. Newly assigned
 -- uploaded images must exist and belong to the profile even on a legacy PATCH.
 if new.avatar like 'uploaded:%' and (tg_op='INSERT' or new.avatar is distinct from old.avatar) then
  if new.avatar!~'^uploaded:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$'
   or split_part(substring(new.avatar from 10),'/',1)<>new.id::text
   or not exists(select 1 from storage.objects o where o.bucket_id='profile-avatars' and o.name=substring(new.avatar from 10) and o.owner_id=new.id::text)
  then raise exception 'Avatar inválido ou foto não encontrada'; end if;
 end if;
 return new;
end $$;
drop trigger if exists compatible_profile_presentation_guard on public.player_profiles;
create trigger compatible_profile_presentation_guard before insert or update on public.player_profiles
for each row execute function public.guard_compatible_profile_presentation();

create or replace function public.get_player_profile(p_player_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare p public.player_profiles%rowtype; result jsonb; blocked boolean:=false; earned_xp bigint; n_matches bigint; n_wins bigint; n_losses bigint;
begin
 if auth.uid() is null then raise exception 'Entre na sua conta para continuar'; end if;
 if p_player_id is null then return null; end if;
 if p_player_id<>auth.uid() then
  if to_regprocedure('public.players_blocked(uuid,uuid)') is not null then
   execute 'select public.players_blocked($1,$2)' into blocked using auth.uid(),p_player_id;
  elsif to_regclass('public.blocked_players') is not null then
   execute 'select exists(select 1 from public.blocked_players where (player_id=$1 and blocked_id=$2) or (player_id=$2 and blocked_id=$1))' into blocked using auth.uid(),p_player_id;
  end if;
  if blocked then return null; end if;
 end if;
 select * into p from public.player_profiles where id=p_player_id;
 if not found then return null; end if;
 result:=to_jsonb(p);
 -- Same level XP calculation as the legacy frontend. Do not create or reset an
 -- experience_points column; retain actual stored XP when the schema has one.
 n_matches:=greatest(0,p.matches::bigint); n_wins:=least(n_matches,greatest(0,p.wins::bigint));
 n_losses:=least(n_matches-n_wins,greatest(0,p.losses::bigint));
 earned_xp:=n_wins*100+(n_matches-n_wins-n_losses)*60+n_losses*40;
 if jsonb_typeof(result->'experience_points') is distinct from 'number' then
  result:=result||jsonb_build_object('experience_points',earned_xp);
 end if;
 if p_player_id=auth.uid() then return result; end if;
 -- Public presentation excludes balances, inventories, missions and discipline.
 return jsonb_build_object('id',p.id,'nickname',p.nickname,'avatar',p.avatar,
  'rank_points',p.rank_points,'experience_points',result->'experience_points',
  'matches',p.matches,'wins',p.wins,'losses',p.losses,'selected_character',p.selected_character,
  'profile_bio',p.profile_bio,'profile_banner',p.profile_banner,'history_public',p.history_public);
end $$;

create or replace function public.update_player_presentation(
 p_nickname text,p_avatar text,p_bio text,p_banner text,p_character_id text,p_history_public boolean
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.player_profiles%rowtype;
begin
 if auth.uid() is null then raise exception 'Entre na sua conta para continuar'; end if;
 -- Match browser String.trim(), including Unicode whitespace.
 p_nickname:=btrim(p_nickname,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
 if p_nickname is null or char_length(p_nickname) not between 2 and 12
  or p_nickname~*'^player(\s*\d+)?$' or p_nickname~*'^(unknown|guest)$' then raise exception 'Nome inválido'; end if;
 if p_bio is null or char_length(p_bio)>160 then raise exception 'Biografia inválida'; end if;
 if p_banner is null or p_banner not in('character','ocean','sunset','forest') then raise exception 'Capa inválida'; end if;
 if p_character_id is null or p_character_id not in('capivara','cachorro','crocodilo','gato','macaco','pato','porco')
  or p_history_public is null or p_avatar is null then raise exception 'Perfil inválido'; end if;
 select * into p from public.player_profiles where id=auth.uid() for update;
 if not found then raise exception 'Perfil não encontrado'; end if;
 if not coalesce(p_character_id=any(p.owned_characters),false) then raise exception 'Personagem não adquirido'; end if;
 if p_avatar!~'^avatar-([1-9]|10)[.]webp$' then
  if p_avatar!~'^uploaded:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$'
   or split_part(substring(p_avatar from 10),'/',1)<>p.id::text
   or not exists(select 1 from storage.objects o where o.bucket_id='profile-avatars' and o.name=substring(p_avatar from 10) and o.owner_id=p.id::text)
  then raise exception 'Avatar inválido ou foto não encontrada'; end if;
 end if;
 update public.player_profiles set nickname=p_nickname,avatar=p_avatar,profile_bio=p_bio,profile_banner=p_banner,
  selected_character=p_character_id,history_public=p_history_public,updated_at=now() where id=auth.uid();
 -- Synchronize only presentation in the existing ranking; totals remain untouched.
 if to_regclass('public.player_rankings') is not null then
  execute 'update public.player_rankings set player_name=$1,avatar=$2 where player_id=$3' using p_nickname,p_avatar,p.id;
 end if;
 return public.get_player_profile(p.id);
end $$;

-- A private journal of newly completed client games. These are player-reported
-- observations, not authority receipts; there are deliberately no reward columns.
create table if not exists public.profile_match_history(
 player_id uuid not null references auth.users(id) on delete cascade,
 match_id text not null,
 round integer not null check(round between 1 and 1000),
 mode_id text not null,
 map_id text not null,
 ranked boolean not null,
 outcome text not null check(outcome in('win','loss','draw')),
 stats jsonb not null default '{}',
 summary jsonb not null default '{}',
 created_at timestamptz not null default now(),
 primary key(player_id,match_id)
);
create index if not exists profile_match_history_recent on public.profile_match_history(player_id,created_at desc);
alter table public.profile_match_history enable row level security;
revoke all on public.profile_match_history from anon,authenticated;
grant select on public.profile_match_history to authenticated;
drop policy if exists profile_history_owner_read on public.profile_match_history;
create policy profile_history_owner_read on public.profile_match_history for select to authenticated using(player_id=(select auth.uid()));

create or replace function public.record_player_match_history(
 p_match_id text,p_round integer,p_mode_id text,p_map_id text,p_ranked boolean,p_outcome text,
 p_stats jsonb,p_summary jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare safe_stats jsonb; safe_summary jsonb; r public.profile_match_history%rowtype;
begin
 if auth.uid() is null then raise exception 'Entre na sua conta para continuar'; end if;
 if p_match_id is null or p_match_id!~'^[A-Za-z0-9._:-]{1,160}$'
  or p_round is null or p_round not between 1 and 1000
  or p_mode_id is null or p_mode_id not in('ctf','dm','deathmatch','ffa')
  or p_map_id is null or p_map_id!~'^(foundry|dojo|skyhaven|feira_suspensa|procedural(:[A-Za-z0-9_-]{1,60})?)$'
  or p_ranked is null or p_outcome is null or p_outcome not in('win','loss','draw') then raise exception 'Partida inválida'; end if;
 if jsonb_typeof(p_stats) is distinct from 'object' or jsonb_typeof(p_summary) is distinct from 'object' then raise exception 'Estatísticas inválidas'; end if;
 if exists(select 1 from jsonb_each(p_stats) where key in('eliminations','deaths','captures','returns')
  and (jsonb_typeof(value)<>'number' or value::text!~'^[0-9]{1,6}$')) then raise exception 'Estatísticas inválidas'; end if;
 if exists(select 1 from jsonb_each(case when jsonb_typeof(p_summary->'scores')='object' then p_summary->'scores' else '{}' end)
  where key in('red','blue') and (jsonb_typeof(value)<>'number' or value::text!~'^[0-9]{1,6}$')) then raise exception 'Placar inválido'; end if;
 if p_summary ? 'capacity' and (jsonb_typeof(p_summary->'capacity')<>'number'
  or (p_summary->>'capacity')!~'^[1-6]$') then raise exception 'Capacidade inválida'; end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into safe_stats from jsonb_each(p_stats) where key in('eliminations','deaths','captures','returns');
 safe_summary:=jsonb_strip_nulls(jsonb_build_object(
  'winner',case when p_summary->>'winner' in('red','blue','draw') then p_summary->'winner' end,
  'team',case when p_summary->>'team' in('red','blue','free') then p_summary->'team' end,
  'capacity',p_summary->'capacity',
  'scores',nullif(jsonb_strip_nulls(jsonb_build_object(
   'red',p_summary#>'{scores,red}','blue',p_summary#>'{scores,blue}')), '{}')));
 insert into public.profile_match_history(player_id,match_id,round,mode_id,map_id,ranked,outcome,stats,summary)
 values(auth.uid(),p_match_id||':round:'||p_round::text,p_round,p_mode_id,p_map_id,p_ranked,p_outcome,safe_stats,safe_summary)
 on conflict(player_id,match_id) do nothing;
 select * into r from public.profile_match_history where player_id=auth.uid() and match_id=p_match_id||':round:'||p_round::text;
 return (to_jsonb(r)-'player_id')||jsonb_build_object('source','profile_match_history','recorded',true,'trusted',false);
end $$;

create or replace function public.get_player_match_history(p_player_id uuid,p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb:='[]'; sharing boolean; blocked boolean:=false; raw jsonb; item jsonb; safe_stats jsonb; safe_summary jsonb; owner_view boolean; outcome_key text; source_sql text;
begin
 if auth.uid() is null then raise exception 'Entre na sua conta para continuar'; end if;
 if p_player_id is null then return null; end if;
 owner_view:=p_player_id=auth.uid();
 if not owner_view then
  if to_regprocedure('public.players_blocked(uuid,uuid)') is not null then
   execute 'select public.players_blocked($1,$2)' into blocked using auth.uid(),p_player_id;
  elsif to_regclass('public.blocked_players') is not null then
   execute 'select exists(select 1 from public.blocked_players where (player_id=$1 and blocked_id=$2) or (player_id=$2 and blocked_id=$1))' into blocked using auth.uid(),p_player_id;
  end if;
  if blocked then return null; end if;
 end if;
 select history_public into sharing from public.player_profiles where id=p_player_id;
 if not found or(not owner_view and not sharing) then return null; end if;
 source_sql:='select to_jsonb(r)||jsonb_build_object(''profile_history_source'',''profile_match_history'') as raw from public.profile_match_history r where r.player_id::text=$1';
 -- Preserve readable existing results when that optional table has enough data.
 -- An absent/inadequate legacy source is never backfilled with invented matches.
 if to_regclass('public.match_results') is not null then
  if exists(select 1 from pg_attribute where attrelid='public.match_results'::regclass and attname='player_id' and not attisdropped)
   and exists(select 1 from pg_attribute where attrelid='public.match_results'::regclass and attname='created_at' and not attisdropped) then
   select attname into outcome_key from pg_attribute where attrelid='public.match_results'::regclass
    and attname in('outcome','result') and not attisdropped order by case attname when 'outcome' then 0 else 1 end limit 1;
   if outcome_key is not null then
    source_sql:=source_sql||' union all select to_jsonb(r)||jsonb_build_object(''profile_history_source'',''match_results'',''outcome'',to_jsonb(r)->$3) as raw from public.match_results r where r.player_id::text=$1 and to_jsonb(r)->>$3 in(''win'',''loss'',''draw'')';
   end if;
  end if;
 end if;
 for raw in execute 'select raw from ('||source_sql||') q order by raw->>''created_at'' desc nulls last,raw->>''match_id'' limit $2'
  using p_player_id::text,greatest(1,least(50,coalesce(p_limit,50))),outcome_key
 loop
  select jsonb_object_agg(key,value) into safe_stats from jsonb_each(case when jsonb_typeof(raw->'stats')='object' then raw->'stats' else '{}' end)
   where key in('eliminations','deaths','captures','returns') and jsonb_typeof(value)='number';
  safe_summary:=jsonb_strip_nulls(jsonb_build_object(
   'winner',case when raw#>>'{summary,winner}' in('red','blue','draw') then raw#>'{summary,winner}' end,
   'team',case when raw#>>'{summary,team}' in('red','blue','free') then raw#>'{summary,team}' end,
   'scores',nullif(jsonb_strip_nulls(jsonb_build_object(
    'red',case when jsonb_typeof(raw#>'{summary,scores,red}')='number' then raw#>'{summary,scores,red}' end,
    'blue',case when jsonb_typeof(raw#>'{summary,scores,blue}')='number' then raw#>'{summary,scores,blue}' end)),'{}')));
  item:=jsonb_strip_nulls(jsonb_build_object('source',raw->'profile_history_source','recorded',true,'trusted',false,
   'outcome',raw->'outcome','created_at',raw->'created_at',
   'mode_id',case when jsonb_typeof(raw->'mode_id')='string' then raw->'mode_id' end,
   'map_id',case when jsonb_typeof(raw->'map_id')='string' then raw->'map_id' end,
   'ranked',case when jsonb_typeof(raw->'ranked')='boolean' then raw->'ranked' end,
   'stats',safe_stats,'summary',nullif(safe_summary,'{}')));
  if owner_view then
   item:=item||jsonb_strip_nulls(jsonb_build_object('match_id',raw->'match_id',
    'gold',case when jsonb_typeof(raw->'gold')='number' then raw->'gold' end,
    'xp',case when jsonb_typeof(raw->'xp')='number' then raw->'xp' end,
    'rank_delta',case when jsonb_typeof(raw->'rank_delta')='number' then raw->'rank_delta' end));
  end if;
  result:=result||jsonb_build_array(item);
 end loop;
 return result;
end $$;

revoke all on function public.guard_compatible_profile_presentation() from public,anon,authenticated;
revoke all on function public.get_player_profile(uuid),public.get_player_match_history(uuid,int),
 public.update_player_presentation(text,text,text,text,text,boolean),
 public.record_player_match_history(text,integer,text,text,boolean,text,jsonb,jsonb) from public,anon;
grant execute on function public.get_player_profile(uuid),public.get_player_match_history(uuid,int),
 public.update_player_presentation(text,text,text,text,text,boolean),
 public.record_player_match_history(text,integer,text,text,boolean,text,jsonb,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
