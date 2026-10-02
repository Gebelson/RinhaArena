alter table public.player_profiles
  add column if not exists abandon_warnings integer not null default 0,
  add column if not exists matchmaking_blocked_until timestamptz,
  add column if not exists last_abandon_at timestamptz;

create table if not exists public.match_abandons (
  player_id uuid not null references auth.users(id) on delete cascade,
  match_id text not null,
  mode text not null,
  rank_penalty integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (player_id, match_id)
);
alter table public.match_abandons enable row level security;

create or replace function public.get_player_discipline()
returns jsonb language plpgsql security definer set search_path=public as $$
declare p public.player_profiles%rowtype;
begin
  select * into p from public.player_profiles where id=auth.uid();
  return jsonb_build_object(
    'abandonWarnings',coalesce(p.abandon_warnings,0),
    'matchmakingBlockedUntil',p.matchmaking_blocked_until,
    'lastAbandonAt',p.last_abandon_at,
    'serverTime',now()
  );
end $$;

create or replace function public.register_player_abandon(p_match_id text,p_mode text,p_rank_penalty integer default 0)
returns jsonb language plpgsql security definer set search_path=public as $$
declare inserted integer; warnings integer; blocked timestamptz; penalty integer:=0;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  penalty := case when p_mode='ranked' then round(20 * 4.0 / 3.0)::integer else 0 end;
  insert into public.match_abandons(player_id,match_id,mode,rank_penalty)
  values(auth.uid(),p_match_id,p_mode,penalty) on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted=0 then return public.get_player_discipline() || jsonb_build_object('duplicate',true,'rankPenalty',0); end if;
  if p_mode in ('normal','ranked') then
    update public.player_profiles set
      abandon_warnings=abandon_warnings+1,
      last_abandon_at=now(),
      matchmaking_blocked_until=case when abandon_warnings+1>=2 then now()+interval '5 minutes' else matchmaking_blocked_until end,
      rank_points=greatest(0,rank_points-penalty)
    where id=auth.uid()
    returning abandon_warnings,matchmaking_blocked_until into warnings,blocked;
  else
    select abandon_warnings,matchmaking_blocked_until into warnings,blocked from public.player_profiles where id=auth.uid();
  end if;
  return jsonb_build_object('abandonWarnings',warnings,'matchmakingBlockedUntil',blocked,'lastAbandonAt',now(),'serverTime',now(),'rankPenalty',penalty,'duplicate',false);
end $$;

grant execute on function public.get_player_discipline() to authenticated;
grant execute on function public.register_player_abandon(text,text,integer) to authenticated;
