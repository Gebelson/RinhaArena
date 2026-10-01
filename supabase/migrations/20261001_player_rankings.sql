create table if not exists public.player_rankings (
  player_id uuid primary key,
  player_name text not null,
  points integer not null default 0 check (points >= 0),
  wins integer not null default 0 check (wins >= 0),
  matches integer not null default 0 check (matches >= 0),
  updated_at timestamptz not null default now()
);

alter table public.player_rankings enable row level security;
revoke all on public.player_rankings from anon, authenticated;

create or replace function public.submit_player_ranking(
  p_player_id uuid,
  p_name text,
  p_points integer,
  p_wins integer,
  p_matches integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or auth.uid() <> p_player_id then
    raise exception 'Jogador não autorizado a atualizar este ranking';
  end if;

  insert into public.player_rankings (player_id, player_name, points, wins, matches, updated_at)
  values (
    p_player_id,
    left(coalesce(nullif(trim(p_name), ''), 'Player'), 12),
    greatest(0, coalesce(p_points, 0)),
    greatest(0, coalesce(p_wins, 0)),
    greatest(0, coalesce(p_matches, 0)),
    now()
  )
  on conflict (player_id) do update set
    player_name = excluded.player_name,
    points = excluded.points,
    wins = excluded.wins,
    matches = excluded.matches,
    updated_at = now();
  return true;
end;
$$;

create or replace function public.list_player_rankings(p_limit integer default 100)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'playerId', ranked.player_id,
    'name', ranked.player_name,
    'points', ranked.points,
    'wins', ranked.wins,
    'matches', ranked.matches
  ) order by ranked.points desc, ranked.wins desc, ranked.updated_at asc), '[]'::jsonb)
  from (
    select * from public.player_rankings
    order by points desc, wins desc, updated_at asc
    limit greatest(1, least(100, coalesce(p_limit, 100)))
  ) ranked;
$$;

revoke all on function public.submit_player_ranking(uuid,text,integer,integer,integer) from public;
revoke all on function public.list_player_rankings(integer) from public;
grant execute on function public.submit_player_ranking(uuid,text,integer,integer,integer) to authenticated;
grant execute on function public.list_player_rankings(integer) to anon, authenticated;

notify pgrst, 'reload schema';
