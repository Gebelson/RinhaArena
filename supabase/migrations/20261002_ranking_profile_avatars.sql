create or replace function public.submit_player_ranking(
  p_player_id uuid, p_name text, p_avatar text, p_points integer,
  p_wins integer, p_losses integer, p_matches integer
)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null or auth.uid() <> p_player_id then raise exception 'Jogador não autorizado'; end if;
  insert into public.player_rankings(player_id,player_name,avatar,points,wins,losses,matches,updated_at)
  values(p_player_id,left(coalesce(nullif(trim(p_name),''),'Jogador'),12),
    case when p_avatar ~ '^avatar-([1-9]|10)[.]webp$' then p_avatar else 'avatar-1.webp' end,
    greatest(0,coalesce(p_points,0)),greatest(0,coalesce(p_wins,0)),greatest(0,coalesce(p_losses,0)),greatest(0,coalesce(p_matches,0)),now())
  on conflict(player_id) do update set player_name=excluded.player_name,avatar=excluded.avatar,
    points=excluded.points,wins=excluded.wins,losses=excluded.losses,matches=excluded.matches,updated_at=now();
  return true;
end $$;

create or replace function public.list_player_rankings(p_limit integer default 100)
returns jsonb language sql security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'playerId',r.player_id,'name',r.player_name,'avatar',coalesce(p.avatar,r.avatar),
    'points',r.points,'wins',r.wins,'losses',r.losses,'matches',r.matches
  ) order by r.points desc,r.wins desc,r.updated_at asc),'[]'::jsonb)
  from (select * from public.player_rankings order by points desc,wins desc,updated_at asc
    limit greatest(1,least(100,coalesce(p_limit,100)))) r
  left join public.player_profiles p on p.id=r.player_id;
$$;

grant execute on function public.submit_player_ranking(uuid,text,text,integer,integer,integer,integer) to authenticated;
grant execute on function public.list_player_rankings(integer) to anon,authenticated;
notify pgrst,'reload schema';
