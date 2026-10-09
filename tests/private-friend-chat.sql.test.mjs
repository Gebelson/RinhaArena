import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const ALICE = 'a0000000-0000-4000-8000-000000000001';
const BOB = 'b0000000-0000-4000-8000-000000000002';
const CAROL = 'c0000000-0000-4000-8000-000000000003';
const DAN = 'd0000000-0000-4000-8000-000000000004';
const migration = await readFile(new URL('../supabase/migrations/20261009_private_friend_chat.sql', import.meta.url), 'utf8');
const social = await readFile(new URL('../supabase/migrations/20261003_social_friends_and_trades.sql', import.meta.url), 'utf8');
const fixture = await readFile(new URL('./profile-compatible-fixture.sql', import.meta.url), 'utf8');

test('private friend chat works with hosted legacy friendships and protects every entry point', async t => {
 const db = new PGlite();
 const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
 const as = async (role, id, run) => {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
  await db.exec(`set role ${role}`);
  try { return await run(); } finally { await db.exec('reset role'); }
 };
 const send = async (friend, body = 'Oi!', nonce = randomUUID()) =>
  (await db.query('select * from public.send_friend_message($1,$2,$3)', [friend,body,nonce])).rows[0];
 const history = async (friend, before = null, beforeId = null, limit = 40) =>
  (await db.query('select * from public.get_friend_messages($1,$2,$3,$4)', [friend,before,beforeId,limit])).rows;
 const markRead = friend => scalar('select public.mark_friend_messages_read($1)', [friend]);
 const allowed = (a,b) => scalar('select public.friend_chat_allowed($1,$2)', [a,b]);
 const unread = async () => (await db.query('select * from public.list_friend_chat_unread()')).rows
  .map(row => ({ friend_id:row.friend_id,unread_count:Number(row.unread_count) }));
 const messages = async () => (await db.query('select * from public.friend_messages order by created_at,id')).rows;
 let outgoing;
 try {
  await db.exec(fixture);
  await db.exec(social);
  for (const [id,name] of [[ALICE,'Alice'],[BOB,'Bob'],[CAROL,'Carol'],[DAN,'Dan']]) {
   await db.query('insert into auth.users(id) values($1)', [id]);
   await db.query('insert into public.player_profiles(id,nickname,gold,rank_points) values($1,$2,175,29)', [id,name]);
  }
  for (const [a,b] of [[ALICE,BOB],[ALICE,CAROL],[BOB,DAN],[CAROL,DAN]]) {
   await db.query('insert into public.friendships(user_a,user_b) values($1,$2)', [a,b]);
  }
  const accountsBefore = await scalar('select jsonb_agg(to_jsonb(p) order by id) from public.player_profiles p');
  // Hosted schemas can grant CRUD by default. The migration must revoke it.
  await db.exec('alter default privileges in schema public grant all on tables to anon,authenticated');
  await db.exec('alter default privileges in schema public grant execute on functions to anon,authenticated');
  await db.exec(migration);

  await t.test('migration is standalone, repeatable, and only extends the chat surface', async () => {
   await db.exec(migration);
   assert.equal(await scalar("select count(*)::int from pg_publication where pubname='supabase_realtime'"),0);
   assert.deepEqual(await scalar('select jsonb_agg(to_jsonb(p) order by id) from public.player_profiles p'),accountsBefore);
   assert.equal(await scalar('select count(*)::int from public.friendships'),4);
   const functions = (await db.query("select proname,prosecdef,proconfig from pg_proc where pronamespace='public'::regnamespace and proname in('friend_chat_allowed','send_friend_message','get_friend_messages','mark_friend_messages_read','list_friend_chat_unread')")).rows;
   assert.equal(functions.length,5);
   for (const fn of functions) {
    assert.equal(fn.prosecdef,true);
    assert.deepEqual(fn.proconfig,['search_path=pg_catalog']);
   }
   assert.equal(await scalar("select relrowsecurity from pg_class where oid='public.friend_messages'::regclass"),true);
   for (const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE']) {
    for (const role of ['anon','authenticated']) assert.equal(await scalar('select has_table_privilege($1,$2,$3)',[role,'public.friend_messages',privilege]),false);
   }
   assert.equal(await scalar("select to_regprocedure('public.players_blocked(uuid,uuid)')"),null);
   assert.equal(await scalar("select to_regclass('public.blocked_players')"),null);
  });

  await t.test('every RPC requires authenticated JWT identity, and anonymous table reads fail', async () => {
   for (const role of ['anon','authenticated']) await as(role,null,async () => {
    const error = role==='anon' ? /permission denied/ : /Entre na sua conta/;
    await assert.rejects(send(BOB),error);
    await assert.rejects(history(BOB),error);
    await assert.rejects(markRead(BOB),error);
    await assert.rejects(unread(),error);
   });
   await as('anon',ALICE,() => assert.rejects(messages(),/permission denied/));
   await as('anon',ALICE,() => assert.rejects(allowed(ALICE,BOB),/permission denied/));
   assert.equal(await as('authenticated',null,() => allowed(ALICE,BOB)),false);
   await as('authenticated',null,async () => assert.deepEqual(await messages(),[]));
  });

  await t.test('chat access helper cannot probe a pair unless the authenticated caller participates', async () => {
   await as('authenticated',ALICE,async () => {
    assert.equal(await allowed(ALICE,BOB),true);
    assert.equal(await allowed(BOB,ALICE),true);
    for (const pair of [[BOB,DAN],[ALICE,DAN],[ALICE,ALICE],[null,BOB],[ALICE,null]]) assert.equal(await allowed(...pair),false);
   });
   assert.equal(await as('authenticated',CAROL,() => allowed(ALICE,BOB)),false);
  });

  await t.test('send validates body, friendship, and nonce and derives the sender from auth.uid()', async () => {
   await as('authenticated',ALICE,async () => {
    for (const friend of [null,ALICE,DAN]) await assert.rejects(send(friend),/Amigo inválido|não é seu amigo/);
    for (const body of [null,'','   ','\t\r\n','x'.repeat(1001)]) await assert.rejects(send(BOB,body),/Mensagem inválida/);
    await assert.rejects(send(BOB,'Oi',null),/Mensagem inválida/);
    outgoing = await send(BOB,' \tOi, Bob!\r\n');
    assert.equal(outgoing.sender_id,ALICE);
    assert.equal(outgoing.recipient_id,BOB);
    assert.equal(outgoing.body,'Oi, Bob!');
    assert.equal(outgoing.read_at,null);
    assert.ok(outgoing.id && outgoing.client_nonce && outgoing.created_at);
    const maximum = await send(BOB,'x'.repeat(1000));
    assert.equal(maximum.body.length,1000);
    await assert.rejects(db.query('select public.send_friend_message($1,$2,$3,$4)',[BOB,'Spoof',randomUUID(),CAROL]),/does not exist/);
   });
   assert.equal(await scalar('select count(*)::int from public.friend_messages'),2);
   await as('authenticated',null,async () => assert.deepEqual(await messages(),[]));
  });

  await t.test('direct writes cannot spoof senders, edit bodies, mark reads, or delete chat', async () => {
   for (const role of ['anon','authenticated']) await as(role,ALICE,async () => {
    await assert.rejects(db.query('insert into public.friend_messages(sender_id,recipient_id,body,client_nonce) values($1,$2,$3,$4)',[BOB,CAROL,'Forged',randomUUID()]),/permission denied/);
    await assert.rejects(db.query("update public.friend_messages set sender_id=$1,body='Edited' where id=$2",[CAROL,outgoing.id]),/permission denied/);
    await assert.rejects(db.query('update public.friend_messages set read_at=now() where id=$1',[outgoing.id]),/permission denied/);
    await assert.rejects(db.query('delete from public.friend_messages where id=$1',[outgoing.id]),/permission denied/);
    await assert.rejects(db.exec('truncate public.friend_messages'),/permission denied/);
   });
   assert.equal((await messages()).find(m => m.id===outgoing.id).body,'Oi, Bob!');
  });

  await t.test('a nonce retry returns the same row and cannot be reused for another body or friend', async () => {
   await as('authenticated',ALICE,async () => {
    assert.deepEqual(await send(BOB,'Oi, Bob!',outgoing.client_nonce),outgoing);
    assert.deepEqual(await send(BOB,'  Oi, Bob!  ',outgoing.client_nonce),outgoing);
    await assert.rejects(send(BOB,'Changed',outgoing.client_nonce),/já utilizado/);
    await assert.rejects(send(CAROL,'Oi, Bob!',outgoing.client_nonce),/já utilizado/);
   });
   const reply = await as('authenticated',BOB,() => send(ALICE,'Oi, Alice!',outgoing.client_nonce));
   assert.equal(reply.sender_id,BOB);
   assert.notEqual(reply.id,outgoing.id);
   assert.equal(await scalar('select count(*)::int from public.friend_messages where sender_id=$1 and client_nonce=$2',[ALICE,outgoing.client_nonce]),1);
  });

  await t.test('RLS and history exclude outsiders even when they are friends of a participant', async () => {
   const own = await as('authenticated',ALICE,() => send(CAROL,'Conversa com Carol'));
   await as('authenticated',BOB,async () => {
    const visible = await messages();
    assert.ok(visible.some(m => m.id===outgoing.id));
    assert.equal(visible.some(m => m.id===own.id),false);
    assert.ok((await history(ALICE)).every(m => m.sender_id===BOB || m.recipient_id===BOB));
    await assert.rejects(history(CAROL),/não é seu amigo/);
    await assert.rejects(markRead(CAROL),/não é seu amigo/);
   });
   await as('authenticated',CAROL,async () => {
    assert.deepEqual((await messages()).map(m => m.id),[own.id]);
    assert.deepEqual((await history(ALICE)).map(m => m.id),[own.id]);
    assert.deepEqual(await history(DAN),[]);
   });
  });

  await t.test('history returns the chronological last page and tuple cursors preserve timestamp ties', async () => {
   const tied = [];
   for (let n=1;n<=105;n++) {
    const id = `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    tied.push(id);
    await db.query("insert into public.friend_messages(id,sender_id,recipient_id,body,client_nonce,created_at) values($1,$2,$3,$4,$5,'2026-09-01T00:00:00Z')",[id,ALICE,BOB,`Old ${n}`,randomUUID()]);
   }
   await as('authenticated',ALICE,async () => {
    const all = await history(BOB);
    assert.equal(all.length,40);
    assert.deepEqual(all.map(m => m.id),(await history(BOB,null,null,40)).map(m => m.id));
    assert.equal((await history(BOB,null,null,10000)).length,100);
    assert.equal((await history(BOB,null,null,-10)).length,1);
    assert.equal((await history(BOB,null,null,0)).length,1);
    assert.equal((await history(BOB,null,null,null)).length,40);
    const page = await history(BOB,'2026-09-01T00:00:00Z',tied[104],5);
    assert.deepEqual(page.map(m => m.id),tied.slice(99,104));
    const older = await history(BOB,page[0].created_at,page[0].id,5);
    assert.deepEqual(older.map(m => m.id),tied.slice(94,99));
    assert.equal(new Set([...older,...page].map(m => m.id)).size,10);
    assert.ok(all.every((m,i) => i===0 || m.created_at>=all[i-1].created_at));
    await assert.rejects(history(BOB,'2026-09-01T00:00:00Z'),/Cursor.*inválido/);
    await assert.rejects(history(BOB,null,tied[0]),/Cursor.*inválido/);
   });
  });

  await t.test('read receipts belong to the recipient and unread totals only contain incoming messages', async () => {
   const aliceBefore = await as('authenticated',ALICE,() => unread());
   assert.deepEqual(aliceBefore,[{ friend_id:BOB,unread_count:1 }]);
   const bobBefore = await as('authenticated',BOB,() => unread());
   assert.deepEqual(bobBefore,[{ friend_id:ALICE,unread_count:107 }]);
   await as('authenticated',ALICE,async () => {
    assert.equal(Number(await markRead(BOB)),1);
    assert.equal(Number(await markRead(BOB)),0);
    assert.deepEqual(await unread(),[]);
   });
   let after = await messages();
   assert.equal(after.find(m => m.id===outgoing.id).read_at,null);
   assert.ok(after.find(m => m.sender_id===BOB && m.recipient_id===ALICE).read_at);
   await as('authenticated',BOB,async () => {
    assert.equal(Number(await markRead(ALICE)),107);
    assert.equal(Number(await markRead(ALICE)),0);
    assert.deepEqual(await unread(),[]);
   });
   after = await messages();
   const readOutgoing = after.find(m => m.id===outgoing.id);
   assert.ok(readOutgoing.read_at);
   assert.deepEqual(await as('authenticated',ALICE,() => send(BOB,outgoing.body,outgoing.client_nonce)),readOutgoing);
   const later = await as('authenticated',ALICE,() => send(BOB,'Depois da leitura'));
   assert.equal(later.read_at,null);
   assert.deepEqual(await as('authenticated',BOB,() => unread()),[{ friend_id:ALICE,unread_count:1 }]);
   assert.deepEqual(await as('authenticated',CAROL,() => unread()),[{ friend_id:ALICE,unread_count:1 }]);
  });

  await t.test('removing friendship hides existing history, realtime rows, and unread totals', async () => {
   await db.query('delete from public.friendships where user_a=$1 and user_b=$2',[ALICE,BOB]);
   for (const [caller,friend] of [[ALICE,BOB],[BOB,ALICE]]) await as('authenticated',caller,async () => {
    assert.ok((await messages()).every(m => !((m.sender_id===ALICE && m.recipient_id===BOB) || (m.sender_id===BOB && m.recipient_id===ALICE))));
    await assert.rejects(history(friend),/não é seu amigo/);
    await assert.rejects(markRead(friend),/não é seu amigo/);
    await assert.rejects(send(friend),/não é seu amigo/);
    assert.ok((await unread()).every(row => row.friend_id!==friend));
   });
   await db.query('insert into public.friendships(user_a,user_b) values($1,$2)',[ALICE,BOB]);
   assert.ok((await as('authenticated',BOB,() => history(ALICE))).length>0);
  });

  await t.test('rate limit spans conversations, permits nonce retries, and expires after one minute', async () => {
   const sent = [];
   await as('authenticated',DAN,async () => {
    for (let n=0;n<30;n++) sent.push(await send(n%2 ? CAROL : BOB,`Mensagem ${n}`));
    await assert.rejects(send(BOB,'Too many'),/Muitas mensagens/);
    await assert.rejects(send(CAROL,'Too many in another conversation'),/Muitas mensagens/);
    assert.deepEqual(await send(BOB,sent[0].body,sent[0].client_nonce),sent[0]);
    await assert.rejects(send(BOB,'Changed retry',sent[0].client_nonce),/já utilizado/);
   });
   assert.equal(await scalar('select count(*)::int from public.friend_messages where sender_id=$1',[DAN]),30);
   assert.equal((await as('authenticated',CAROL,() => send(DAN,'Outro remetente'))).sender_id,CAROL);
   await db.query("update public.friend_messages set created_at=clock_timestamp()-interval '61 seconds' where sender_id=$1",[DAN]);
   assert.equal((await as('authenticated',DAN,() => send(BOB,'Janela liberada'))).sender_id,DAN);
   // PGlite has one connection; catalog inspection verifies the hosted lock primitive.
   assert.match(await scalar("select pg_get_functiondef('public.send_friend_message(uuid,text,uuid)'::regprocedure)"),/pg_advisory_xact_lock/);
  });

  await t.test('optional blocking installed later denies either direction without removing friendships', async () => {
   const toBob = await as('authenticated',ALICE,() => send(BOB,'Antes do bloqueio'));
   const toAlice = await as('authenticated',BOB,() => send(ALICE,'Também antes do bloqueio'));
   const before = await scalar('select jsonb_agg(jsonb_build_object(\'id\',id,\'read_at\',read_at) order by id) from public.friend_messages');
   await db.exec(`
    create table public.blocked_players(
     player_id uuid not null references auth.users(id),blocked_id uuid not null references auth.users(id),
     primary key(player_id,blocked_id),check(player_id<>blocked_id)
    );
    alter table public.blocked_players enable row level security;
    revoke all on public.blocked_players from public,anon,authenticated;
   `);
   const assertBlocked = async () => {
    assert.equal(await scalar('select public.are_friends($1,$2)',[ALICE,BOB]),true);
    for (const [caller,friend,prior] of [[ALICE,BOB,toBob],[BOB,ALICE,toAlice]]) await as('authenticated',caller,async () => {
     assert.equal(await allowed(caller,friend),false);
     assert.equal(await allowed(friend,caller),false);
     assert.ok((await messages()).every(m => !((m.sender_id===ALICE && m.recipient_id===BOB) || (m.sender_id===BOB && m.recipient_id===ALICE))));
     await assert.rejects(history(friend),/não é seu amigo/);
     await assert.rejects(markRead(friend),/não é seu amigo/);
     await assert.rejects(send(friend),/não é seu amigo/);
     await assert.rejects(send(friend,prior.body,prior.client_nonce),/não é seu amigo/);
     assert.ok((await unread()).every(row => row.friend_id!==friend));
    });
    assert.equal(await as('authenticated',CAROL,() => allowed(ALICE,BOB)),false);
    assert.equal(await as('authenticated',ALICE,() => allowed(ALICE,CAROL)),true);
    assert.ok((await as('authenticated',ALICE,() => history(CAROL))).length>0);
    assert.deepEqual(await scalar('select jsonb_agg(jsonb_build_object(\'id\',id,\'read_at\',read_at) order by id) from public.friend_messages'),before);
   };
   // Table-only protection also works during a partial social-protection upgrade.
   await db.query('insert into public.blocked_players(player_id,blocked_id) values($1,$2)',[ALICE,BOB]);
   await assertBlocked();
   await db.exec(`
    create function public.players_blocked(a uuid,b uuid) returns boolean
    language sql stable security definer set search_path=public as $$
     select exists(select 1 from blocked_players where (player_id=a and blocked_id=b) or (player_id=b and blocked_id=a));
    $$;
    revoke all on function public.players_blocked(uuid,uuid) from public,anon,authenticated;
   `);
   await as('authenticated',ALICE,() => assert.rejects(scalar('select public.players_blocked($1,$2)',[ALICE,BOB]),/permission denied/));
   // The already-installed chat helper invokes the private protection function as its owner.
   await assertBlocked();
   await db.query('delete from public.blocked_players where player_id=$1 and blocked_id=$2',[ALICE,BOB]);
   assert.equal(await as('authenticated',ALICE,() => allowed(ALICE,BOB)),true);
   await db.query('insert into public.blocked_players(player_id,blocked_id) values($1,$2)',[BOB,ALICE]);
   await assertBlocked();
   await db.exec(migration);
   await assertBlocked();
   await db.query('delete from public.blocked_players where player_id=$1 and blocked_id=$2',[BOB,ALICE]);
   assert.equal(await as('authenticated',BOB,() => allowed(ALICE,BOB)),true);
   assert.ok((await as('authenticated',BOB,() => history(ALICE))).some(m => m.id===toBob.id));
  });

  await t.test('existing Realtime publication membership is added once and preserves other tables', async () => {
   await db.exec('create publication supabase_realtime for table public.friend_requests');
   await db.exec(migration);
   await db.exec(migration);
   const published = (await db.query("select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename")).rows.map(row => row.tablename);
   assert.deepEqual(published,['friend_messages','friend_requests']);
   await db.exec('drop publication supabase_realtime');
   await db.exec('create publication supabase_realtime for all tables');
   await db.exec(migration);
   assert.equal(await scalar("select puballtables from pg_publication where pubname='supabase_realtime'"),true);
   const aliceVisible = await as('authenticated',ALICE,() => messages());
   assert.ok(aliceVisible.every(m => m.sender_id===ALICE || m.recipient_id===ALICE));
   assert.deepEqual(await scalar('select jsonb_agg(to_jsonb(p) order by id) from public.player_profiles p'),accountsBefore);
  });
 } finally { await db.close(); }
});
