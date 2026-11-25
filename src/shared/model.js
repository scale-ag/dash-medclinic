// Modelo de dados do dashboard: junta linhas brutas (anúncio/dia) com dimensões e classificação.
import { classify, CATEGORY } from './classify.js';
import { eachDay } from './dates.js';
import { addRowInto, emptyTotals, sumRows } from './metrics.js';

export const VIEWS = Object.freeze([
  { id: 'geral', label: 'Geral', kind: 'overview' },
  { id: 'whatsapp-taisa', label: 'WhatsApp Taísa', kind: 'funnel', doctor: 'taisa', category: 'whatsapp', result: 'conversations' },
  { id: 'whatsapp-ailton', label: 'WhatsApp Ailton', kind: 'funnel', doctor: 'ailton', category: 'whatsapp', result: 'conversations' },
  { id: 'seguidores-ailton', label: 'Seguidores Ailton', kind: 'funnel', doctor: 'ailton', category: 'seguidores', result: 'follows' },
  { id: 'seguidores-taisa', label: 'Seguidores Taísa', kind: 'funnel', doctor: 'taisa', category: 'seguidores', result: 'follows' },
]);

export function findView(id) {
  return VIEWS.find((v) => v.id === id) || VIEWS[0];
}

/**
 * @param snapshot snapshot bruto (coletor)
 * @param map mapa de campanhas (config/campaign-map.json)
 */
export function buildModel(snapshot, map) {
  const accounts = new Map((snapshot.accounts || []).map((a) => [a.id, a]));
  const campaigns = snapshot.campaigns || {};
  const adsets = snapshot.adsets || {};
  const ads = snapshot.ads || {};
  const cache = new Map();

  const classifyKey = (accountId, campaignId, adsetId) => {
    const key = `${accountId}|${campaignId}|${adsetId}`;
    let c = cache.get(key);
    if (!c) {
      const meta = adsets[adsetId];
      c = classify({ campaignId, accountId, adset: meta ? { id: adsetId, ...meta } : undefined }, map);
      cache.set(key, c);
    }
    return c;
  };

  const rows = (snapshot.rows || []).map((r) => {
    const c = classifyKey(r.account_id, r.campaign_id, r.adset_id);
    return {
      ...r,
      account_label: accounts.get(r.account_id)?.label || r.account_id,
      campaign_name: campaigns[r.campaign_id]?.name || r.campaign_id,
      adset_name: adsets[r.adset_id]?.name || r.adset_id,
      ad_name: ads[r.ad_id]?.name || r.ad_id,
      category: c.category,
      doctor: c.doctor,
      funnel: c.funnel,
      destination_type: c.destination_type,
      reason: c.reason,
      suggestion: c.suggestion || null,
    };
  });

  // Dia coberto = coletado com sucesso em TODAS as contas configuradas (zero confirmado).
  const accountList = [...accounts.values()];
  const coveredDates = new Set();
  if (accountList.length) {
    const [first, ...rest] = accountList;
    for (const d of Object.keys(first.days || {})) {
      if (rest.every((a) => a.days && Object.prototype.hasOwnProperty.call(a.days, d))) coveredDates.add(d);
    }
  }

  return {
    snapshot,
    map,
    accounts: accountList,
    campaigns,
    adsets,
    ads,
    rows,
    coveredDates,
    classifyKey,
  };
}

export function viewRows(model, view) {
  if (view.kind === 'overview') return model.rows;
  return model.rows.filter((r) => r.category === view.category && r.doctor === view.doctor);
}

/** Existe alguma campanha explicitamente mapeada para este médico/funil? */
export function mappedCampaignsFor(map, view) {
  if (view.kind === 'overview') return [];
  return Object.entries(map.campaigns || {})
    .filter(([id, e]) => !id.startsWith('$') && e.doctor === view.doctor && e.funnel === view.category)
    .map(([id]) => id);
}

export function inRange(date, range) {
  if (!range || range.empty) return false;
  return date >= range.since && date <= range.until;
}

export function filterRows(rows, { range, campaignId, adsetId, adId } = {}) {
  if (!range || range.empty) return [];
  return rows.filter(
    (r) =>
      r.date >= range.since &&
      r.date <= range.until &&
      (!campaignId || r.campaign_id === campaignId) &&
      (!adsetId || r.adset_id === adsetId) &&
      (!adId || r.ad_id === adId),
  );
}

/** Opções em cascata (campanha -> conjunto -> anúncio) a partir das linhas da visão no período. */
export function filterOptions(rows, { campaignId, adsetId } = {}) {
  const camp = new Map();
  const adset = new Map();
  const ad = new Map();
  for (const r of rows) {
    camp.set(r.campaign_id, r.campaign_name);
    if (!campaignId || r.campaign_id === campaignId) adset.set(r.adset_id, r.adset_name);
    if ((!campaignId || r.campaign_id === campaignId) && (!adsetId || r.adset_id === adsetId)) ad.set(r.ad_id, r.ad_name);
  }
  const toList = (m) =>
    [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return { campaigns: toList(camp), adsets: toList(adset), ads: toList(ad) };
}

/**
 * Série diária completa no intervalo: dias sem coleta ficam `covered=false` (ausência),
 * dias coletados sem linhas ficam com totais zerados (zero confirmado).
 */
export function dailySeries(rows, range, { coveredDates, today }) {
  if (!range || range.empty) return [];
  const byDate = new Map();
  for (const r of rows) {
    let t = byDate.get(r.date);
    if (!t) {
      t = emptyTotals();
      byDate.set(r.date, t);
    }
    addRowInto(t, r);
  }
  return eachDay(range.since, range.until).map((date) => ({
    date,
    totals: byDate.get(date) || emptyTotals(),
    covered: coveredDates.has(date),
    partial: date === today,
  }));
}

/** Árvore campanha -> conjunto -> anúncio com totais. */
export function buildTree(rows) {
  const campaigns = new Map();
  for (const r of rows) {
    let c = campaigns.get(r.campaign_id);
    if (!c) {
      c = {
        level: 'campaign',
        id: r.campaign_id,
        name: r.campaign_name,
        account_label: r.account_label,
        totals: emptyTotals(),
        children: new Map(),
      };
      campaigns.set(r.campaign_id, c);
    }
    addRowInto(c.totals, r);
    let s = c.children.get(r.adset_id);
    if (!s) {
      s = {
        level: 'adset',
        id: r.adset_id,
        name: r.adset_name,
        destination_type: r.destination_type,
        category: r.category,
        reason: r.reason,
        totals: emptyTotals(),
        children: new Map(),
      };
      c.children.set(r.adset_id, s);
    }
    addRowInto(s.totals, r);
    let a = s.children.get(r.ad_id);
    if (!a) {
      a = { level: 'ad', id: r.ad_id, name: r.ad_name, totals: emptyTotals(), children: null };
      s.children.set(r.ad_id, a);
    }
    addRowInto(a.totals, r);
  }
  const finalize = (m) =>
    [...m.values()].map((n) => ({ ...n, children: n.children ? finalize(n.children) : null }));
  return finalize(campaigns);
}

/** Conciliação do período (visão Geral): categorias, pendências e conferência com o total da conta. */
export function reconciliation(model, rowsInRange, range) {
  const byCategory = {};
  for (const k of Object.values(CATEGORY)) byCategory[k] = emptyTotals();
  const byDoctor = {};
  const pending = new Map();
  const excluded = new Map();
  for (const r of rowsInRange) {
    addRowInto(byCategory[r.category], r);
    if (r.doctor) {
      byDoctor[r.doctor] ??= {};
      byDoctor[r.doctor][r.category] ??= emptyTotals();
      addRowInto(byDoctor[r.doctor][r.category], r);
    }
    if (r.category === CATEGORY.NAO_CONCILIADO || r.category === CATEGORY.NAO_CLASSIFICADO || r.category === CATEGORY.EXCLUIDO) {
      const target = r.category === CATEGORY.EXCLUIDO ? excluded : pending;
      const key = `${r.campaign_id}|${r.adset_id}`;
      let p = target.get(key);
      if (!p) {
        p = {
          account_label: r.account_label,
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
          campaign_objective: model.campaigns[r.campaign_id]?.objective || null,
          campaign_status: model.campaigns[r.campaign_id]?.effective_status || null,
          adset_id: r.adset_id,
          adset_name: r.adset_name,
          destination_type: r.destination_type,
          category: r.category,
          doctor: r.doctor,
          reason: r.reason,
          suggestion: r.suggestion,
          totals: emptyTotals(),
        };
        target.set(key, p);
      }
      addRowInto(p.totals, r);
    }
  }

  const accountCheck = model.accounts.map((a) => {
    let accountSpend = 0;
    let coveredDays = 0;
    for (const [d, info] of Object.entries(a.days || {})) {
      if (inRange(d, range)) {
        accountSpend += info.account_spend_cents || 0;
        coveredDays += 1;
      }
    }
    const adSpend = sumRows(rowsInRange.filter((r) => r.account_id === a.id)).spend_cents;
    return {
      account_id: a.id,
      label: a.label,
      account_spend_cents: accountSpend,
      ad_spend_cents: adSpend,
      diff_cents: accountSpend - adSpend,
      covered_days: coveredDays,
    };
  });

  const sortBySpend = (m) => [...m.values()].sort((x, y) => y.totals.spend_cents - x.totals.spend_cents);
  return { byCategory, byDoctor, pending: sortBySpend(pending), excluded: sortBySpend(excluded), accountCheck };
}

/** Linhas de uma visão de funil que ficaram de fora do custo (para avisar na aba do médico). */
export function doctorOutsideCost(model, doctor, range) {
  const t = emptyTotals();
  const byCat = {};
  for (const r of model.rows) {
    if (r.doctor !== doctor || !inRange(r.date, range)) continue;
    if (r.category === CATEGORY.EXCLUIDO || r.category === CATEGORY.NAO_CONCILIADO) {
      addRowInto(t, r);
      byCat[r.category] ??= emptyTotals();
      addRowInto(byCat[r.category], r);
    }
  }
  return { totals: t, byCategory: byCat };
}

export function coverageSummary(model, range) {
  if (!range || range.empty) return { totalDays: 0, coveredDays: 0, missing: [] };
  const days = eachDay(range.since, range.until);
  const missing = days.filter((d) => !model.coveredDates.has(d));
  return { totalDays: days.length, coveredDays: days.length - missing.length, missing };
}
