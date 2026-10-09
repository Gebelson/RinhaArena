import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const ALICE = 'a0000000-0000-4000-8000-000000000001';
const BOB = 'b0000000-0000-4000-8000-000000000002';
const CAROL = 'c0000000-0000-4000-8000-000000000003';
const IMAGE = 'd0000000-0000-4000-8000-000000000004.webp';
const migration = await readFile(new URL('../supabase/migrations/20261008_player_profile_compatible.sql', import.meta.url), 'utf8');
const fixture = await readFile(new URL('./profile-compatible-fixture.sql', import.meta.url), 'utf8');

test('standalone profile migration preserves hosted legacy account behavior', async t => {
 const db = new PGlite();
 const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
 const as = async (role, id, run) => {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']);
  await db.exec(`set role ${role}`);
  try { return await run(); } finally { await db.exec('reset role'); }
 };
 const profile = id => scalar('select get_player_profile($1)', [id]);
 const history = (id, limit = 50) => scalar('select get_player_match_history($1,$2)', [id, limit]);
 const save = (overrides = {}) => {
  const p = { name:'Alice', avatar:'avatar-10.webp', bio:'Olá', banner:'forest', character:'gato', public:false, ...overrides };
  return scalar('select update_player_presentation($1,$2,$3,$4,$5,$6)', [p.name,p.avatar,p.bio,p.banner,p.character,p.public]);
 };
 const record = (overrides = {}) => {
  const p = { match:'match:abc', round:1, mode:'ctf', map:'feira_suspensa', ranked:true, outcome:'win',
   stats:{ eliminations:3,deaths:1,captures:2,returns:0 },summary:{ winner:'red',team:'red',scores:{ red:3,blue:1 },capacity:6 },...overrides };
  return scalar('select record_player_match_history($1,$2,$3,$4,$5,$6,$7,$8)', [p.match,p.round,p.mode,p.map,p.ranked,p.outcome,p.stats,p.summary]);
 };
 try {
  await db.exec(fixture);
  for (const id of [ALICE,BOB,CAROL]) await db.query('insert into auth.users(id) values($1)', [id]);
  await db.query("insert into player_profiles(id,nickname,gold,rank_points,matches,wins,losses,owned_characters,owned_emotes,abandon_warnings) values($1,'Alice',175,29,4,2,1,array['capivara','gato'],array['gato-joinha'],2)", [ALICE]);
  await db.query("insert into player_profiles(id,nickname) values($1,'Bob')", [BOB]);
  const before = await scalar('select to_jsonb(p) from player_profiles p where id=$1', [ALICE]);
  await db.exec(migration);

  await t.test('idempotent migration only adds presentation and private recorded-history surfaces', async () => {
   await db.exec(migration);
   const after = await scalar('select to_jsonb(p) from player_profiles p where id=$1', [ALICE]);
   for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key]);
   assert.equal(after.history_public,false); assert.equal(after.profile_banner,'character'); assert.equal(after.profile_bio,'');
   for (const table of ['match_results','match_receipts','shop_catalog','blocked_players','player_reports']) assert.equal(await scalar('select to_regclass($1)', [`public.${table}`]),null);
   assert.equal(await scalar("select to_regprocedure('public.purchase_shop_item(text,text,uuid)')"),null);
   assert.equal(await scalar("select count(*)::int from information_schema.columns where table_name='player_profiles' and column_name in('experience_points','missions','mission_stats','profile_version')"),0);
   const bucket = await scalar("select to_jsonb(b) from storage.buckets b where id='profile-avatars'");
   assert.equal(bucket.public,true); assert.equal(bucket.file_size_limit,262144); assert.deepEqual(bucket.allowed_mime_types,['image/webp']);
  });

  await t.test('own RPC preserves full account row and legacy XP; public RPC excludes sensitive columns', async () => {
   const own = await as('authenticated',ALICE,() => profile(ALICE));
   for (const key of Object.keys(before)) assert.deepEqual(own[key],before[key]);
   assert.equal(own.experience_points,300);
   const other = await as('authenticated',BOB,() => profile(ALICE));
   assert.equal(other.experience_points,300); assert.equal(other.history_public,false); assert.equal(other.selected_character,'capivara');
   for (const key of ['gold','owned_characters','owned_emotes','abandon_warnings','matchmaking_blocked_until','last_abandon_at','friendly_fire']) assert.equal(key in other,false);
   assert.equal(await as('authenticated',ALICE,() => profile(CAROL)),null);
   await as('anon',null,() => assert.rejects(profile(ALICE),/permission denied/));
   await as('authenticated',null,() => assert.rejects(profile(ALICE),/Entre na sua conta/));
  });

  await t.test('legacy full account PATCH, inventory and ranking submissions remain writable', async () => {
   await as('authenticated',ALICE,async () => {
    await db.query("update player_profiles set nickname='Alice',gold=180,rank_points=35,matches=5,wins=3,losses=1,avatar='avatar-10.webp',hat='chef',skin='#abcdef',friendly_fire=true,owned_characters=array['capivara','gato'],owned_emotes=array['gato-joinha'],selected_character='gato',updated_at=now() where id=$1", [ALICE]);
    assert.equal(await scalar("select submit_player_ranking($1,'Alice','avatar-10.webp',35,3,1,5)", [ALICE]),true);
    assert.equal((await db.query("update player_profiles set gold=999 where id=$1", [BOB])).affectedRows,0);
    assert.equal((await db.query('select * from player_profiles where id=$1', [BOB])).rows.length,0);
   });
   const ranking = await scalar('select to_jsonb(r) from player_rankings r where player_id=$1',[ALICE]);
   assert.equal(ranking.points,35); assert.equal(ranking.wins,3);
   await db.query("update player_profiles set avatar='legacy-avatar',selected_character='legacy-character' where id=$1",[BOB]);
   await as('authenticated',BOB,() => db.query('update player_profiles set gold=7 where id=$1',[BOB]));
   assert.equal(await scalar('select gold from player_profiles where id=$1',[BOB]),7);
  });

  await t.test('presentation uses RPC; direct REST cannot bypass validation of new fields', async () => {
   await as('authenticated',ALICE,async () => {
    for (const sql of ["profile_bio='Forged'","profile_banner='ocean'","history_public=true"]) {
     await assert.rejects(db.query(`update player_profiles set ${sql} where id=$1`,[ALICE]),/Use update_player_presentation/);
    }
    await assert.rejects(save({ name:' Guest ' }),/Nome inválido/);
    await assert.rejects(save({ name:'\u00a0\u2000Player123\ufeff' }),/Nome inválido/);
    await assert.rejects(save({ name:'A' }),/Nome inválido/);
    await assert.rejects(save({ bio:'x'.repeat(161) }),/Biografia inválida/);
    await assert.rejects(save({ banner:'arbitrary' }),/Capa inválida/);
    await assert.rejects(save({ character:'macaco' }),/Personagem não adquirido/);
    await assert.rejects(save({ avatar:'https://arbitrary.test/a.webp' }),/Avatar inválido/);
    await assert.rejects(save({ public:null }),/Perfil inválido/);
    const updated = await save({ name:'\u00a0Alice2\ufeff' });
    assert.equal(updated.nickname,'Alice2'); assert.equal(updated.gold,180); assert.equal(updated.rank_points,35);
    assert.equal(updated.experience_points,400); assert.equal(updated.profile_bio,'Olá'); assert.equal(updated.selected_character,'gato');
   });
   const ranking = await scalar('select to_jsonb(r) from player_rankings r where player_id=$1',[ALICE]);
   assert.equal(ranking.player_name,'Alice2'); assert.equal(ranking.points,35); assert.equal(ranking.wins,3);
   await as('authenticated',CAROL,async () => {
    await assert.rejects(db.query("insert into player_profiles(id,nickname,history_public) values($1,'Carol',true)",[CAROL]),/Use update_player_presentation/);
    await db.query("insert into player_profiles(id,nickname,avatar) values($1,'C','avatar-1.webp')",[CAROL]);
   });
  });

  await t.test('custom image paths must be immutable existing objects owned by the caller', async () => {
   const alicePath = `${ALICE}/${IMAGE}`, bobPath = `${BOB}/${IMAGE}`;
   await as('authenticated',BOB,() => db.query("insert into storage.objects(bucket_id,name) values('profile-avatars',$1)",[bobPath]));
   await as('authenticated',ALICE,async () => {
    await assert.rejects(save({ avatar:`uploaded:${alicePath}` }),/Avatar inválido/);
    await assert.rejects(save({ avatar:`uploaded:${bobPath}` }),/Avatar inválido/);
    await assert.rejects(db.query("update player_profiles set avatar=$1 where id=$2",[`uploaded:${bobPath}`,ALICE]),/Avatar inválido/);
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name,owner_id) values('profile-avatars',$1,$2)",[alicePath,BOB]),/row-level security/);
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('profile-avatars',$1)",[`${ALICE}/bad.png`]),/row-level security/);
    await db.query("insert into storage.objects(bucket_id,name) values('profile-avatars',$1)",[alicePath]);
    await save({ avatar:`uploaded:${alicePath}` });
    assert.equal((await db.query('select * from storage.objects where name=$1',[bobPath])).rows.length,0);
    assert.equal((await db.query("update storage.objects set metadata='{}' where name=$1",[alicePath])).affectedRows,0);
    assert.equal((await db.query('delete from storage.objects where name=$1',[alicePath])).affectedRows,0);
    await save();
    assert.equal((await db.query('delete from storage.objects where name=$1',[alicePath])).affectedRows,1);
   });
  });

  await t.test('new history starts empty and private; recording is authenticated and cannot change balances', async () => {
   assert.deepEqual(await as('authenticated',ALICE,() => history(ALICE)),[]);
   assert.equal(await as('authenticated',BOB,() => history(ALICE)),null);
   const accountBefore = await scalar('select to_jsonb(p) from player_profiles p where id=$1',[ALICE]);
   await as('anon',null,() => assert.rejects(record(),/permission denied/));
   await as('authenticated',null,() => assert.rejects(record(),/Entre na sua conta/));
   await as('authenticated',ALICE,async () => {
    await assert.rejects(db.query("insert into profile_match_history(player_id,match_id,round,mode_id,map_id,ranked,outcome) values($1,'forged',1,'ctf','dojo',true,'win')",[ALICE]),/permission denied/);
    const row = await record({ stats:{ eliminations:3,player_id:BOB,gold:9999 },summary:{ winner:'red',capacity:6,token:'secret',gold:9999,created_at:'2000-01-01' } });
    assert.equal(row.match_id,'match:abc:round:1'); assert.equal(row.trusted,false); assert.equal(row.recorded,true);
    assert.deepEqual(row.stats,{ eliminations:3 }); assert.deepEqual(row.summary,{ winner:'red',capacity:6 });
    for (const key of ['player_id','gold','xp','rank_delta']) assert.equal(key in row,false);
    assert.ok(new Date(row.created_at).getUTCFullYear()>2020);
    const replay = await record({ outcome:'loss',stats:{ eliminations:999 } });
    assert.equal(replay.outcome,'win'); assert.deepEqual(replay.stats,{ eliminations:3 });
    await record({ round:2,map:'procedural:12345',stats:{} });
    const rows = await history(ALICE);
    assert.equal(rows.length,2); assert.equal(rows[0].source,'profile_match_history');
    assert.equal('stats' in rows[0],false); assert.equal('gold' in rows[0],false);
    assert.equal((await history(ALICE,1)).length,1);
    await assert.rejects(db.query('delete from profile_match_history where player_id=$1',[ALICE]),/permission denied/);
   });
   assert.deepEqual(await scalar('select to_jsonb(p) from player_profiles p where id=$1',[ALICE]),accountBefore);
   await as('authenticated',BOB,async () => assert.equal((await db.query('select * from profile_match_history where player_id=$1',[ALICE])).rows.length,0));
  });

  await t.test('record validation rejects unsafe or implausible metadata without writing results', async () => {
   await as('authenticated',ALICE,async () => {
    for (const overrides of [{ match:'<script>' },{ round:0 },{ mode:'sandbox' },{ map:'../secret' },{ ranked:null },{ outcome:'victory' },{ stats:null },{ stats:{ eliminations:-1 } },{ stats:{ deaths:0.5 } },{ summary:{ capacity:7 } },{ summary:{ scores:{ red:-1 } } }]) {
     await assert.rejects(record(overrides),/inválid/);
    }
    assert.equal((await history(ALICE)).length,2);
   });
  });

  await t.test('public opt-in history contains recorded gameplay only, with identifiers and economy omitted', async () => {
   await as('authenticated',ALICE,() => save({ public:true }));
   const rows = await as('authenticated',BOB,() => history(ALICE));
   assert.equal(rows.length,2); assert.equal(rows[0].trusted,false);
   for (const row of rows) for (const key of ['match_id','player_id','round','gold','xp','rank_delta','token']) assert.equal(key in row,false);
   await as('authenticated',ALICE,() => save({ public:false }));
   assert.equal(await as('authenticated',BOB,() => history(ALICE)),null);
  });

  await t.test('existing XP and mission columns survive presentation saves and are private', async () => {
   await db.exec("alter table player_profiles add column experience_points bigint,add column missions jsonb not null default '[]',add column mission_stats jsonb not null default '{}'");
   await db.query("update player_profiles set experience_points=987,missions='[{\"id\":\"legacy-mission\",\"gold\":25}]',mission_stats='{\"wins\":2}' where id=$1",[ALICE]);
   const own = await as('authenticated',ALICE,() => save());
   assert.equal(own.experience_points,987); assert.deepEqual(own.missions,[{ id:'legacy-mission',gold:25 }]); assert.deepEqual(own.mission_stats,{ wins:2 });
   const other = await as('authenticated',BOB,() => profile(ALICE));
   assert.equal(other.experience_points,987); assert.equal('missions' in other,false); assert.equal('mission_stats' in other,false);
   await db.exec(migration);
   assert.equal((await as('authenticated',ALICE,() => profile(ALICE))).experience_points,987);
  });

  await t.test('optional legacy match_results is read only when its shape is usable, never backfilled', async () => {
   await db.exec('create table match_results(player_id uuid,arbitrary jsonb)');
   assert.equal((await as('authenticated',ALICE,() => history(ALICE))).length,2);
   await db.exec('alter table match_results add column created_at timestamptz default now(),add column outcome text,add column match_id text,add column stats jsonb,add column summary jsonb,add column gold int,add column xp int,add column rank_delta int');
   await db.query("insert into match_results(player_id,outcome,match_id,stats,summary,gold,xp,rank_delta) values($1,'loss','legacy-match','{\"eliminations\":4,\"deaths\":\"unknown\",\"player_id\":\"secret\"}','{\"winner\":\"blue\",\"team\":\"red\",\"token\":\"secret\",\"scores\":{\"red\":1,\"blue\":2}}',20,40,-15)",[ALICE]);
   const own = await as('authenticated',ALICE,() => history(ALICE));
   const legacy = own.find(r => r.source==='match_results');
   assert.equal(own.length,3); assert.equal(legacy.trusted,false); assert.equal(legacy.gold,20); assert.equal(legacy.xp,40); assert.equal(legacy.rank_delta,-15);
   assert.deepEqual(legacy.stats,{ eliminations:4 }); assert.equal('token' in legacy.summary,false);
   await as('authenticated',ALICE,() => save({ public:true }));
   const other = (await as('authenticated',BOB,() => history(ALICE))).find(r => r.source==='match_results');
   for (const key of ['match_id','gold','xp','rank_delta','player_id']) assert.equal(key in other,false);
   assert.equal(await scalar('select count(*)::int from match_results'),1);
  });

  await t.test('optional blocking table and players_blocked function deny either direction of public access', async () => {
   await db.exec('create table blocked_players(player_id uuid,blocked_id uuid)');
   await db.query('insert into blocked_players values($1,$2)',[ALICE,BOB]);
   assert.equal(await as('authenticated',BOB,() => profile(ALICE)),null);
   assert.equal(await as('authenticated',BOB,() => history(ALICE)),null);
   assert.ok(await as('authenticated',ALICE,() => profile(ALICE)));
   await db.exec("create function players_blocked(a uuid,b uuid) returns boolean language sql stable as $$select exists(select 1 from blocked_players where (player_id=a and blocked_id=b)or(player_id=b and blocked_id=a))$$");
   assert.equal(await as('authenticated',ALICE,() => profile(BOB)),null);
   await db.exec('delete from blocked_players');
   assert.ok(await as('authenticated',BOB,() => profile(ALICE)));
  });
 } finally { await db.close(); }
});
