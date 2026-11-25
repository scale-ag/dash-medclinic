#!/usr/bin/env node
// Coleta real (somente leitura) da Meta Marketing API.
// Uso: META_ACCESS_TOKEN=... node scripts/collect.mjs --out .work/snapshot.json [--base .work/base.json] [--full-backfill]
// O token é lido SOMENTE da variável de ambiente; nunca de argumento, arquivo versionado ou URL.
// Em falha: código de saída != 0 e NENHUM arquivo é gravado (o último snapshot/site válido é preservado).
import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { runCollect } from '../src/node/run-collect.js';
import { createLogger, redact } from '../src/node/redact.js';
import { safeSummary } from '../src/node/snapshot.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: '.work/snapshot.json' },
    base: { type: 'string' },
    'full-backfill': { type: 'boolean', default: false },
  },
});

const token = process.env.META_ACCESS_TOKEN || '';
const logger = createLogger({ secrets: [token] });

async function main() {
  const snapshot = await runCollect({ token, out: values.out, basePath: values.base, fullBackfill: values['full-backfill'], logger });
  const summary = safeSummary(snapshot);
  if (summary.api_effective.length && !summary.api_effective.includes(summary.api_requested)) {
    logger.warn(`versão solicitada ${summary.api_requested} difere da efetiva (${summary.api_effective.join(', ')}) informada pelo header facebook-api-version`);
  }
  for (const a of snapshot.accounts) for (const w of a.warnings || []) logger.warn(`${a.label}: ${w}`);
  // Resumo SEM valores monetários (logs de Actions de repositório público são públicos).
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '### Coleta Meta (somente leitura)',
      `- Modo: ${summary.mode} · linhas anúncio/dia: ${summary.rows} · campanhas: ${summary.campaigns} · conjuntos: ${summary.adsets}`,
      `- API solicitada: ${summary.api_requested} · efetiva: ${summary.api_effective.join(', ') || 'n/d'}`,
      ...summary.accounts.map((a) => `- ${a.label}: cobertura ${a.coverage}, recoletado ${a.recollected}, sucesso em ${a.last_success_at}`),
      '- Valores monetários não são exibidos no log (repositório público).',
    ];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
}

main().catch((e) => {
  logger.error(redact(e?.message || String(e), [token]));
  process.exitCode = 1;
});
