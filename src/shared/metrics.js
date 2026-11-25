// Agregação e métricas. Regras:
// - Valores monetários agregados SEMPRE em centavos brutos (sem imposto).
// - Imposto estimado aplicado uma única vez, em deriveMetrics(), sobre o total bruto.
// - Custos são razão dos totais do período (nunca média de custos diários).
// - Denominador zero => null ("não calculável"), nunca R$ 0.

const SPEND_RE = /^(\d+)(?:\.(\d+))?$/;

/** Converte o texto de `spend` da Meta ("12.34") em centavos inteiros, sem ponto flutuante. */
export function parseSpendToCents(value) {
  if (value === undefined || value === null || value === '') return 0;
  const s = typeof value === 'number' ? value.toFixed(6) : String(value).trim();
  const m = SPEND_RE.exec(s);
  if (!m) throw new Error(`Valor de gasto inválido: ${s.slice(0, 32)}`);
  const intPart = BigInt(m[1]);
  const frac = (m[2] || '').padEnd(3, '0');
  let cents = intPart * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n; // arredonda meio para cima na 3ª casa
  const n = Number(cents);
  if (!Number.isSafeInteger(n)) throw new Error('Gasto fora do intervalo seguro');
  return n;
}

/** Converte contagens da Meta ("123") em inteiro >= 0. */
export function parseCount(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Contagem inválida: ${String(value).slice(0, 32)}`);
  return Math.round(n);
}

export function emptyTotals() {
  return { spend_cents: 0, impressions: 0, link_clicks: 0, conversations: 0, follows: 0, rows: 0 };
}

export function addRowInto(totals, row) {
  totals.spend_cents += row.spend_cents || 0;
  totals.impressions += row.impressions || 0;
  totals.link_clicks += row.link_clicks || 0;
  totals.conversations += row.conversations || 0;
  totals.follows += row.follows || 0;
  totals.rows += 1;
  return totals;
}

export function sumRows(rows) {
  const t = emptyTotals();
  for (const r of rows) addRowInto(t, r);
  return t;
}

/** Fator de imposto a partir da fração líquida configurada (ex.: 0.8785 => 1/0.8785). */
export function taxFactorFromConfig(tax) {
  const share = Number(tax?.net_share);
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    throw new Error('tax.net_share deve estar em (0, 1]');
  }
  return 1 / share;
}

export function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/** Valor em BRL para exibição: bruto ou bruto × fator (uma única vez). */
export function spendBRL(spendCents, { taxEnabled, taxFactor }) {
  const gross = spendCents / 100;
  if (!taxEnabled) return gross;
  if (!Number.isFinite(taxFactor) || taxFactor < 1) throw new Error('Fator de imposto inválido');
  return gross * taxFactor;
}

/**
 * Métricas derivadas de um total bruto.
 * @param totals saída de sumRows (centavos brutos)
 * @param opts.result 'conversations' | 'follows' | null — qual contagem é o resultado do escopo
 */
export function deriveMetrics(totals, { taxEnabled = false, taxFactor = 1, result = null } = {}) {
  const spend = spendBRL(totals.spend_cents, { taxEnabled, taxFactor });
  const results = result === 'conversations' ? totals.conversations : result === 'follows' ? totals.follows : null;
  return {
    spend_gross: totals.spend_cents / 100,
    spend,
    tax_applied: Boolean(taxEnabled),
    impressions: totals.impressions,
    link_clicks: totals.link_clicks,
    results,
    cost_per_result: results === null ? null : ratio(spend, results),
    cpc: ratio(spend, totals.link_clicks),
    cpm: totals.impressions > 0 ? (spend / totals.impressions) * 1000 : null,
    ctr: totals.impressions > 0 ? (totals.link_clicks / totals.impressions) * 100 : null,
  };
}

/** Agrupa linhas por chave e soma. */
export function groupSum(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    let t = map.get(k);
    if (!t) {
      t = emptyTotals();
      map.set(k, t);
    }
    addRowInto(t, r);
  }
  return map;
}
