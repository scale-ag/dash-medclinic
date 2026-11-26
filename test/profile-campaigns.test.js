import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withProfileCampaigns } from '../src/node/profile-campaigns.js';

const accounts = [{id:'3', instagram_profiles:{aa:'ailton',tt:'taisa'}}];
function fixture(destination, goal, profiles, cta = false) {
  return {campaigns:{c:{name:'Post'}},adsets:{s:{account_id:'3',campaign_id:'c',destination_type:destination,optimization_goal:goal}},
    ads:Object.fromEntries(profiles.map((profile,i)=>[i,{account_id:'3',campaign_id:'c',adset_id:'s',instagram_user_id:profile,profile_cta:cta}]))};
}
function mapped(snapshot, campaigns = {}) {
  return withProfileCampaigns(snapshot,{campaigns},accounts).campaigns.c;
}
test('perfil confirmado da CA03 e destinos legados de visita ao perfil',()=>{
  assert.equal(mapped(fixture('INSTAGRAM_PROFILE','AUTOMATIC_OBJECTIVE',['aa'])).adsets.s.doctor,'ailton');
  assert.equal(mapped(fixture('UNDEFINED','VISIT_INSTAGRAM_PROFILE',['tt'])).adsets.s.accept_destination_type,'UNDEFINED');
  assert.equal(mapped(fixture('UNDEFINED','AUTOMATIC_OBJECTIVE',['tt'],true)).adsets.s.doctor,'taisa');
});
test('perfil misto, perfil desconhecido e intenção de outro funil ficam fora da atribuição',()=>{
  for (const profiles of [['aa','tt'],['aa',null],['institucional']])
    assert.equal(mapped(fixture('INSTAGRAM_PROFILE','AUTOMATIC_OBJECTIVE',profiles)),undefined);
  assert.equal(mapped(fixture('UNDEFINED','AUTOMATIC_OBJECTIVE',['aa'])),undefined);
  assert.equal(mapped(fixture('WHATSAPP','CONVERSATIONS',['aa'],true)),undefined);
  const manual={doctor:'taisa',funnel:'whatsapp'};
  assert.deepEqual(mapped(fixture('INSTAGRAM_PROFILE','VISIT_INSTAGRAM_PROFILE',['aa']),{c:manual}),manual);
});
