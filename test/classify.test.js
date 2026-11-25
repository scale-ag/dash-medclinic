import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, CATEGORY, validateCampaignMap } from '../src/shared/classify.js';
import { buildModel, mappedCampaignsFor, viewRows, findView } from '../src/shared/model.js';
import { makeSyntheticSnapshot } from './fixtures/synthetic.js';

const MAP = JSON.parse(readFileSync(new URL('../config/campaign-map.json', import.meta.url)));
const CA01 = '203811442663021';
const CA02 = '1530307658790959';
const WA = { id: '1', destination_type: 'WHATSAPP' };

test('mapa versionado é válido e restrito às contas da allowlist', () => {
  assert.ok(validateCampaignMap(MAP, { allowedAccountIds: [CA01, CA02] }));
  assert.throws(() => validateCampaignMap(MAP, { allowedAccountIds: [CA01] }), /fora da allowlist/);
  const bad = structuredClone(MAP);
  bad.campaigns['123456789'] = { account_id: CA01, doctor: 'fulano', funnel: 'whatsapp' };
  assert.throws(() => validateCampaignMap(bad), /médico desconhecido/);
  const badOverride = structuredClone(MAP);
  badOverride.adset_overrides['999999'] = { doctor: 'taisa', funnel: 'whatsapp' };
  assert.throws(() => validateCampaignMap(badOverride), /accept_destination_type/);
});

test('histórico da Taísa na CA01 é classificado pelo mapa explícito, não pela conta', () => {
  for (const id of ['120242361567150317', '120248339618150317']) {
    const c = classify({ campaignId: id, accountId: CA01, adset: WA }, MAP);
    assert.equal(c.category, CATEGORY.WHATSAPP);
    assert.equal(c.doctor, 'taisa', `${id} deve ser da Taísa mesmo estando na CA01 (conta do Ailton)`);
  }
  for (const id of ['120243388359980317', '120248374076630317', '120248471528140317']) {
    assert.equal(classify({ campaignId: id, accountId: CA01, adset: WA }, MAP).doctor, 'ailton');
  }
  assert.equal(classify({ campaignId: '120251418554480262', accountId: CA02, adset: WA }, MAP).doctor, 'taisa');
});

test('VideoView e LP/site ficam fora da captação, mesmo com destino WHATSAPP', () => {
  for (const id of ['120246982288180317', '120246982670850317', '120248258608230317', '120248334203780317']) {
    const c = classify({ campaignId: id, accountId: CA01, adset: WA }, MAP);
    assert.equal(c.category, CATEGORY.EXCLUIDO, id);
  }
});

test('destino misto, Messenger, Instagram Direct ou desconhecido não entram no WhatsApp', () => {
  const id = '120243388359980317';
  for (const dest of ['MESSAGING_INSTAGRAM_DIRECT_WHATSAPP', 'MESSAGING_MESSENGER_WHATSAPP', 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP', 'MESSENGER', 'INSTAGRAM_DIRECT', 'WEBSITE']) {
    const c = classify({ campaignId: id, accountId: CA01, adset: { id: '2', destination_type: dest } }, MAP);
    assert.equal(c.category, CATEGORY.NAO_CONCILIADO, dest);
  }
  assert.equal(classify({ campaignId: id, accountId: CA01, adset: { id: '3', destination_type: null } }, MAP).category, CATEGORY.NAO_CONCILIADO);
  assert.equal(classify({ campaignId: id, accountId: CA01, adset: undefined }, MAP).category, CATEGORY.NAO_CONCILIADO);
});

test('campanha fora do mapa é não classificada (sugestão só informativa) e campanha em conta errada não concilia', () => {
  const c = classify({ campaignId: '777777777777', accountId: CA02, adset: WA }, MAP);
  assert.equal(c.category, CATEGORY.NAO_CLASSIFICADO);
  assert.equal(c.doctor, null);
  assert.equal(c.suggestion, 'possível WhatsApp');
  const wrong = classify({ campaignId: '120251418554480262', accountId: CA01, adset: WA }, MAP);
  assert.equal(wrong.category, CATEGORY.NAO_CONCILIADO);
});

test('override manual por conjunto exige o destino exato registrado', () => {
  const map = structuredClone(MAP);
  map.adset_overrides['555555555'] = { doctor: 'taisa', funnel: 'whatsapp', accept_destination_type: 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP', note: 'conferido' };
  const ok = classify({ campaignId: '120248339618150317', accountId: CA01, adset: { id: '555555555', destination_type: 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP' } }, map);
  assert.equal(ok.category, CATEGORY.WHATSAPP);
  const changed = classify({ campaignId: '120248339618150317', accountId: CA01, adset: { id: '555555555', destination_type: 'MESSENGER' } }, map);
  assert.equal(changed.category, CATEGORY.NAO_CONCILIADO);
});

test('visões: nenhuma campanha de seguidores mapeada e seguidores incidentais do WhatsApp não contam', () => {
  const snap = makeSyntheticSnapshot();
  const model = buildModel(snap, MAP);
  for (const id of ['seguidores-ailton', 'seguidores-taisa']) {
    const view = findView(id);
    assert.deepEqual(mappedCampaignsFor(MAP, view), []);
    assert.equal(viewRows(model, view).length, 0);
  }
  const wa = viewRows(model, findView('whatsapp-taisa'));
  assert.ok(wa.some((r) => r.follows > 0), 'fixture tem seguidores incidentais em WhatsApp');
  // Campanhas sintéticas de destino INSTAGRAM_PROFILE fora do mapa continuam não classificadas.
  assert.ok(model.rows.filter((r) => r.destination_type === 'INSTAGRAM_PROFILE').every((r) => r.category === CATEGORY.NAO_CLASSIFICADO));
  // Nenhuma linha de VideoView/LP/misto aparece nas visões de WhatsApp.
  for (const id of ['whatsapp-taisa', 'whatsapp-ailton']) {
    assert.ok(viewRows(model, findView(id)).every((r) => r.category === CATEGORY.WHATSAPP && r.destination_type === 'WHATSAPP'));
  }
});
