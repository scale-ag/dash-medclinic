import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildModel, buildTree, coverageSummary, dailySeries, doctorOutsideCost, filterOptions, filterRows, findView, reconciliation, viewRows } from '../src/shared/model.js';
import { CATEGORY } from '../src/shared/classify.js';
import { sumRows } from '../src/shared/metrics.js';
import { presetRange } from '../src/shared/dates.js';
import { csvText, toCsv, safeFilenamePart } from '../src/shared/csv.js';
import { makeSyntheticSnapshot } from './fixtures/synthetic.js';

const MAP = JSON.parse(readFileSync(new URL('../config/campaign-map.json', import.meta.url)));
const snap = makeSyntheticSnapshot();
const model = buildModel(snap, MAP);

test('filtro de datas é inclusivo nas duas pontas e vazio quando o período é vazio', () => {
  const range = { since: '2026-11-10', until: '2026-11-12' };
  const rows = filterRows(model.rows, { range });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.date >= '2026-11-10' && r.date <= '2026-11-12'));
  assert.ok(rows.some((r) => r.date === '2026-11-10') && rows.some((r) => r.date === '2026-11-12'));
  assert.deepEqual(filterRows(model.rows, { range: presetRange('month_to_yesterday', '2026-12-01') }), []);
});

test('filtros campanha -> conjunto -> anúncio em cascata', () => {
  const range = { since: '2026-11-01', until: '2026-11-24' };
  const view = findView('whatsapp-taisa');
  const scoped = filterRows(viewRows(model, view), { range });
  const opts = filterOptions(scoped, {});
  assert.ok(opts.campaigns.length >= 2);
  const cid = '120248339618150317';
  const o2 = filterOptions(scoped, { campaignId: cid });
  assert.ok(o2.adsets.every((s) => scoped.find((r) => r.adset_id === s.id).campaign_id === cid));
  const sid = o2.adsets[0].id;
  const rows = filterRows(scoped, { range, campaignId: cid, adsetId: sid });
  assert.ok(rows.length > 0 && rows.every((r) => r.adset_id === sid));
  // Conjunto misto da mesma campanha não está na visão WhatsApp.
  assert.ok(!o2.adsets.some((s) => s.id === '910000000000000302'));
});

test('série diária cobre todos os dias, marca hoje como parcial e soma igual ao total', () => {
  const range = { since: '2026-10-29', until: '2026-11-25' };
  const rows = filterRows(model.rows, { range });
  const pts = dailySeries(rows, range, { coveredDates: model.coveredDates, today: snap.today });
  assert.equal(pts.length, 28);
  assert.deepEqual(pts.slice(0, 3).map((p) => p.covered), [false, false, false]);
  assert.equal(pts.at(-1).partial, true);
  assert.equal(pts.reduce((s, p) => s + p.totals.spend_cents, 0), sumRows(rows).spend_cents);
  const cov = coverageSummary(model, range);
  assert.deepEqual(cov.missing, ['2026-10-29', '2026-10-30', '2026-10-31']);
});

test('conciliação: categorias somam o total, sem dupla contagem; WhatsApp por médico bate com as abas', () => {
  const range = { since: '2026-11-01', until: '2026-11-24' };
  const rows = filterRows(model.rows, { range });
  const rec = reconciliation(model, rows, range);
  const sumCats = Object.values(rec.byCategory).reduce((s, t) => s + t.spend_cents, 0);
  assert.equal(sumCats, sumRows(rows).spend_cents);
  for (const d of ['taisa', 'ailton']) {
    const tab = sumRows(filterRows(viewRows(model, findView(`whatsapp-${d}`)), { range }));
    assert.equal(rec.byDoctor[d].whatsapp.spend_cents, tab.spend_cents);
    assert.equal(rec.byDoctor[d].whatsapp.conversations, tab.conversations);
  }
  assert.ok(rec.pending.some((p) => p.category === CATEGORY.NAO_CLASSIFICADO && p.suggestion === 'possível WhatsApp'));
  assert.ok(rec.pending.some((p) => p.category === CATEGORY.NAO_CONCILIADO && p.destination_type === 'MESSENGER'));
  assert.equal(rec.excluded.length, 4);
  const ca01 = rec.accountCheck.find((a) => a.label === 'CA01');
  assert.equal(ca01.diff_cents, 37, 'diferença conta x anúncios exposta');
  const outside = doctorOutsideCost(model, 'taisa', range);
  assert.ok(outside.byCategory[CATEGORY.EXCLUIDO].spend_cents > 0);
  assert.ok(outside.byCategory[CATEGORY.NAO_CONCILIADO].spend_cents > 0);
});

test('árvore de drill-down soma igual às linhas em todos os níveis', () => {
  const rows = filterRows(viewRows(model, findView('whatsapp-ailton')), { range: { since: '2026-11-01', until: '2026-11-25' } });
  const tree = buildTree(rows);
  const total = sumRows(rows);
  assert.equal(tree.reduce((s, c) => s + c.totals.spend_cents, 0), total.spend_cents);
  for (const c of tree) {
    assert.equal(c.children.reduce((s, a) => s + a.totals.conversations, 0), c.totals.conversations);
    for (const a of c.children) assert.equal(a.children.reduce((s, x) => s + x.totals.impressions, 0), a.totals.impressions);
  }
});

test('CSV: proteção contra formula injection, separador ; e decimal com vírgula', () => {
  for (const evil of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd', '  =1+1', '＝1+1']) {
    assert.ok(csvText(evil).replace(/^"/, '').startsWith("'"), evil);
  }
  assert.equal(csvText('Campanha; "A"'), '"Campanha; ""A"""');
  assert.equal(csvText('normal'), 'normal');
  const csv = toCsv(
    [
      { header: 'nome', value: (r) => r.n },
      { header: 'gasto', type: 'number', value: (r) => r.v },
      { header: 'conv', type: 'integer', value: (r) => r.c },
    ],
    [{ n: '=cmd|"/c calc"!A1', v: 1234.5, c: null }],
  );
  assert.ok(csv.startsWith('﻿nome;gasto;conv\r\n'));
  assert.ok(csv.includes(`"'=cmd|""/c calc""!A1";1234,50;\r\n`));
  assert.equal(safeFilenamePart('WhatsApp Taísa/../x'), 'whatsapp-taisa-x');
});
