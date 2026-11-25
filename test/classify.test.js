import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, CATEGORY, validateCampaignMap } from '../src/shared/classify.js';
import { buildModel, mappedCampaignsFor, viewRows, findView, identifiedCampaigns, pendingDoctorAdsets } from '../src/shared/model.js';
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
  const legacy = structuredClone(MAP);
  legacy.adset_overrides = { 999999: { doctor: 'taisa', funnel: 'whatsapp' } };
  assert.throws(() => validateCampaignMap(legacy), /adset_overrides não é mais suportado/);
  const mixedWithDoctor = structuredClone(MAP);
  mixedWithDoctor.campaigns['120236975999600317'].doctor = 'taisa';
  assert.throws(() => validateCampaignMap(mixedWithDoctor), /doctor null/);
  const noNote = structuredClone(MAP);
  delete noNote.campaigns['120236975999600317'].adsets['120236975999730317'].note;
  assert.throws(() => validateCampaignMap(noNote), /note obrigatório/);
  const badState = structuredClone(MAP);
  badState.campaigns['120243388359980317'].validation = 'ok';
  assert.throws(() => validateCampaignMap(badState), /validation/);
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
  for (const id of ['120251418554480262', '120251528556640262', '120251521306570262', '120251418123510262']) {
    assert.equal(classify({ campaignId: id, accountId: CA02, adset: WA }, MAP).doctor, 'taisa', id);
  }
});

test('otimização LINK_CLICKS com destino WHATSAPP entra no gasto WhatsApp; resultado segue sendo só conversas', () => {
  const c = classify({ campaignId: '120251521306570262', accountId: CA02, adset: { id: '9', destination_type: 'WHATSAPP', optimization_goal: 'LINK_CLICKS' } }, MAP);
  assert.equal(c.category, CATEGORY.WHATSAPP);
  const model = buildModel(makeSyntheticSnapshot(), MAP);
  const rows = viewRows(model, findView('whatsapp-taisa')).filter((r) => r.campaign_id === '120251521306570262');
  assert.ok(rows.length > 0 && rows.every((r) => r.optimization_goal === 'LINK_CLICKS'));
  const clicks = rows.reduce((a, r) => a + r.link_clicks, 0);
  const conv = rows.reduce((a, r) => a + r.conversations, 0);
  assert.ok(clicks > conv, 'cliques não viram resultado');
});

test('campanha MISTA POR MÉDICO: médico vem do conjunto; conjunto a confirmar fica fora de qualquer custo', () => {
  const IG = (id) => ({ id, destination_type: 'INSTAGRAM_PROFILE' });
  const taisa = classify({ campaignId: '120236975999600317', accountId: CA01, adset: IG('120236975999730317') }, MAP);
  assert.equal(taisa.category, CATEGORY.SEGUIDORES);
  assert.equal(taisa.doctor, 'taisa');
  const dr = classify({ campaignId: '120236975999600317', accountId: CA01, adset: IG('120236995354460317') }, MAP);
  assert.equal(dr.category, CATEGORY.SEGUIDORES, 'conjunto “DR” confirmado como Dr. Ailton');
  assert.equal(dr.doctor, 'ailton');
  const unknown = classify({ campaignId: '120236975999600317', accountId: CA01, adset: IG('123456789012') }, MAP);
  assert.equal(unknown.category, CATEGORY.NAO_CONCILIADO);
  assert.equal(unknown.doctor, null, 'campanha inteira nunca é atribuída a um médico');
  // Conjunto com médico ainda a confirmar (doctor: null) fica fora de qualquer custo.
  const pendingMap = structuredClone(MAP);
  pendingMap.campaigns['120236975999600317'].adsets['120236995354460317'].doctor = null;
  const pend = classify({ campaignId: '120236975999600317', accountId: CA01, adset: IG('120236995354460317') }, pendingMap);
  assert.equal(pend.category, CATEGORY.NAO_CONCILIADO);
  assert.equal(pend.doctor_pending, true);
  const hist = classify({ campaignId: '120242435400470317', accountId: CA01, adset: IG('120243833203900317') }, MAP);
  assert.equal(hist.category, CATEGORY.SEGUIDORES);
  assert.equal(hist.doctor, 'taisa');
  // Antigas de perfil Instagram sem médico explícito continuam não classificadas.
  assert.equal(classify({ campaignId: '900000000000000003', accountId: CA01, adset: IG('910000000000009003') }, MAP).category, CATEGORY.NAO_CLASSIFICADO);
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

test('conciliação manual por conjunto exige o destino exato registrado', () => {
  const map = structuredClone(MAP);
  map.campaigns['120248339618150317'].adsets = { 555555555: { accept_destination_type: 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP', note: 'conferido' } };
  const ok = classify({ campaignId: '120248339618150317', accountId: CA01, adset: { id: '555555555', destination_type: 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP' } }, map);
  assert.equal(ok.category, CATEGORY.WHATSAPP);
  assert.equal(ok.doctor, 'taisa');
  assert.equal(ok.manual_override, true);
  const changed = classify({ campaignId: '120248339618150317', accountId: CA01, adset: { id: '555555555', destination_type: 'MESSENGER' } }, map);
  assert.equal(changed.category, CATEGORY.NAO_CONCILIADO);
  const other = classify({ campaignId: '120248339618150317', accountId: CA01, adset: { id: '666666666', destination_type: 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP' } }, map);
  assert.equal(other.category, CATEGORY.NAO_CONCILIADO, 'só o conjunto conferido é aceito');
});

test('visões de seguidores: identificada sem veiculação ≠ inexistente; incidentais do WhatsApp não contam', () => {
  const snap = makeSyntheticSnapshot();
  const model = buildModel(snap, MAP);
  const range = { since: '2026-11-01', until: '2026-11-24' };
  const taisa = findView('seguidores-taisa');
  assert.deepEqual(mappedCampaignsFor(MAP, taisa).sort(), ['120236975999600317', '120242435400470317']);
  assert.equal(viewRows(model, taisa).length, 0, 'sem veiculação no período');
  const ident = identifiedCampaigns(model, taisa, range);
  assert.equal(ident.length, 2);
  assert.ok(ident.every((c) => c.delivered === false && c.totals.spend_cents === 0 && c.discovered));
  const mixed = ident.find((c) => c.id === '120236975999600317');
  assert.equal(mixed.doctor_scope, 'adset');
  assert.deepEqual(mixed.adsets.map((a) => a.id), ['120236975999730317'], 'apenas o conjunto da Taísa');
  const ailton = findView('seguidores-ailton');
  assert.deepEqual(mappedCampaignsFor(MAP, ailton), ['120236975999600317'], 'Ailton tem campanha histórica identificada (conjunto “DR”)');
  const identA = identifiedCampaigns(model, ailton, range);
  assert.equal(identA.length, 1);
  assert.equal(identA[0].delivered, false, 'identificada, sem veiculação no período');
  assert.deepEqual(identA[0].adsets.map((a) => a.id), ['120236995354460317'], 'apenas o conjunto do Ailton');
  assert.deepEqual(pendingDoctorAdsets(model, ailton), [], 'nenhum conjunto aguardando médico');
  const pendingMap = structuredClone(MAP);
  pendingMap.campaigns['120236975999600317'].adsets['120236995354460317'].doctor = null;
  const pm = buildModel(snap, pendingMap);
  assert.deepEqual(mappedCampaignsFor(pendingMap, ailton), [], 'médico a confirmar não vira campanha de ninguém');
  assert.deepEqual(pendingDoctorAdsets(pm, ailton).map((p) => p.adset_id), ['120236995354460317']);
  const wa = viewRows(model, findView('whatsapp-taisa'));
  assert.ok(wa.some((r) => r.follows > 0), 'fixture tem seguidores incidentais em WhatsApp');
  assert.ok(model.rows.filter((r) => r.category === CATEGORY.SEGUIDORES).every((r) => r.funnel === 'seguidores'));
  // Nenhuma linha de VideoView/LP/fora do mapa aparece nas visões de WhatsApp.
  for (const id of ['whatsapp-taisa', 'whatsapp-ailton']) {
    assert.ok(viewRows(model, findView(id)).every((r) => r.category === CATEGORY.WHATSAPP && r.destination_type === 'WHATSAPP'));
  }
});
