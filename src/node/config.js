// Carrega configuração versionada + sobrescritas por variáveis de ambiente (sem segredos).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertIsoDate, assertTimeZone } from '../shared/dates.js';
import { validateCampaignMap } from '../shared/classify.js';
import { taxFactorFromConfig } from '../shared/metrics.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readJson(rel) {
  return JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
}

function intFromEnv(env, name, fallback, { min = 1, max = 400 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} deve ser inteiro entre ${min} e ${max}`);
  return n;
}

export async function loadConfig(env = process.env) {
  const accounts = await readJson('config/accounts.json');
  const campaignMap = await readJson('config/campaign-map.json');
  const dashboard = await readJson('config/dashboard.json');
  assertTimeZone(accounts.expected_timezone);
  if (accounts.expected_timezone !== 'America/Sao_Paulo') throw new Error('expected_timezone deve ser America/Sao_Paulo');
  if (accounts.expected_currency !== 'BRL') throw new Error('expected_currency deve ser BRL');
  const ids = accounts.accounts.map((a) => a.id);
  if (new Set(ids).size !== ids.length) throw new Error('contas duplicadas na allowlist');
  validateCampaignMap(campaignMap, { allowedAccountIds: ids });
  taxFactorFromConfig(dashboard.tax);

  const dataStart = assertIsoDate(env.DATA_START || dashboard.data_start, 'DATA_START');
  const options = {
    dataStart,
    reprocessDays: intFromEnv(env, 'REPROCESS_DAYS', dashboard.reprocess_days),
    windowDays: intFromEnv(env, 'WINDOW_DAYS', dashboard.window_days, { max: 31 }),
    apiVersion: env.META_API_VERSION || dashboard.meta_api_version,
    appId: env.META_APP_ID ? String(env.META_APP_ID).trim() : null,
    fullBackfill: env.FULL_BACKFILL === 'true',
    includeToday: env.INCLUDE_TODAY !== 'false',
  };
  if (options.appId && !/^\d{5,25}$/.test(options.appId)) throw new Error('META_APP_ID inválido');
  return { accounts, campaignMap, dashboard, options };
}
