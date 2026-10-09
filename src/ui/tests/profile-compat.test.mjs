import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAccountProfile, signIn, saveAccountProfile, authenticatedRpc, signOut } from '../../net/account.js';
import { getLevelProgress, getEarnedLevelXp } from '../../content/levels.js';

test('presentation responses preserve legacy currency, mission state and counter-derived levels', () => {
  const profile={gold:543,rankXp:700,rankStats:{matches:9,wins:5,losses:3},missionStats:{wins:5},missions:[{id:'mission-a'}],cos:{ownedCharacters:['capivara','gato'],ownedEmotes:['gato-estilo']}};
  const missions=profile.missions,stats=profile.missionStats;
  applyAccountProfile(profile,{id:'a',nickname:'Alice',avatar:'avatar-2.webp',profile_bio:'Olá',profile_banner:'forest',history_public:true});
  assert.equal(profile.gold,543);assert.equal(profile.rankXp,700);
  assert.equal(profile.missions,missions);assert.equal(profile.missionStats,stats);
  assert.deepEqual(profile.cos.ownedCharacters,['capivara','gato']);
  assert.equal(getLevelProgress({...profile.rankStats,experienceXp:0}).totalXp,getEarnedLevelXp(profile.rankStats));
  assert.equal(profile.bio,'Olá');assert.equal(profile.historyPublic,true);
});

test('legacy account persistence keeps economy fields while only profile RPC retries a rejected bearer', async () => {
  const previousFetch=globalThis.fetch, previousStorage=globalThis.localStorage;
  const saved=new Map();globalThis.localStorage={getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)};
  const calls=[];let rejected=false;
  const response=(status,value)=>({ok:status>=200&&status<300,status,json:async()=>value});
  globalThis.fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body,options});
    if(url.includes('grant_type=password'))return response(200,{access_token:'old',refresh_token:'refresh',expires_in:3600,user:{id:'a'}});
    if(url.includes('grant_type=refresh_token'))return response(200,{access_token:'fresh',refresh_token:'next',expires_in:3600,user:{id:'a'}});
    if(url.includes('/rpc/get_player_profile')&&!rejected){rejected=true;return response(401,{message:'Rejected bearer'});}
    if(url.includes('/rpc/get_player_profile'))return response(200,{id:'a',nickname:'Alice'});
    if(options.method==='PATCH')return response(204,null);
    return response(200,[{id:'a',nickname:'Alice'}]);
  };
  try {
    await signIn('alice@example.test','password');
    await saveAccountProfile({playerId:'a',name:'Alice',gold:543,rankXp:700,rankStats:{matches:9,wins:5,losses:3},cos:{avatar:'avatar-2.webp',characterId:'gato',ownedCharacters:['capivara','gato'],ownedEmotes:['gato-estilo']}});
    const patch=calls.find(call=>call.options.method==='PATCH');
    assert.equal(patch.body.gold,543);assert.equal(patch.body.rank_points,700);assert.equal(patch.body.matches,9);
    assert.deepEqual(patch.body.owned_characters,['capivara','gato']);assert.deepEqual(patch.body.owned_emotes,['gato-estilo']);
    assert.equal('profile_bio' in patch.body,false);
    assert.deepEqual(await authenticatedRpc('get_player_profile',{p_player_id:'a'}),{id:'a',nickname:'Alice'});
    const rpc=calls.filter(call=>call.url.includes('/rpc/get_player_profile'));
    assert.equal(rpc.length,2);assert.equal(rpc[0].options.headers.authorization,'Bearer old');assert.equal(rpc[1].options.headers.authorization,'Bearer fresh');
    assert.equal(calls.filter(call=>call.url.includes('grant_type=refresh_token')).length,1);
    await signOut();
  } finally {globalThis.fetch=previousFetch;globalThis.localStorage=previousStorage;}
});
