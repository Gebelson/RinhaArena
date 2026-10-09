-- Private friend chat for the hosted legacy friendships(user_a,user_b) schema.
-- Run independently after 20261003_social_friends_and_trades.sql.
begin;

create table if not exists public.friend_messages (
 id uuid primary key default gen_random_uuid(),
 sender_id uuid not null references auth.users(id) on delete cascade,
 recipient_id uuid not null references auth.users(id) on delete cascade,
 body text not null check(char_length(body) between 1 and 1000 and body = btrim(body, E' \t\r\n')),
 client_nonce uuid not null,
 created_at timestamptz not null default now(),
 read_at timestamptz,
 constraint friend_messages_distinct_participants check(sender_id <> recipient_id),
 constraint friend_messages_sender_nonce_key unique(sender_id,client_nonce)
);

create index if not exists friend_messages_conversation_history
 on public.friend_messages(least(sender_id,recipient_id),greatest(sender_id,recipient_id),created_at desc,id desc);
create index if not exists friend_messages_sender_rate
 on public.friend_messages(sender_id,created_at desc);
create index if not exists friend_messages_incoming_unread
 on public.friend_messages(recipient_id,sender_id) where read_at is null;

-- Keep legacy deployments working and honor optional social protection when
-- installed later. The caller guard prevents probing other players' pairs.
create or replace function public.friend_chat_allowed(a uuid,b uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog as $$
declare caller uuid := auth.uid(); blocked boolean := false;
begin
 if caller is null or a is null or b is null or a=b or caller not in(a,b) then return false; end if;
 if not public.are_friends(a,b) then return false; end if;
 if to_regprocedure('public.players_blocked(uuid,uuid)') is not null then
  execute 'select public.players_blocked($1,$2)' into blocked using a,b;
 elsif to_regclass('public.blocked_players') is not null then
  execute 'select exists(select 1 from public.blocked_players where (player_id=$1 and blocked_id=$2) or (player_id=$2 and blocked_id=$1))'
   into blocked using a,b;
 end if;
 return not coalesce(blocked,true);
end $$;

alter table public.friend_messages enable row level security;
revoke all on public.friend_messages from public,anon,authenticated;
grant select on public.friend_messages to authenticated;
drop policy if exists friend_messages_participant_read on public.friend_messages;
create policy friend_messages_participant_read on public.friend_messages
 for select to authenticated using(
  (select auth.uid()) in (sender_id,recipient_id)
  and public.friend_chat_allowed(sender_id,recipient_id)
 );

create or replace function public.send_friend_message(p_friend uuid,p_body text,p_client_nonce uuid)
returns public.friend_messages language plpgsql security definer set search_path=pg_catalog as $$
declare
 caller uuid := auth.uid();
 clean_body text;
 sent_at timestamptz;
 message public.friend_messages;
begin
 if caller is null then raise exception 'Entre na sua conta para continuar'; end if;
 if p_friend is null or p_friend=caller then raise exception 'Amigo inválido'; end if;
 if p_client_nonce is null or p_body is null or char_length(p_body)>1000 then raise exception 'Mensagem inválida'; end if;
 clean_body := btrim(p_body,E' \t\r\n');
 if char_length(clean_body)=0 then raise exception 'Mensagem inválida'; end if;

 -- The lock spans all conversations and duplicate retries by this sender.
 perform pg_advisory_xact_lock(hashtextextended('friend-chat:'||caller::text,0));
 -- Keep the existing friendship until this transaction finishes.
 perform 1 from public.friendships
  where user_a=least(caller,p_friend) and user_b=greatest(caller,p_friend)
  for key share;
 if not found or not public.friend_chat_allowed(caller,p_friend) then raise exception 'Usuário não é seu amigo'; end if;

 select * into message from public.friend_messages
  where sender_id=caller and client_nonce=p_client_nonce and public.friend_chat_allowed(caller,p_friend);
 if found then
  if message.recipient_id<>p_friend or message.body<>clean_body then
   raise exception 'Identificador da mensagem já utilizado';
  end if;
  return message;
 end if;

 sent_at := clock_timestamp();
 if (select count(*) from public.friend_messages where sender_id=caller and created_at>sent_at-interval '1 minute')>=30 then
  raise exception 'Muitas mensagens. Aguarde um minuto antes de enviar novamente';
 end if;
 insert into public.friend_messages(sender_id,recipient_id,body,client_nonce,created_at)
  select caller,p_friend,clean_body,p_client_nonce,sent_at
   where public.friend_chat_allowed(caller,p_friend) returning * into message;
 if not found then raise exception 'Usuário não é seu amigo'; end if;
 return message;
end $$;

create or replace function public.get_friend_messages(
 p_friend uuid,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 40
)
returns setof public.friend_messages language plpgsql security definer set search_path=pg_catalog as $$
declare caller uuid := auth.uid();
begin
 if caller is null then raise exception 'Entre na sua conta para continuar'; end if;
 if p_friend is null or p_friend=caller or not public.friend_chat_allowed(caller,p_friend) then
  raise exception 'Usuário não é seu amigo';
 end if;
 if (p_before is null)<>(p_before_id is null) then raise exception 'Cursor da conversa inválido'; end if;
 return query
  select page.* from (
   select m.* from public.friend_messages m
    where least(m.sender_id,m.recipient_id)=least(caller,p_friend)
     and greatest(m.sender_id,m.recipient_id)=greatest(caller,p_friend)
     and public.friend_chat_allowed(caller,p_friend)
     and (p_before is null or (m.created_at,m.id)<(p_before,p_before_id))
    order by m.created_at desc,m.id desc
    limit greatest(1,least(coalesce(p_limit,40),100))
  ) page order by page.created_at,page.id;
end $$;

create or replace function public.mark_friend_messages_read(p_friend uuid)
returns bigint language plpgsql security definer set search_path=pg_catalog as $$
declare caller uuid := auth.uid(); changed bigint;
begin
 if caller is null then raise exception 'Entre na sua conta para continuar'; end if;
 if p_friend is null or p_friend=caller or not public.friend_chat_allowed(caller,p_friend) then
  raise exception 'Usuário não é seu amigo';
 end if;
 update public.friend_messages set read_at=clock_timestamp()
  where sender_id=p_friend and recipient_id=caller and read_at is null
   and public.friend_chat_allowed(caller,p_friend);
 get diagnostics changed=row_count;
 return changed;
end $$;

create or replace function public.list_friend_chat_unread()
returns table(friend_id uuid,unread_count bigint) language plpgsql security definer set search_path=pg_catalog as $$
declare caller uuid := auth.uid();
begin
 if caller is null then raise exception 'Entre na sua conta para continuar'; end if;
 return query select m.sender_id,count(*) from public.friend_messages m
  where m.recipient_id=caller and m.read_at is null and public.friend_chat_allowed(caller,m.sender_id)
  group by m.sender_id order by m.sender_id;
end $$;

revoke all on function public.friend_chat_allowed(uuid,uuid),public.send_friend_message(uuid,text,uuid),
 public.get_friend_messages(uuid,timestamptz,uuid,integer),
 public.mark_friend_messages_read(uuid),public.list_friend_chat_unread() from public,anon,authenticated;
grant execute on function public.friend_chat_allowed(uuid,uuid),public.send_friend_message(uuid,text,uuid),
 public.get_friend_messages(uuid,timestamptz,uuid,integer),
 public.mark_friend_messages_read(uuid),public.list_friend_chat_unread() to authenticated;

-- Supabase Postgres Changes evaluates each subscriber's JWT through table RLS.
-- Keep installations without Realtime working and make repeated runs harmless.
do $$
begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime' and not puballtables)
  and not exists(select 1 from pg_publication_rel r join pg_publication p on p.oid=r.prpubid
   where p.pubname='supabase_realtime' and r.prrelid='public.friend_messages'::regclass) then
  alter publication supabase_realtime add table public.friend_messages;
 end if;
end $$;

notify pgrst,'reload schema';
commit;
