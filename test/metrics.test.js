import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveMetrics, parseSpendToCents, spendBRL, sumRows, taxFactorFromConfig } from '../src/shared/metrics.js';

const TAX = { net_share: 0.8785 };

test('gasto da Meta convertido em centavos sem ponto flutuante', () => {
  assert.equal(parseSpendToCents('12.34'), 1234);
  assert.equal(parseSpendToCents('0.1'), 10);
  assert.equal(parseSpendToCents('5'), 500);
  assert.equal(parseSpendToCents('1.005'), 101);
  assert.equal(parseSpendToCents('1.004'), 100);
  assert.equal(parseSpendToCents(undefined), 0);
  assert.throws(() => parseSpendToCents('-1'));
  assert.throws(() => parseSpendToCents('abc'));
  // 0.1 + 0.2 em centavos é exato
  assert.equal(parseSpendToCents('0.1') + parseSpendToCents('0.2'), 30);
});

test('fator de imposto = 1/0,8785 (≈ 1,138303927), não 1,13806', () => {
  const f = taxFactorFromConfig(TAX);
  assert.equal(f.toFixed(9), '1.138303927');
  assert.notEqual(f.toFixed(5), '1.13806');
  assert.throws(() => taxFactorFromConfig({ net_share: 0 }));
  assert.throws(() => taxFactorFromConfig({ net_share: 1.2 }));
});

test('imposto aplicado uma única vez e bruto preservado', () => {
  const f = taxFactorFromConfig(TAX);
  const totals = sumRows([{ spend_cents: 87850, impressions: 1000, link_clicks: 10, conversations: 10, follows: 0 }]);
  const on = deriveMetrics(totals, { taxEnabled: true, taxFactor: f, result: 'conversations' });
  const again = deriveMetrics(totals, { taxEnabled: true, taxFactor: f, result: 'conversations' });
  const off = deriveMetrics(totals, { taxEnabled: false, taxFactor: f, result: 'conversations' });
  assert.equal(on.spend_gross, 878.5);
  assert.ok(Math.abs(on.spend - 1000) < 1e-9, 'bruto 878,50 / 0,8785 = 1000,00');
  assert.equal(again.spend, on.spend, 'recalcular não compõe o imposto');
  assert.equal(totals.spend_cents, 87850, 'totais permanecem brutos');
  assert.equal(off.spend, 878.5);
  assert.ok(Math.abs(on.cost_per_result - 100) < 1e-9);
  assert.ok(Math.abs(on.cpm - 1000) < 1e-9);
  assert.ok(Math.abs(on.cpc - 100) < 1e-9);
  assert.equal(on.ctr, 1);
  assert.throws(() => spendBRL(100, { taxEnabled: true, taxFactor: 0.5 }));
});

test('denominador zero => não calculável (null), nunca R$ 0', () => {
  const m = deriveMetrics(sumRows([{ spend_cents: 5000, impressions: 0, link_clicks: 0, conversations: 0, follows: 0 }]), { result: 'conversations' });
  assert.equal(m.cost_per_result, null);
  assert.equal(m.cpc, null);
  assert.equal(m.cpm, null);
  assert.equal(m.ctr, null);
  const empty = deriveMetrics(sumRows([]), { result: 'follows' });
  assert.equal(empty.spend, 0);
  assert.equal(empty.cost_per_result, null);
});

test('custos são razão dos totais (ponderados), não média de custos diários', () => {
  const days = [
    { spend_cents: 10000, impressions: 1000, link_clicks: 10, conversations: 1, follows: 0 },
    { spend_cents: 10000, impressions: 9000, link_clicks: 90, conversations: 99, follows: 0 },
  ];
  const m = deriveMetrics(sumRows(days), { result: 'conversations' });
  assert.equal(m.cost_per_result, 2); // 200 / 100
  const meanOfDaily = (100 + 100 / 99) / 2;
  assert.notEqual(m.cost_per_result, meanOfDaily);
  assert.equal(m.ctr, 1); // 100 / 10000 * 100
  assert.equal(m.cpm, 20); // 200 / 10000 * 1000
});
