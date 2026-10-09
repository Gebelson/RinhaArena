import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const ALICE = 'a0000000-0000-4000-8000-000000000001';
const TOKEN = 'b0000000-0000-4000-8000-000000000002';
const WRONG_TOKEN = 'c0000000-0000-4000-8000-000000000003';
const root = new URL('../',import.meta.url);
const read = path => readFile(new URL(path,root),'utf8');

test('standalone Supabase Free capacity migration works on legacy hosted rooms', async t => {
 const db = new PGlite({ extensions:{ pgcrypto } });
 const scalar = async (sql,args=[]) => Object.values((await db.query(sql,args)).rows[0])[0];
 const as = async (role,run) => {
  await db.exec(`set role ${role}`);
  try { return await run(); } finally { await db.exec('reset role'); }
 };
 const room = code => scalar('select to_jsonb(r) from game_rooms r where code=$1',[code]);
 const list = () => scalar('select list_game_rooms()');
 const join = (code,password='') => scalar('select join_game_room($1,$2)',[code,password]);
 const touch = (code,token,count) => scalar('select touch_game_room($1,$2,$3)',[code,token,count]);
 const create = (overrides={}) => {
  const p={ code:'testroom',name:'Test',password:'',mode:'ctf',map:'feira_suspensa',red:3,blue:3,ffa:6,respawn:5,friendly:false,...overrides };
  return scalar('select create_game_room($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[p.code,p.name,p.password,p.mode,p.map,p.red,p.blue,p.ffa,p.respawn,p.friendly]);
 };
 try {
  await db.exec(await read('tests/profile-compatible-fixture.sql'));
  await db.exec('create schema extensions');
  await db.exec(await read('supabase/migrations/20260929_multiplayer_rooms.sql'));
  await db.exec(await read('supabase/migrations/20261004_feira_suspensa_rooms.sql'));
  await db.query('insert into auth.users(id) values($1)',[ALICE]);
  await db.query("insert into player_profiles(id,nickname,gold,rank_points,owned_characters) values($1,'Alice',777,444,array['capivara','gato'])",[ALICE]);
  await db.query("insert into game_rooms(code,name,mode_id,level_id,red_size,blue_size,ffa_size,host_token,players_count) values('oversized','Old 10v10','ctf','foundry',10,10,10,$1,12),('healthy','Old 2v2','ctf','dojo',2,2,6,$1,1)",[TOKEN]);
  await db.query("insert into game_rooms(code,name,mode_id,level_id,red_size,blue_size,ffa_size,host_token,players_count,last_active_at) values('expiredwide','Expired 10v10','ctf','foundry',10,10,10,$1,12,now()-interval '20 minutes'),('expiredother','Expired valid','ctf','dojo',2,2,6,$1,1,now()-interval '20 minutes')",[TOKEN]);
  const oldOversized=await room('oversized'), oldExpired=await room('expiredwide'), oldUnrelated=await room('expiredother');
  const accountBefore=await scalar('select to_jsonb(p) from player_profiles p where id=$1',[ALICE]);
  const migration=await read('supabase/migrations/20261008_free_room_capacity.sql');
  await db.exec(migration);

  await t.test('idempotent deployment preserves legacy rooms and accounts without modern dependencies',async () => {
   await db.exec(migration);
   assert.deepEqual(await room('oversized'),oldOversized); assert.deepEqual(await room('expiredwide'),oldExpired);
   assert.deepEqual(await room('expiredother'),oldUnrelated);
   assert.deepEqual(await scalar('select to_jsonb(p) from player_profiles p where id=$1',[ALICE]),accountBefore);
   const constraints=(await db.query("select conname,convalidated from pg_constraint where conrelid='game_rooms'::regclass and conname like 'game_rooms_free_%' order by conname")).rows;
   assert.equal(constraints.length,2); assert.ok(constraints.every(c => c.convalidated===false));
   for (const table of ['room_members','match_receipts','shop_catalog','blocked_players']) assert.equal(await scalar('select to_regclass($1)',[`public.${table}`]),null);
   for (const column of ['created_by','status','config','lease_owner']) assert.equal(await scalar("select count(*)::int from information_schema.columns where table_name='game_rooms' and column_name=$1",[column]),0);
  });

  await t.test('older oversized rooms cannot be advertised, joined or renewed',async () => {
   await as('anon',async () => {
    assert.deepEqual((await list()).map(r => r.code),['healthy']);
    const blocked=await join('oversized'); assert.equal(blocked.ok,false); assert.match(blocked.error,/3v3/);
    assert.equal(await touch('oversized',TOKEN,6),false);
    assert.equal(await touch('oversized',TOKEN,0),false);
   });
   assert.deepEqual(await room('oversized'),oldOversized);
   await as('authenticated',async () => assert.equal((await join('healthy')).ok,true));
  });

  await t.test('create validates team and FFA sizes instead of accepting oversized or malformed inputs',async () => {
   await as('anon',async () => {
    for (const [i,invalid] of [{red:4},{blue:4},{red:10,blue:10},{red:0},{blue:-1},{ffa:7},{ffa:1},{red:2147483647}].entries()) {
     const result=await create({code:`invalid${i}`,...invalid});
     assert.equal(result.ok,false); assert.match(result.error,/3 jogadores.*6 jogadores/);
    }
    await assert.rejects(create({code:'decimal',red:'1.5'}),/invalid input syntax for type integer/);
    await assert.rejects(create({code:'text',blue:'malformed'}),/invalid input syntax for type integer/);
   });
   assert.equal(await scalar("select count(*)::int from game_rooms where code like 'invalid%' or code in('decimal','text')"),0);
  });

  await t.test('valid 1v1 through 3v3 and 2..6 FFA keep the legacy frontend response',async () => {
   await as('anon',async () => {
    for (const [i,valid] of [{red:1,blue:1},{red:1,blue:3},{red:3,blue:3},{mode:'ffa',ffa:2},{mode:'ffa',ffa:6},{red:null,blue:null,ffa:null}].entries()) {
     const result=await create({code:`valid${i}`,...valid});
     assert.equal(result.ok,true); assert.equal(result.room.ok,true); assert.ok(result.hostToken);
     await assert.rejects(room(result.code),/permission denied/);
     if(result.room.modeId==='ffa') assert.ok(result.room.teamLimits.ffa>=2 && result.room.teamLimits.ffa<=6);
     else assert.ok(result.room.teamLimits.red<=3 && result.room.teamLimits.blue<=3);
     assert.equal(result.room.levelId,'feira_suspensa');
     assert.equal('hostToken' in result.room,false); assert.equal('password_hash' in result.room,false);
    }
    const summaries=await list();
    assert.ok(summaries.every(r => r.maxPlayers<=6));
    assert.ok(summaries.every(r => !('hostToken' in r) && !('password_hash' in r)));
   });
  });

  await t.test('active duplicate creates do not replace host tokens, while expired requested codes can be reused',async () => {
   const healthyBefore=await room('healthy');
   await as('anon',async () => {
    assert.equal((await create({code:'healthy',name:'Hijack'})).ok,false);
    const replaced=await create({code:'expiredwide',red:3,blue:3});
    assert.equal(replaced.ok,true); assert.notEqual(replaced.hostToken,TOKEN);
   });
   assert.deepEqual(await room('healthy'),healthyBefore);
   const replaced=await room('expiredwide'); assert.equal(replaced.red_size,3); assert.equal(replaced.blue_size,3); assert.equal(replaced.players_count,1);
   assert.deepEqual(await room('expiredother'),oldUnrelated);
   assert.deepEqual(await room('oversized'),oldOversized);
  });

  await t.test('password and host token checks still protect joins and occupancy reports',async () => {
   const created=await as('anon',() => create({code:'protected',password:'secret',red:3,blue:3}));
   await as('anon',async () => {
    assert.equal((await join('protected','wrong')).ok,false);
    assert.equal((await join('protected','secret')).ok,true);
    assert.equal(await touch('protected',WRONG_TOKEN,3),false);
    assert.equal(await touch('protected',created.hostToken,7),false);
    assert.equal(await touch('protected',created.hostToken,-1),false);
    assert.equal(await touch('protected',created.hostToken,6),true);
    const full=await join('protected','secret'); assert.equal(full.ok,false); assert.match(full.error,/cheia/);
    assert.equal(await touch('protected',created.hostToken,5),true);
    assert.equal((await join('protected','secret')).ok,true);
   });
   assert.equal((await room('protected')).players_count,5);
   const smaller=await as('anon',() => create({code:'small',red:1,blue:1}));
   await as('anon',async () => {
    assert.equal(await touch('small',smaller.hostToken,3),false);
    assert.equal(await touch('small',smaller.hostToken,2),true);
    assert.equal((await join('small')).ok,false);
    assert.equal(await touch('small',smaller.hostToken,0),true);
    assert.equal((await join('small')).ok,false);
   });
  });

  await t.test('table RLS and constraints also reject direct capacity bypasses',async () => {
   for (const role of ['anon','authenticated']) await as(role,async () => {
    await assert.rejects(db.exec("update game_rooms set red_size=99 where code='healthy'"),/permission denied/);
    await assert.rejects(db.exec("update game_rooms set players_count=99 where code='healthy'"),/permission denied/);
    await assert.rejects(db.exec("insert into game_rooms(code,name,mode_id,level_id,host_token) values('rest','REST','ctf','dojo','b0000000-0000-4000-8000-000000000002')"),/permission denied/);
   });
   for (const mutation of ['red_size=4','blue_size=0','ffa_size=7','players_count=7','players_count=-1']) {
    await assert.rejects(db.exec(`update game_rooms set ${mutation} where code='healthy'`),/violates check constraint/);
   }
   await assert.rejects(db.exec("insert into game_rooms(code,name,mode_id,level_id,red_size,blue_size,ffa_size,host_token,players_count) values('sql','SQL','ctf','dojo',3,3,6,'b0000000-0000-4000-8000-000000000002',7)"),/game_rooms_free_player_count/);
   assert.deepEqual(await scalar('select to_jsonb(p) from player_profiles p where id=$1',[ALICE]),accountBefore);
  });
 } finally { await db.close(); }
});
