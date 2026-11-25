import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { presetRange } from '../src/shared/dates.js';
import { deriveMetrics, sumRows, taxFactorFromConfig } from '../src/shared/metrics.js';
import { filterOptions, filterRows } from '../src/shared/model.js';

test('períodos da PRC incluem hoje e preservam os períodos fechados de relatório', () => {
  const today = '2026-11-02';
  for (const [id, since] of [['today',today],['rolling_3','2026-10-31'],['rolling_7','2026-10-27'],['rolling_14','2026-10-20'],['rolling_30','2026-10-04'],['this_month','2026-11-01'],['all','2026-09-08']]) {
    assert.deepEqual(presetRange(id,today,{dataStart:'2026-09-08'}), {since,until:today,empty:false,includesToday:true});
  }
  assert.equal(presetRange('last_7_complete',today).until,'2026-11-01');
});

test('o fator da MedClinic replica a PRC em gasto e custos ponderados, preservando cliques e CTR', () => {
  const config = JSON.parse(readFileSync(new URL('../config/dashboard.json', import.meta.url)));
  const taxFactor = taxFactorFromConfig(config.tax);
  assert.equal(taxFactor,1.1385);
  const totals = sumRows([{spend_cents:4000,impressions:600,link_clicks:5,conversations:1},
    {spend_cents:3538,impressions:2288,link_clicks:17,conversations:0}]);
  const calc = taxEnabled => deriveMetrics(totals,{taxFactor,taxEnabled,result:'conversations'});
  assert.equal(calc(true).spend.toFixed(2),'85.82');
  assert.equal(calc(false).spend.toFixed(2),'75.38');
  assert.equal(calc(true).ctr,calc(false).ctr);
  for (const key of ['cpc','cpm','cost_per_result']) assert.ok(Math.abs(calc(true)[key]-taxFactor*calc(false)[key]) < 1e-9);
});

test('seleções múltiplas de campanhas limitam os conjuntos, anúncios e resultados', () => {
  const rows = ['11','12','13'].map((campaign_id,i)=>({date:'2026-11-24', campaign_id, campaign_name:'Campanha '+i,adset_id:String(20+i),adset_name:'Conjunto '+i,ad_id:String(30+i),ad_name:'Ad '+i}));
  const filter = {campaignId:'11,12', range:{since:'2026-11-24',until:'2026-11-24'}};
  assert.deepEqual(filterRows(rows,filter).map(r=>r.adset_id), ['20','21']);
  assert.deepEqual(filterOptions(rows,{...filter,adsetId:'21'}).ads.map(a=>a.id),['31']);
});
