import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollect } from '../src/node/run-collect.js';
import { computeCollectionRange, dedupeRows, extractActionCount, parseFollowValue } from '../src/node/collector.js';
import { rowKey } from '../src/node/snapshot.js';
import { buildModel, dailySeries } from '../src/shared/model.js';
import { createLogger } from '../src/node/redact.js';
import { makeSyntheticSnapshot } from './fixtures/synthetic.js';
import { createFakeMeta, FAKE_TOKEN, jsonResponse } from './helpers/fake-meta.js';
import { readFileSync } from 'node:fs';

const MAP = JSON.parse(readFileSync(new URL('../config/campaign-map.json', import.meta.url)));
const NOW = new Date('2026-11-25T15:00:00Z'); // 12:00 em São Paulo
const ENV = { DATA_START: '2026-11-01', REPROCESS_DAYS: '7', WINDOW_DAYS: '7', META_API_VERSION: 'v25.0', META_APP_ID: '1234567890' };
const CA01 = '203811442663021';
const CA02 = '1530307658790959';

async function tmp() {
  return mkdtemp(join(tmpdir(), 'medclinic-'));
}

function stripVolatile(s) {
  return {
    rows: s.rows,
    days: s.accounts.map((a) => Object.fromEntries(Object.entries(a.days).map(([d, v]) => [d, { ...v, fetched_at: undefined }]))),
    campaigns: s.campaigns,
    adsets: s.adsets,
    ads: s.ads,
  };
}

function sortKey(rows) {
  return [...rows].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
}

async function collect(fake, extra = {}) {
  const dir = extra.dir || (await tmp());
  const out = join(dir, 'snapshot.json');
  const logs = [];
  const snapshot = await runCollect({
    token: FAKE_TOKEN,
    out,
    env: { ...ENV, ...(extra.env || {}) },
    fetchImpl: fake.fetchImpl,
    now: () => extra.now || NOW,
    sleep: async () => {},
    logger: createLogger({ secrets: [FAKE_TOKEN], write: (l) => logs.push(l) }),
    basePath: extra.basePath || null,
    fullBackfill: extra.fullBackfill || false,
  });
  return { snapshot, out, dir, logs };
}

test('backfill completo: linhas anúncio/dia idênticas à fonte, paginação completa, sem duplicatas', async () => {
  const src = makeSyntheticSnapshot();
  const fake = createFakeMeta(src, { pageSize: 7, leakTokenInNext: true });
  const { snapshot, logs } = await collect(fake);
  assert.equal(snapshot.kind, 'production');
  assert.equal(snapshot.collection.mode, 'full');
  assert.deepEqual(sortKey(snapshot.rows), sortKey(src.rows));
  assert.equal(new Set(snapshot.rows.map(rowKey)).size, snapshot.rows.length);
  assert.ok(fake.requests.filter((r) => r.url.includes('after=')).length > 10, 'várias páginas seguidas');
  // Segurança: só graph.facebook.com, token só no header, nunca na URL, inclusive nas páginas seguintes.
  assert.ok(fake.requests.every((r) => r.host === 'graph.facebook.com'));
  assert.ok(fake.requests.every((r) => !r.url.includes('access_token') && !r.url.includes(FAKE_TOKEN)));
  assert.ok(fake.requests.every((r) => r.headers.Authorization === `Bearer ${FAKE_TOKEN}` && r.redirect === 'error'));
  assert.ok(logs.every((l) => !l.includes(FAKE_TOKEN)));
  assert.ok(!JSON.stringify(snapshot).includes(FAKE_TOKEN));
  // Somente as duas contas da allowlist foram consultadas.
  const accounts = new Set(fake.requests.map((r) => /act_(\d+)/.exec(r.path)?.[1]).filter(Boolean));
  assert.deepEqual([...accounts].sort(), [CA02, CA01].sort());
  // Parâmetros de insights.
  const ins = new URL(fake.requests.find((r) => r.path.endsWith('/insights') && r.url.includes('level=ad')).url);
  assert.equal(ins.searchParams.get('time_increment'), '1');
  assert.equal(ins.searchParams.get('use_unified_attribution_setting'), 'true');
  assert.match(ins.searchParams.get('fields'), /instagram_profile_follow/);
  assert.match(ins.searchParams.get('fields'), /inline_link_clicks/);
  assert.ok(JSON.parse(ins.searchParams.get('filtering'))[0].value.includes('PAUSED'));
  // Versão solicitada x efetiva.
  assert.equal(snapshot.api.requested_version, 'v25.0');
  assert.deepEqual(snapshot.api.effective_versions, ['v27.0']);
  assert.equal(snapshot.api.app_id_verified, true);
  assert.equal(snapshot.api.conversation_action_type, 'onsite_conversion.messaging_conversation_started_7d');
  // Cobertura e timestamps reais por conta.
  for (const a of snapshot.accounts) {
    assert.deepEqual(a.coverage, { since: '2026-11-01', until: '2026-11-25' });
    assert.equal(Object.keys(a.days).length, 25);
    assert.equal(a.last_success_at, NOW.toISOString());
  }
  // Campanha pausada com gasto mantida.
  assert.ok(snapshot.rows.some((r) => r.campaign_id === '120242361567150317'));
  assert.equal(snapshot.campaigns['120242361567150317'].effective_status, 'PAUSED');
});

test('Messenger/primeira resposta/total de conexões nunca são contados como conversa', () => {
  const actions = [
    { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '3' },
    { action_type: 'onsite_conversion.total_messaging_connection', value: '10' },
    { action_type: 'onsite_conversion.messaging_first_reply', value: '8' },
  ];
  assert.equal(extractActionCount(actions, 'onsite_conversion.messaging_conversation_started_7d'), 3);
  assert.equal(extractActionCount(undefined, 'x'), 0);
  assert.equal(parseFollowValue('4'), 4);
  assert.equal(parseFollowValue([{ action_type: 'instagram_profile_follow', value: '2' }]), 2);
  assert.equal(parseFollowValue(undefined), 0);
});

test('idempotência: reexecutar sobre a própria base produz o mesmo resultado', async () => {
  const src = makeSyntheticSnapshot();
  const first = await collect(createFakeMeta(src));
  const second = await collect(createFakeMeta(src), { basePath: first.out });
  assert.equal(second.snapshot.collection.mode, 'incremental');
  assert.deepEqual(stripVolatile(second.snapshot), stripVolatile(first.snapshot));
  for (const a of second.snapshot.accounts) assert.deepEqual(a.recollected_range, { since: '2026-11-19', until: '2026-11-25', mode: 'incremental' });
  const third = await collect(createFakeMeta(src), { basePath: second.out });
  assert.deepEqual(stripVolatile(third.snapshot), stripVolatile(first.snapshot));
});

test('reprocessamento recente substitui a janela (revisão de atribuição) e preserva dias anteriores', async () => {
  const src = makeSyntheticSnapshot();
  const first = await collect(createFakeMeta(src));
  const fake = createFakeMeta(src);
  // Meta revisou a atribuição em 24/11 e um anúncio de 22/11 deixou de aparecer.
  const revised = fake.state.raw.find((r) => r.date_start === '2026-11-24' && r.account_id === CA01);
  revised.actions = [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '99' }];
  const removed = fake.state.raw.findIndex((r) => r.date_start === '2026-11-22' && r.account_id === CA02);
  const removedRow = fake.state.raw.splice(removed, 1)[0];
  // Dia fora da janela (05/11) alterado na fonte: NÃO deve ser recoletado.
  const old = fake.state.raw.find((r) => r.date_start === '2026-11-05');
  const oldOriginal = old.spend;
  old.spend = '9999.99';
  const second = await collect(fake, { basePath: first.out });
  const row = second.snapshot.rows.find((r) => r.ad_id === revised.ad_id && r.date === '2026-11-24');
  assert.equal(row.conversations, 99);
  assert.equal(second.snapshot.rows.some((r) => r.ad_id === removedRow.ad_id && r.date === '2026-11-22'), false);
  const kept = second.snapshot.rows.find((r) => r.ad_id === old.ad_id && r.date === '2026-11-05');
  assert.equal(kept.spend_cents, Math.round(Number(oldOriginal) * 100));
  // Backfill forçado recoleta tudo.
  const full = await collect(fake, { basePath: first.out, fullBackfill: true });
  assert.equal(full.snapshot.rows.find((r) => r.ad_id === old.ad_id && r.date === '2026-11-05').spend_cents, 999999);
});

test('lacuna entre base e hoje é preenchida mesmo além da janela de reprocessamento', async () => {
  const src = makeSyntheticSnapshot();
  const early = await collect(createFakeMeta(src), { now: new Date('2026-11-10T15:00:00Z') });
  assert.equal(early.snapshot.accounts[0].coverage.until, '2026-11-10');
  const later = await collect(createFakeMeta(src), { basePath: early.out });
  assert.deepEqual(later.snapshot.accounts[0].recollected_range, { since: '2026-11-10', until: '2026-11-25', mode: 'incremental' }, 'último dia da base (parcial) é recoletado');
  assert.deepEqual(sortKey(later.snapshot.rows), sortKey(src.rows));
});

test('zero confirmado é diferente de ausência de coleta', async () => {
  const src = makeSyntheticSnapshot();
  const { snapshot } = await collect(createFakeMeta(src));
  const ca02 = snapshot.accounts.find((a) => a.id === CA02);
  assert.ok(ca02.days['2026-11-04'], 'dia sem entrega foi consultado com sucesso');
  assert.equal(ca02.days['2026-11-04'].account_spend_cents, 0);
  assert.equal(snapshot.rows.filter((r) => r.account_id === CA02 && r.date === '2026-11-04').length, 0);
  const model = buildModel(snapshot, MAP);
  const pts = dailySeries(model.rows.filter((r) => r.account_id === CA02), { since: '2026-10-30', until: '2026-11-04' }, { coveredDates: model.coveredDates, today: snapshot.today });
  assert.deepEqual(pts.map((p) => p.covered), [false, false, true, true, true, true]);
  assert.equal(pts.at(-1).totals.spend_cents, 0);
});

test('falha parcial: nenhuma gravação, arquivo anterior preservado, sem temporários', async () => {
  const src = makeSyntheticSnapshot();
  const dir = await tmp();
  const out = join(dir, 'snapshot.json');
  await writeFile(out, '{"ultimo":"valido"}');
  const fake = createFakeMeta(src, {
    handler: (url) => (url.pathname.includes(`act_${CA02}/insights`) ? jsonResponse(500, { error: { message: 'boom', code: 2, is_transient: true } }) : undefined),
  });
  await assert.rejects(() => runCollect({ token: FAKE_TOKEN, out, env: ENV, fetchImpl: fake.fetchImpl, now: () => NOW, sleep: async () => {} }), /Falha na conta CA02/);
  assert.equal(await readFile(out, 'utf8'), '{"ultimo":"valido"}');
  assert.deepEqual(await readdir(dir), ['snapshot.json']);
  const retries = fake.requests.filter((r) => r.path.includes(`act_${CA02}/insights`)).length;
  assert.equal(retries, 5, 'retry limitado a 5 tentativas');
});

test('sem token: coleta não roda e nada é inventado', async () => {
  const dir = await tmp();
  await assert.rejects(() => runCollect({ token: '', out: join(dir, 's.json'), env: ENV }), /PENDENTES/);
  assert.deepEqual(await readdir(dir), []);
});

test('validações de conta: fuso, moeda e app do token', async () => {
  const src = makeSyntheticSnapshot();
  await assert.rejects(() => collect(createFakeMeta(src, { accountOverride: { [CA01]: { timezone_name: 'America/New_York' } } })), /fuso/);
  await assert.rejects(() => collect(createFakeMeta(src, { accountOverride: { [CA02]: { currency: 'USD' } } })), /moeda/);
  await assert.rejects(() => collect(createFakeMeta(src, { appId: '999' })), /META_APP_ID/);
  const warn = await collect(createFakeMeta(src, { accountOverride: { [CA01]: { business: { id: '111', name: 'x' } } } }));
  assert.match(warn.snapshot.accounts.find((a) => a.id === CA01).warnings[0], /business/);
});

test('conjunto arquivado fora da descoberta é buscado por ID e precisa ser da mesma conta', async () => {
  const src = makeSyntheticSnapshot();
  const hidden = '910000000000000302';
  const ok = await collect(createFakeMeta(src, { hiddenFromDiscovery: [hidden] }));
  assert.equal(ok.snapshot.adsets[hidden].destination_type, 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP');
  await assert.rejects(() => collect(createFakeMeta(src, { hiddenFromDiscovery: [hidden], adsetAccountOverride: { [hidden]: CA02 } })), /outra conta/);
});

test('janela grande demais é dividida automaticamente', async () => {
  const src = makeSyntheticSnapshot();
  const fake = createFakeMeta(src, {
    handler: (url) => {
      if (!url.pathname.endsWith('/insights') || url.searchParams.get('level') !== 'ad') return undefined;
      const tr = JSON.parse(url.searchParams.get('time_range'));
      return tr.since !== tr.until ? jsonResponse(400, { error: { message: 'Please reduce the amount of data you are asking for', code: 1 } }) : undefined;
    },
  });
  const { snapshot } = await collect(fake);
  assert.deepEqual(sortKey(snapshot.rows), sortKey(src.rows));
});

test('deduplicação por conta+anúncio+dia', () => {
  const r = { account_id: '1', date: '2026-11-01', campaign_id: '2', adset_id: '3', ad_id: '4', spend_cents: 1, impressions: 1, link_clicks: 0, conversations: 0, follows: 0 };
  assert.equal(dedupeRows([r, { ...r }]).rows.length, 1);
  assert.equal(dedupeRows([r, { ...r }]).duplicates, 1);
  assert.throws(() => dedupeRows([r, { ...r, spend_cents: 2 }]), /divergente/);
});

test('intervalo de coleta: backfill, incremental e limites', () => {
  const base = { coverage: { since: '2026-11-01', until: '2026-11-24' } };
  assert.deepEqual(computeCollectionRange({ dataStart: '2026-11-01', today: '2026-11-25', includeToday: true, reprocessDays: 28, baseAccount: base }), { since: '2026-11-01', until: '2026-11-25', mode: 'incremental' });
  assert.deepEqual(computeCollectionRange({ dataStart: '2026-11-01', today: '2026-11-25', includeToday: false, reprocessDays: 3, baseAccount: base }), { since: '2026-11-23', until: '2026-11-24', mode: 'incremental' });
  // Base de ontem com REPROCESS_DAYS=1: o dia parcial de ontem ainda é recoletado.
  assert.deepEqual(computeCollectionRange({ dataStart: '2026-11-01', today: '2026-11-25', includeToday: true, reprocessDays: 1, baseAccount: base }), { since: '2026-11-24', until: '2026-11-25', mode: 'incremental' });
  assert.deepEqual(computeCollectionRange({ dataStart: '2026-11-01', today: '2026-11-25', includeToday: true, reprocessDays: 3, baseAccount: null }), { since: '2026-11-01', until: '2026-11-25', mode: 'full' });
  assert.throws(() => computeCollectionRange({ dataStart: '2026-12-01', today: '2026-11-25', includeToday: true, reprocessDays: 3 }));
});
