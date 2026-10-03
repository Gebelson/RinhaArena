alter table public.player_profiles add column if not exists owned_characters text[] not null default array['capivara']::text[];
alter table public.player_profiles add column if not exists selected_character text not null default 'capivara';

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(), sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade, status text not null default 'pending' check(status in ('pending','accepted','declined')),
  created_at timestamptz not null default now(), unique(sender_id, receiver_id), check(sender_id <> receiver_id)
);
alter table public.friend_requests enable row level security;
create policy "participants read friend requests" on public.friend_requests for select to authenticated using(auth.uid() in (sender_id,receiver_id));

create table if not exists public.friendships (
  user_a uuid not null references auth.users(id) on delete cascade, user_b uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), primary key(user_a,user_b), check(user_a < user_b)
);
alter table public.friendships enable row level security;
create policy "members read friendships" on public.friendships for select to authenticated using(auth.uid() in (user_a,user_b));

create table if not exists public.character_trade_offers (
  id uuid primary key default gen_random_uuid(), sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade, offered_character text not null, requested_character text not null,
  status text not null default 'pending' check(status in ('pending','accepted','declined')), created_at timestamptz not null default now()
);
alter table public.character_trade_offers enable row level security;
create policy "participants read trades" on public.character_trade_offers for select to authenticated using(auth.uid() in (sender_id,receiver_id));

create or replace function public.are_friends(a uuid,b uuid) returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from friendships where user_a=least(a,b) and user_b=greatest(a,b));
$$;

create or replace function public.search_social_players(p_query text) returns table(id uuid,nickname text,avatar text,rank_points int)
language sql security definer set search_path=public as $$
  select p.id,p.nickname,p.avatar,p.rank_points from player_profiles p
  where p.id<>auth.uid() and (p.id::text=p_query or p.nickname ilike '%'||left(p_query,30)||'%') limit 12;
$$;

create or replace function public.send_friend_request(p_receiver uuid) returns void language plpgsql security definer set search_path=public as $$
begin
 if auth.uid() is null or p_receiver=auth.uid() then raise exception 'Solicitação inválida'; end if;
 if are_friends(auth.uid(),p_receiver) then raise exception 'Vocês já são amigos'; end if;
 insert into friend_requests(sender_id,receiver_id,status) values(auth.uid(),p_receiver,'pending')
 on conflict(sender_id,receiver_id) do update set status='pending',created_at=now();
end $$;

create or replace function public.respond_friend_request(p_request uuid,p_accept boolean) returns void language plpgsql security definer set search_path=public as $$
declare r friend_requests;
begin
 select * into r from friend_requests where id=p_request and receiver_id=auth.uid() and status='pending' for update;
 if not found then raise exception 'Solicitação não encontrada'; end if;
 update friend_requests set status=case when p_accept then 'accepted' else 'declined' end where id=p_request;
 if p_accept then insert into friendships(user_a,user_b) values(least(r.sender_id,r.receiver_id),greatest(r.sender_id,r.receiver_id)) on conflict do nothing; end if;
end $$;

create or replace function public.list_social_friends() returns table(id uuid,nickname text,avatar text,rank_points int,owned_characters text[])
language sql security definer set search_path=public as $$
 select p.id,p.nickname,p.avatar,p.rank_points,p.owned_characters from friendships f join player_profiles p on p.id=case when f.user_a=auth.uid() then f.user_b else f.user_a end where auth.uid() in(f.user_a,f.user_b);
$$;
create or replace function public.list_friend_requests() returns table(id uuid,sender_id uuid,nickname text,avatar text)
language sql security definer set search_path=public as $$ select r.id,r.sender_id,p.nickname,p.avatar from friend_requests r join player_profiles p on p.id=r.sender_id where r.receiver_id=auth.uid() and r.status='pending'; $$;

create or replace function public.gift_friend_resource(p_friend uuid,p_kind text,p_amount int) returns void language plpgsql security definer set search_path=public as $$
begin
 if p_amount<=0 or p_kind not in('gold','rank') or not are_friends(auth.uid(),p_friend) then raise exception 'Presente inválido'; end if;
 if p_kind='gold' then
  update player_profiles set gold=gold-p_amount where id=auth.uid() and gold>=p_amount; if not found then raise exception 'Gold insuficiente'; end if;
  update player_profiles set gold=gold+p_amount where id=p_friend;
 else
  update player_profiles set rank_points=rank_points-p_amount where id=auth.uid() and rank_points>=p_amount; if not found then raise exception 'Pontos insuficientes'; end if;
  update player_profiles set rank_points=rank_points+p_amount where id=p_friend;
 end if;
end $$;

create or replace function public.create_character_trade(p_friend uuid,p_offer text,p_request text) returns void language plpgsql security definer set search_path=public as $$
begin
 if not are_friends(auth.uid(),p_friend) then raise exception 'Usuário não é seu amigo'; end if;
 if p_offer='capivara' or p_request='capivara' then raise exception 'A Capivara não pode ser trocada'; end if;
 if not exists(select 1 from player_profiles where id=auth.uid() and p_offer=any(owned_characters)) then raise exception 'Você não possui esse personagem'; end if;
 if not exists(select 1 from player_profiles where id=p_friend and p_request=any(owned_characters)) then raise exception 'Seu amigo não possui esse personagem'; end if;
 insert into character_trade_offers(sender_id,receiver_id,offered_character,requested_character) values(auth.uid(),p_friend,p_offer,p_request);
end $$;

create or replace function public.respond_character_trade(p_trade uuid,p_accept boolean) returns void language plpgsql security definer set search_path=public as $$
declare t character_trade_offers;
begin
 select * into t from character_trade_offers where id=p_trade and receiver_id=auth.uid() and status='pending' for update;
 if not found then raise exception 'Troca não encontrada'; end if;
 if p_accept then
  if not exists(select 1 from player_profiles where id=t.sender_id and t.offered_character=any(owned_characters)) or not exists(select 1 from player_profiles where id=t.receiver_id and t.requested_character=any(owned_characters)) then raise exception 'Um personagem não está mais disponível'; end if;
  update player_profiles set owned_characters=array_append(array_remove(owned_characters,t.offered_character),t.requested_character),selected_character=case when selected_character=t.offered_character then 'capivara' else selected_character end where id=t.sender_id;
  update player_profiles set owned_characters=array_append(array_remove(owned_characters,t.requested_character),t.offered_character),selected_character=case when selected_character=t.requested_character then 'capivara' else selected_character end where id=t.receiver_id;
 end if;
 update character_trade_offers set status=case when p_accept then 'accepted' else 'declined' end where id=p_trade;
end $$;
create or replace function public.list_character_trades() returns table(id uuid,sender_id uuid,nickname text,offered_character text,requested_character text)
language sql security definer set search_path=public as $$ select t.id,t.sender_id,p.nickname,t.offered_character,t.requested_character from character_trade_offers t join player_profiles p on p.id=t.sender_id where t.receiver_id=auth.uid() and t.status='pending'; $$;

grant execute on function public.search_social_players(text),public.send_friend_request(uuid),public.respond_friend_request(uuid,boolean),public.list_social_friends(),public.list_friend_requests(),public.gift_friend_resource(uuid,text,int),public.create_character_trade(uuid,text,text),public.respond_character_trade(uuid,boolean),public.list_character_trades() to authenticated;
