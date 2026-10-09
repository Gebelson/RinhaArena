import test from 'node:test';
import assert from 'node:assert/strict';
import { filterHistory, summarizeHistory, profileTotals, playerProfileFromRow, normalizeHistoryRow, recordedMatchPayload, accumulateRecordedStats } from '../profileModel.js';
import { getAvatarUrl, isAvatarId } from '../../content/avatars.js';

test('public profile mapping preserves actual XP, inventory and opt-in visibility', () => {
  const view=playerProfileFromRow({ id:'alice',nickname:'Alice',rank_points:740,experience_points:1600,matches:5,wins:3,losses:1,profile_bio:'Oi',profile_banner:'forest',history_public:false,owned_characters:['capivara','macaco'],owned_emotes:['macaco-joinha'] });
  assert.equal(view.playerId,'alice');assert.equal(view.rankXp,740);assert.equal(view.experienceXp,1600);
  assert.equal(view.historyPublic,false);assert.equal(view.bio,'Oi');assert.deepEqual(view.cos.ownedCharacters,['capivara','macaco']);
  assert.deepEqual(profileTotals(view),{ matches:5,wins:3,losses:1,draws:1,winRate:60 });
});
test('recent statistics use recorded rows and handle zero deaths without Infinity', () => {
  const rows=[{outcome:'win',mode_id:'ctf',stats:{eliminations:4,deaths:0,captures:2,returns:1}}, {outcome:'loss',mode_id:'ffa',stats:{eliminations:2,deaths:3}}, {outcome:'draw',mode_id:'ctf',stats:{eliminations:-10,deaths:NaN}}];
  const result=summarizeHistory(rows);
  assert.equal(result.eliminations,6);assert.equal(result.deaths,3);assert.equal(result.kd,'2.00');assert.equal(result.winRate,33);
  assert.deepEqual(result.modes,[{mode:'ctf',matches:2,wins:1},{mode:'ffa',matches:1,wins:0}]);
  assert.equal(summarizeHistory([]).kd,'0.00');assert.equal(summarizeHistory([rows[0]]).kd,'4');
});
test('history filters combine mode, queue and outcome including legacy deathmatch IDs', () => {
  const rows=[{mode_id:'dm',ranked:true,outcome:'win'},{mode_id:'deathmatch',ranked:false,outcome:'win'},{mode_id:'ctf',ranked:true,outcome:'loss'}];
  assert.deepEqual(filterHistory(rows,{mode:'deathmatch',queue:'ranked',outcome:'win'}),[rows[0]]);
  assert.equal(filterHistory(rows,{mode:'ctf',outcome:'win'}).length,0);
  assert.equal(filterHistory(rows).length,3);
});
test('avatar resolver accepts game icons and immutable owned paths, never arbitrary URLs or HTML', () => {
  const value='uploaded:a0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000002.webp';
  assert.equal(isAvatarId(value),true);assert.match(getAvatarUrl(value),/\/profile-avatars\/a0000000-0000-4000-8000-000000000001\/b0000000-0000-4000-8000-000000000002.webp$/);
  for(const input of ['https://evil.test/x.png','avatar-1.webp"><script>','uploaded:../x','avatar-20.webp']) {assert.equal(isAvatarId(input),false);assert.equal(getAvatarUrl(input),'./assets/ui/avatars/avatar-1.webp');}
});

test('missing recorded details remain unknown instead of fabricated rewards and stats', () => {
  const row=normalizeHistoryRow({match_id:'match:1',created_at:'2026-10-08T12:00:00Z',outcome:'win',stats:{eliminations:0},gold:null});
  assert.deepEqual(row.statKnown,[true,false,false,false]);
  assert.deepEqual(row.rewardKnown,[false,false,false]);
});
test('completed matches record self statistics and stable round identity without economy fields', () => {
  const event={t:'roundOver',winner:'red',ranked:true,matchComplete:true,scores:{red:3,blue:1},series:{bestOf:3,wins:{red:2,blue:1}}};
  const view={modeId:'ctf',players:[{id:'human:a',team:'red',stats:{eliminations:4,deaths:2,captures:1,returns:0}},{id:'b',team:'blue'}]};
  const result=recordedMatchPayload({matchId:'match:stable',event,view,myId:'human:a',mapId:'procedural:123'});
  assert.equal(result.p_match_id,'match:stable');assert.equal(result.p_round,3);assert.equal(result.p_outcome,'win');
  assert.deepEqual(result.p_stats,{eliminations:4,deaths:2,captures:1,returns:0});
  assert.equal(result.p_summary.capacity,2);assert.equal(result.p_map_id,'procedural:123');
  assert.equal('gold' in result,false);assert.equal('rank_points' in result,false);
  assert.equal(recordedMatchPayload({matchId:'x',event:{...event,matchComplete:false},view,myId:'human:a',mapId:'dojo'}),null);
  assert.equal(recordedMatchPayload({matchId:'x',event,view:{...view,lab:true},myId:'human:a',mapId:'dojo'}),null);
  assert.equal(recordedMatchPayload({matchId:'x',event,view,myId:'missing',mapId:'dojo'}),null);
});

test('match journal accumulates completed-round performance across a series without inventing absent fields', () => {
  const total={};
  accumulateRecordedStats(total,{eliminations:4,deaths:2,captures:1});
  accumulateRecordedStats(total,{eliminations:3,deaths:1,captures:2});
  assert.deepEqual(total,{eliminations:7,deaths:3,captures:3});
  assert.equal('returns' in total,false);
  accumulateRecordedStats(total,{deaths:NaN,returns:null});
  assert.deepEqual(total,{eliminations:7,deaths:3,captures:3});
});
