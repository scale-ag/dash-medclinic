// Execução da coleta real com gravação atômica. Usado pelo CLI (scripts/collect.mjs) e pelos testes.
import { loadConfig } from './config.js';
import { createMetaClient } from './meta-client.js';
import { collectSnapshot } from './collector.js';
import { readJsonIfExists, validateSnapshot, writeJsonAtomic } from './snapshot.js';

/**
 * Coleta, valida e grava o snapshot. Em qualquer falha lança erro e NÃO grava nada
 * (arquivo anterior em `out` permanece intacto).
 */
export async function runCollect({ token, out, basePath = null, fullBackfill = false, env = process.env, fetchImpl = globalThis.fetch, now, sleep, logger, clientOptions = {} }) {
  if (!token) {
    throw new Error('META_ACCESS_TOKEN não definido. Cadastre o secret do repositório; sem ele a coleta real e a implantação ficam PENDENTES (nenhum dado é inventado).');
  }
  const { accounts, dashboard, options } = await loadConfig(env);
  if (fullBackfill) options.fullBackfill = true;
  const accountIds = accounts.accounts.map((a) => a.id);
  const client = createMetaClient({ token, apiVersion: options.apiVersion, allowedAccountIds: accountIds, fetchImpl, logger, ...(sleep ? { sleep } : {}), ...clientOptions });
  let base = null;
  if (basePath) {
    try {
      base = await readJsonIfExists(basePath);
    } catch (e) {
      logger?.warn?.(`base ignorada: ${e.message}`);
    }
  }
  const snapshot = await collectSnapshot({
    client,
    accountsConfig: accounts,
    insightsConfig: dashboard.insights,
    options,
    base,
    logger,
    ...(now ? { now } : {}),
  });
  const errors = validateSnapshot(snapshot, { mode: 'production', expectedAccountIds: accountIds });
  if (errors.length) throw new Error(`Snapshot coletado inválido:\n- ${errors.join('\n- ')}`);
  await writeJsonAtomic(out, snapshot);
  return snapshot;
}
