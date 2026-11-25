// Coletor Meta Marketing API (somente leitura): anúncio/dia, paginação completa, janelas controladas,
// backfill inicial e reprocessamento recente idempotente. Qualquer falha em qualquer conta interrompe
// a coleta inteira (nenhum snapshot parcial/vazio é gravado; o último site publicado é preservado).
import { addDays, assertIsoDate, dateInTimeZone, eachDay, maxDate, minDate, splitWindows } from '../shared/dates.js';
import { parseCount, parseSpendToCents } from '../shared/metrics.js';
import { MetaApiError } from './meta-client.js';
import { evaluateBase, KIND_PRODUCTION, rowKey, SCHEMA_VERSION, SOURCE_META } from './snapshot.js';
import { silentLogger } from './redact.js';

const CAMPAIGN_FIELDS = 'id,name,objective,status,effective_status,buying_type';
const ADSET_FIELDS = 'id,name,campaign_id,destination_type,optimization_goal,billing_event,attribution_spec,status,effective_status';

export class CollectionError extends Error {
  constructor(message, { account = null, cause = null } = {}) {
    super(message);
    this.name = 'CollectionError';
    this.account = account;
    this.cause = cause;
  }
}

/** Lê o campo de seguidores, aceitando número/texto ou lista de {action_type, value}. */
export function parseFollowValue(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (Array.isArray(value)) return value.reduce((acc, a) => acc + parseCount(a?.value), 0);
  if (typeof value === 'object') return parseCount(value.value);
  return parseCount(value);
}

/** Soma apenas o action_type configurado (nunca total_messaging_connection / first_reply). */
export function extractActionCount(actions, actionType) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) if (a?.action_type === actionType) total += parseCount(a.value);
  return total;
}

export function insightsFields(cfg) {
  return [
    'account_id',
    'campaign_id',
    'campaign_name',
    'adset_id',
    'adset_name',
    'ad_id',
    'ad_name',
    'date_start',
    'date_stop',
    'spend',
    'impressions',
    'inline_link_clicks',
    'actions',
    cfg.follow_field,
  ].join(',');
}

export function insightsParams(cfg, range) {
  const p = {
    level: 'ad',
    time_increment: 1,
    time_range: { since: range.since, until: range.until },
    fields: insightsFields(cfg),
    limit: cfg.page_limit || 500,
  };
  if (cfg.use_unified_attribution_setting) p.use_unified_attribution_setting = true;
  if (cfg.action_report_time) p.action_report_time = cfg.action_report_time;
  if (Array.isArray(cfg.ad_effective_status_filter) && cfg.ad_effective_status_filter.length) {
    p.filtering = [{ field: 'ad.effective_status', operator: 'IN', value: cfg.ad_effective_status_filter }];
  }
  return p;
}

export function accountDailyParams(range) {
  return {
    level: 'account',
    time_increment: 1,
    time_range: { since: range.since, until: range.until },
    fields: 'account_id,date_start,date_stop,spend,impressions',
    limit: 500,
  };
}

/** Converte uma linha bruta de insights em linha normalizada (inteiros, sem flutuante). */
export function normalizeInsightRow(raw, { accountId, range, cfg }) {
  if (String(raw.account_id) !== accountId) {
    throw new CollectionError(`Linha de insights de outra conta recebida na consulta da conta ${accountId}`);
  }
  if (raw.date_start !== raw.date_stop) throw new CollectionError('Linha de insights não diária (time_increment=1 esperado)');
  const date = assertIsoDate(raw.date_start, 'date_start');
  if (date < range.since || date > range.until) throw new CollectionError(`Linha fora da janela solicitada (${date})`);
  for (const f of ['campaign_id', 'adset_id', 'ad_id']) {
    if (!/^\d{1,25}$/.test(String(raw[f] || ''))) throw new CollectionError(`Linha sem ${f} válido`);
  }
  return {
    account_id: accountId,
    date,
    campaign_id: String(raw.campaign_id),
    adset_id: String(raw.adset_id),
    ad_id: String(raw.ad_id),
    spend_cents: parseSpendToCents(raw.spend),
    impressions: parseCount(raw.impressions),
    link_clicks: parseCount(raw.inline_link_clicks),
    conversations: extractActionCount(raw.actions, cfg.conversation_action_type),
    follows: parseFollowValue(raw[cfg.follow_field]),
  };
}

function sameRow(a, b) {
  return ['campaign_id', 'adset_id', 'spend_cents', 'impressions', 'link_clicks', 'conversations', 'follows'].every((k) => a[k] === b[k]);
}

/** Deduplica por conta+anúncio+dia. Duplicata idêntica é descartada; divergente é erro de integridade. */
export function dedupeRows(rows) {
  const map = new Map();
  let duplicates = 0;
  for (const r of rows) {
    const k = rowKey(r);
    const prev = map.get(k);
    if (prev) {
      if (!sameRow(prev, r)) throw new CollectionError(`Duplicata divergente para a chave conta+anúncio+dia (${r.date})`);
      duplicates += 1;
      continue;
    }
    map.set(k, r);
  }
  return { rows: [...map.values()], duplicates };
}

export function sortRows(rows) {
  return rows.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.account_id.localeCompare(b.account_id) || a.campaign_id.localeCompare(b.campaign_id) || a.adset_id.localeCompare(b.adset_id) || a.ad_id.localeCompare(b.ad_id),
  );
}

/** Janela de recoleta de uma conta. */
export function computeCollectionRange({ dataStart, today, includeToday, reprocessDays, baseAccount, fullBackfill }) {
  const until = includeToday ? today : addDays(today, -1);
  if (until < dataStart) throw new CollectionError(`DATA_START (${dataStart}) é posterior ao último dia coletável (${until})`);
  if (!baseAccount || fullBackfill) return { since: dataStart, until, mode: 'full' };
  const reprocessStart = addDays(today, -(reprocessDays - 1));
  // O último dia da base é sempre recoletado: ele pode ter sido gravado como dia parcial ("hoje").
  const lastBaseDay = baseAccount.coverage.until;
  const since = maxDate(dataStart, minDate(reprocessStart, lastBaseDay));
  return { since: minDate(since, until), until, mode: 'incremental' };
}

async function fetchInsightsAdaptive(client, path, paramsFor, range, logger) {
  try {
    return await client.getAll(path, paramsFor(range));
  } catch (e) {
    if (e instanceof MetaApiError && e.kind === 'data_volume' && range.since < range.until) {
      const days = eachDay(range.since, range.until);
      const mid = days[Math.floor(days.length / 2) - 1];
      logger.warn(`janela ${range.since}..${range.until} muito grande; dividindo`);
      const a = await fetchInsightsAdaptive(client, path, paramsFor, { since: range.since, until: mid }, logger);
      const b = await fetchInsightsAdaptive(client, path, paramsFor, { since: addDays(mid, 1), until: range.until }, logger);
      return [...a, ...b];
    }
    throw e;
  }
}

/**
 * Coleta uma conta. Retorna apenas o que foi recoletado na janela (o merge com a base é feito depois).
 */
export async function collectAccount({ client, account, cfg, range, expected, now, logger }) {
  const id = account.id;
  const info = await client.get(`act_${id}`, { fields: 'id,account_id,name,currency,timezone_name,account_status,business{id,name}' });
  if (String(info.account_id || '') !== id) throw new CollectionError(`Resposta da conta ${account.label} com account_id inesperado`);
  if (info.currency !== expected.currency) throw new CollectionError(`Conta ${account.label}: moeda ${info.currency} != ${expected.currency}`);
  if (info.timezone_name !== expected.timezone) throw new CollectionError(`Conta ${account.label}: fuso ${info.timezone_name} != ${expected.timezone}`);
  const warnings = [];
  const businessId = info.business?.id ? String(info.business.id) : null;
  if (expected.businessId && businessId !== expected.businessId) {
    warnings.push(`business da conta (${businessId || 'não informado'}) difere do esperado (${expected.businessId}); pode ser conta compartilhada — conferir`);
  }

  const campaignsList = await client.getAll(`act_${id}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: 200 });
  const adsetsList = await client.getAll(`act_${id}/adsets`, { fields: ADSET_FIELDS, limit: 200 });
  const campaigns = {};
  for (const c of campaignsList) campaigns[String(c.id)] = pickCampaign(c, id);
  const adsets = {};
  for (const s of adsetsList) adsets[String(s.id)] = pickAdset(s, id);

  const windows = splitWindows(range.since, range.until, cfg.window_days);
  const rawRows = [];
  const days = {};
  const ads = {};
  const campaignNames = new Map();
  const adsetNames = new Map();
  for (const w of windows) {
    const adRaw = await fetchInsightsAdaptive(client, `act_${id}/insights`, (r) => insightsParams(cfg, r), w, logger);
    for (const raw of adRaw) {
      const row = normalizeInsightRow(raw, { accountId: id, range: w, cfg });
      rawRows.push(row);
      ads[row.ad_id] = { account_id: id, campaign_id: row.campaign_id, adset_id: row.adset_id, name: String(raw.ad_name ?? row.ad_id) };
      if (raw.campaign_name) campaignNames.set(row.campaign_id, String(raw.campaign_name));
      if (raw.adset_name) adsetNames.set(row.adset_id, String(raw.adset_name));
    }
    const accRaw = await client.getAll(`act_${id}/insights`, accountDailyParams(w));
    const fetchedAt = now().toISOString();
    const accByDate = new Map();
    for (const a of accRaw) {
      if (String(a.account_id) !== id) throw new CollectionError(`Total diário de outra conta recebido (${account.label})`);
      if (a.date_start !== a.date_stop) throw new CollectionError('Total de conta não diário');
      accByDate.set(a.date_start, { spend_cents: parseSpendToCents(a.spend), impressions: parseCount(a.impressions) });
    }
    for (const d of eachDay(w.since, w.until)) {
      const acc = accByDate.get(d);
      // Janela consultada com sucesso: ausência de linha = zero confirmado.
      days[d] = { fetched_at: fetchedAt, account_spend_cents: acc?.spend_cents ?? 0, account_impressions: acc?.impressions ?? 0 };
    }
    logger.info(`${account.label}: janela ${w.since}..${w.until} coletada (${adRaw.length} linhas anúncio/dia)`);
  }
  const { rows, duplicates } = dedupeRows(rawRows);
  if (duplicates) logger.warn(`${account.label}: ${duplicates} linha(s) duplicada(s) idêntica(s) descartada(s)`);

  // Objetos que aparecem no insights mas não na descoberta (ex.: arquivados/excluídos): busca por ID
  // e confirma que pertencem à MESMA conta antes de aceitar.
  const missingCampaigns = [...new Set(rows.map((r) => r.campaign_id))].filter((cid) => !campaigns[cid]);
  const missingAdsets = [...new Set(rows.map((r) => r.adset_id))].filter((sid) => !adsets[sid]);
  if (missingCampaigns.length) {
    const got = await client.getByIds(missingCampaigns, `${CAMPAIGN_FIELDS},account_id`);
    for (const cid of missingCampaigns) {
      const c = got[cid];
      if (c && String(c.account_id) !== id) throw new CollectionError(`Campanha ${cid} pertence a outra conta`);
      campaigns[cid] = c ? pickCampaign(c, id) : { account_id: id, name: campaignNames.get(cid) || cid, objective: null, status: null, effective_status: null, buying_type: null };
    }
  }
  if (missingAdsets.length) {
    const got = await client.getByIds(missingAdsets, `${ADSET_FIELDS},account_id`);
    for (const sid of missingAdsets) {
      const s = got[sid];
      if (s && String(s.account_id) !== id) throw new CollectionError(`Conjunto ${sid} pertence a outra conta`);
      // Sem metadados => destination_type null => classificação "não conciliado" (nunca entra no custo).
      adsets[sid] = s ? pickAdset(s, id) : { ...pickAdset({ name: adsetNames.get(sid) || sid }, id), campaign_id: rows.find((r) => r.adset_id === sid)?.campaign_id || '' };
    }
  }
  for (const [cid, n] of campaignNames) if (campaigns[cid] && !campaigns[cid].name) campaigns[cid].name = n;
  for (const [sid, n] of adsetNames) if (adsets[sid] && !adsets[sid].name) adsets[sid].name = n;

  return {
    info,
    warnings,
    campaigns,
    adsets,
    ads,
    rows,
    days,
    discovered: { campaigns: campaignsList.length, adsets: adsetsList.length },
    fetched: { missing_campaigns: missingCampaigns.length, missing_adsets: missingAdsets.length },
  };
}

function pickCampaign(c, accountId) {
  return {
    account_id: accountId,
    name: String(c.name ?? ''),
    objective: c.objective ?? null,
    status: c.status ?? null,
    effective_status: c.effective_status ?? null,
    buying_type: c.buying_type ?? null,
  };
}

function pickAdset(s, accountId) {
  return {
    account_id: accountId,
    campaign_id: String(s.campaign_id ?? ''),
    name: String(s.name ?? ''),
    destination_type: s.destination_type ?? null,
    optimization_goal: s.optimization_goal ?? null,
    billing_event: s.billing_event ?? null,
    attribution_spec: Array.isArray(s.attribution_spec)
      ? s.attribution_spec.map((a) => ({ event_type: a.event_type ?? null, window_days: a.window_days ?? null }))
      : null,
    status: s.status ?? null,
    effective_status: s.effective_status ?? null,
  };
}

export { pickAdset, pickCampaign };

/**
 * Orquestra a coleta das contas da allowlist e mescla com a base (snapshot anterior válido).
 * Retorna o snapshot completo OU lança erro — nunca retorna snapshot parcial.
 */
export async function collectSnapshot({
  client,
  accountsConfig,
  insightsConfig,
  options,
  base = null,
  now = () => new Date(),
  logger = silentLogger,
}) {
  const startedAt = now().toISOString();
  const tz = accountsConfig.expected_timezone;
  const today = dateInTimeZone(now(), tz);
  const dataStart = assertIsoDate(options.dataStart, 'DATA_START');
  const reprocessDays = options.reprocessDays;
  if (!Number.isInteger(reprocessDays) || reprocessDays < 1) throw new CollectionError('REPROCESS_DAYS deve ser inteiro >= 1');
  const cfg = { ...insightsConfig, window_days: options.windowDays };
  const accountIds = accountsConfig.accounts.map((a) => a.id);

  // Confere se o token pertence ao app esperado (somente leitura).
  let appIdVerified = null;
  if (options.appId) {
    const app = await client.get('app', { fields: 'id' });
    if (String(app?.id) !== String(options.appId)) {
      throw new CollectionError('O token não pertence ao META_APP_ID configurado. Verifique o secret/variável (não use tokens de outros projetos).');
    }
    appIdVerified = true;
  } else {
    logger.warn('META_APP_ID não definido: verificação do app do token não realizada');
  }

  const baseEval = evaluateBase(base, { accountIds, dataStart, timezone: tz });
  const usableBase = baseEval.usable && !options.fullBackfill ? base : null;
  logger.info(`base incremental: ${usableBase ? 'snapshot anterior válido' : `não usada (${options.fullBackfill ? 'backfill completo solicitado' : baseEval.reason})`}`);

  const results = [];
  for (const account of accountsConfig.accounts) {
    const baseAccount = usableBase?.accounts.find((a) => a.id === account.id) || null;
    const range = computeCollectionRange({
      dataStart,
      today,
      includeToday: options.includeToday !== false,
      reprocessDays,
      baseAccount,
      fullBackfill: Boolean(options.fullBackfill),
    });
    logger.info(`${account.label}: coletando ${range.since}..${range.until} (${range.mode})`);
    try {
      const r = await collectAccount({
        client,
        account,
        cfg,
        range,
        expected: { currency: accountsConfig.expected_currency, timezone: tz, businessId: accountsConfig.business_id },
        now,
        logger,
      });
      results.push({ account, baseAccount, range, ...r, last_success_at: now().toISOString() });
    } catch (e) {
      throw new CollectionError(`Falha na conta ${account.label}: ${e.message}`, { account: account.label, cause: e });
    }
  }

  // Merge: dias anteriores à janela vêm da base; a janela recoletada substitui integralmente a base.
  const rows = [];
  const campaigns = {};
  const adsets = {};
  const ads = {};
  if (usableBase) {
    Object.assign(campaigns, usableBase.campaigns || {});
    Object.assign(adsets, usableBase.adsets || {});
    Object.assign(ads, usableBase.ads || {});
  }
  const accounts = [];
  for (const r of results) {
    const id = r.account.id;
    const baseRows = r.baseAccount ? usableBase.rows.filter((x) => x.account_id === id && x.date >= dataStart && x.date < r.range.since) : [];
    const baseDays = {};
    if (r.baseAccount) {
      for (const [d, v] of Object.entries(r.baseAccount.days || {})) if (d >= dataStart && d < r.range.since) baseDays[d] = v;
    }
    const merged = dedupeRows([...baseRows, ...r.rows]);
    rows.push(...merged.rows);
    const days = { ...baseDays, ...r.days };
    const missing = eachDay(dataStart, r.range.until).filter((d) => !days[d]);
    if (missing.length) throw new CollectionError(`Conta ${r.account.label}: ${missing.length} dia(s) sem cobertura após merge`);
    Object.assign(campaigns, r.campaigns);
    Object.assign(adsets, r.adsets);
    Object.assign(ads, r.ads);
    accounts.push({
      id,
      label: r.account.label,
      name: String(r.info.name ?? ''),
      currency: r.info.currency,
      timezone_name: r.info.timezone_name,
      account_status: r.info.account_status ?? null,
      business_id: r.info.business?.id ? String(r.info.business.id) : null,
      warnings: r.warnings,
      last_success_at: r.last_success_at,
      coverage: { since: dataStart, until: r.range.until },
      recollected_range: { since: r.range.since, until: r.range.until, mode: r.range.mode },
      discovered: r.discovered,
      fetched_by_id: r.fetched,
      days: Object.fromEntries(Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1))),
    });
  }

  // Mantém só dimensões úteis: tudo que foi descoberto agora + o que as linhas referenciam.
  const referenced = { c: new Set(rows.map((r) => r.campaign_id)), s: new Set(rows.map((r) => r.adset_id)), a: new Set(rows.map((r) => r.ad_id)) };
  const fresh = { c: new Set(results.flatMap((r) => Object.keys(r.campaigns))), s: new Set(results.flatMap((r) => Object.keys(r.adsets))) };
  const prune = (obj, keep) => Object.fromEntries(Object.entries(obj).filter(([k]) => keep(k)).sort(([a], [b]) => a.localeCompare(b)));

  return {
    schema_version: SCHEMA_VERSION,
    kind: KIND_PRODUCTION,
    source: SOURCE_META,
    generated_at: now().toISOString(),
    timezone: tz,
    currency: accountsConfig.expected_currency,
    data_start: dataStart,
    today,
    today_is_partial: options.includeToday !== false,
    api: {
      requested_version: options.apiVersion,
      effective_versions: [...client.effectiveVersions].sort(),
      app_id_verified: appIdVerified,
      use_unified_attribution_setting: Boolean(cfg.use_unified_attribution_setting),
      action_report_time: cfg.action_report_time || null,
      attribution_rule: cfg.use_unified_attribution_setting
        ? 'use_unified_attribution_setting=true: resultados pela configuração de atribuição de cada conjunto (mesmo comportamento do Gerenciador de Anúncios); attribution_spec de cada conjunto registrado em adsets.'
        : 'Atribuição padrão da API (sem use_unified_attribution_setting).',
      conversation_action_type: cfg.conversation_action_type,
      follow_field: cfg.follow_field,
      ad_effective_status_filter: cfg.ad_effective_status_filter || null,
      level: 'ad',
      time_increment: 1,
    },
    collection: {
      mode: usableBase ? 'incremental' : 'full',
      base_reason: usableBase ? 'ok' : options.fullBackfill ? 'backfill completo solicitado' : baseEval.reason,
      base_generated_at: usableBase?.generated_at || null,
      reprocess_days: reprocessDays,
      window_days: cfg.window_days,
      started_at: startedAt,
      finished_at: now().toISOString(),
      requests: client.stats?.requests ?? null,
      retries: client.stats?.retries ?? null,
      pages: client.stats?.pages ?? null,
    },
    accounts,
    campaigns: prune(campaigns, (k) => referenced.c.has(k) || fresh.c.has(k)),
    adsets: prune(adsets, (k) => referenced.s.has(k) || fresh.s.has(k)),
    ads: prune(ads, (k) => referenced.a.has(k)),
    rows: sortRows(rows),
  };
}
