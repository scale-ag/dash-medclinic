// Esquema, validação e persistência do snapshot. O snapshot nunca contém credenciais.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { eachDay, isIsoDate } from '../shared/dates.js';

export const SCHEMA_VERSION = 1;
export const KIND_PRODUCTION = 'production';
export const KIND_SYNTHETIC = 'synthetic-test';
export const SOURCE_META = 'meta_marketing_api';

const NUMERIC_FIELDS = ['spend_cents', 'impressions', 'link_clicks', 'conversations', 'follows'];
const ID_RE = /^\d{1,25}$/;

export function rowKey(r) {
  return `${r.account_id}|${r.ad_id}|${r.date}`;
}

/**
 * Valida estrutura e consistência. Retorna lista de erros (vazia = válido).
 * @param mode 'production' exige dados reais da Meta; 'any' aceita sintético (somente testes/preview).
 */
export function validateSnapshot(s, { mode = 'production', expectedAccountIds = null } = {}) {
  const errors = [];
  const push = (m) => {
    if (errors.length < 50) errors.push(m);
  };
  if (!s || typeof s !== 'object') return ['snapshot ausente ou não é objeto'];
  if (s.schema_version !== SCHEMA_VERSION) push(`schema_version ${s.schema_version} != ${SCHEMA_VERSION}`);
  if (mode === 'production') {
    if (s.kind !== KIND_PRODUCTION) push(`kind "${s.kind}" não é produção — dados sintéticos nunca são publicados`);
    if (s.source !== SOURCE_META) push(`source "${s.source}" não é a Meta Marketing API`);
  } else if (![KIND_PRODUCTION, KIND_SYNTHETIC].includes(s.kind)) push(`kind inválido: ${s.kind}`);
  if (s.timezone !== 'America/Sao_Paulo') push(`timezone ${s.timezone} != America/Sao_Paulo`);
  if (s.currency !== 'BRL') push(`currency ${s.currency} != BRL`);
  if (!isIsoDate(s.data_start)) push('data_start inválida');
  if (!isIsoDate(s.today)) push('today inválido');
  if (!s.generated_at || Number.isNaN(Date.parse(s.generated_at))) push('generated_at inválido');
  if (!Array.isArray(s.accounts) || s.accounts.length === 0) push('nenhuma conta no snapshot');
  if (!Array.isArray(s.rows)) push('rows ausente');
  if (errors.length) return errors;

  const accounts = new Map();
  for (const a of s.accounts) {
    accounts.set(a.id, a);
    if (!ID_RE.test(a.id || '')) push(`conta com id inválido`);
    if (a.currency !== 'BRL') push(`conta ${a.label}: moeda ${a.currency} != BRL`);
    if (a.timezone_name !== 'America/Sao_Paulo') push(`conta ${a.label}: fuso ${a.timezone_name} != America/Sao_Paulo`);
    if (!a.last_success_at || Number.isNaN(Date.parse(a.last_success_at))) push(`conta ${a.label}: last_success_at inválido`);
    const cov = a.coverage || {};
    if (cov.since !== s.data_start) push(`conta ${a.label}: cobertura não começa em DATA_START`);
    if (!isIsoDate(cov.until) || cov.until < cov.since) push(`conta ${a.label}: cobertura inválida`);
    else {
      const days = a.days || {};
      const expected = eachDay(cov.since, cov.until);
      const missing = expected.filter((d) => !days[d]);
      if (missing.length) push(`conta ${a.label}: ${missing.length} dia(s) sem coleta dentro da cobertura`);
      const extra = Object.keys(days).filter((d) => d < cov.since || d > cov.until);
      if (extra.length) push(`conta ${a.label}: dias fora da cobertura`);
      for (const [d, info] of Object.entries(days)) {
        if (!Number.isSafeInteger(info.account_spend_cents) || info.account_spend_cents < 0) push(`conta ${a.label} ${d}: account_spend_cents inválido`);
      }
    }
  }
  if (expectedAccountIds) {
    const got = [...accounts.keys()].sort().join(',');
    const want = [...expectedAccountIds].sort().join(',');
    if (got !== want) push(`contas do snapshot (${got}) diferem da allowlist (${want})`);
  }
  const keys = new Set();
  for (const r of s.rows) {
    const a = accounts.get(r.account_id);
    if (!a) {
      push(`linha de conta desconhecida`);
      continue;
    }
    if (!isIsoDate(r.date) || r.date < a.coverage.since || r.date > a.coverage.until) push(`linha fora da cobertura (${a.label} ${r.date})`);
    for (const f of ['campaign_id', 'adset_id', 'ad_id']) if (!ID_RE.test(r[f] || '')) push(`linha com ${f} inválido`);
    for (const f of NUMERIC_FIELDS) {
      if (!Number.isSafeInteger(r[f]) || r[f] < 0) push(`linha ${a.label} ${r.date}: ${f} inválido`);
    }
    const k = rowKey(r);
    if (keys.has(k)) push(`linha duplicada (conta+anúncio+dia)`);
    keys.add(k);
  }
  return errors;
}

/** Decide se um snapshot anterior pode servir de base incremental. */
export function evaluateBase(base, { accountIds, dataStart, timezone }) {
  if (!base) return { usable: false, reason: 'nenhum snapshot anterior' };
  const errors = validateSnapshot(base, { mode: 'production', expectedAccountIds: accountIds });
  if (errors.length) return { usable: false, reason: `snapshot anterior inválido (${errors[0]})` };
  if (base.data_start !== dataStart) return { usable: false, reason: 'DATA_START mudou' };
  if (base.timezone !== timezone) return { usable: false, reason: 'fuso mudou' };
  return { usable: true, reason: 'ok' };
}

export async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`Falha ao ler ${path}: ${e.message}`);
  }
}

/** Escrita atômica: grava em arquivo temporário e renomeia. Nunca deixa arquivo parcial. */
export async function writeJsonAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(data)}\n`, 'utf8');
  await rename(tmp, path);
}

/** Resumo sem valores monetários (seguro para logs públicos de Actions). */
export function safeSummary(s) {
  return {
    kind: s.kind,
    generated_at: s.generated_at,
    data_start: s.data_start,
    today: s.today,
    api_requested: s.api?.requested_version,
    api_effective: s.api?.effective_versions,
    mode: s.collection?.mode,
    rows: s.rows.length,
    campaigns: Object.keys(s.campaigns || {}).length,
    adsets: Object.keys(s.adsets || {}).length,
    ads: Object.keys(s.ads || {}).length,
    accounts: s.accounts.map((a) => ({
      label: a.label,
      coverage: `${a.coverage.since}..${a.coverage.until}`,
      days: Object.keys(a.days || {}).length,
      last_success_at: a.last_success_at,
      recollected: a.recollected_range ? `${a.recollected_range.since}..${a.recollected_range.until}` : null,
    })),
  };
}

