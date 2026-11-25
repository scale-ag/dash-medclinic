#!/usr/bin/env node
// Validação final antes do portão de publicação. Falha se:
// - snapshot não for de produção (Meta) / estiver inconsistente / velho demais / sem linhas;
// - conciliação conta x anúncios estourar a tolerância;
// - qualquer credencial aparecer no site montado;
// - index.html usar caminhos absolutos (quebram o base path /dash-medclinic/).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/node/config.js';
import { accountReconciliation, scanForSecrets } from '../src/node/checks.js';
import { safeSummary, validateSnapshot } from '../src/node/snapshot.js';

const { values } = parseArgs({
  options: {
    dist: { type: 'string', default: 'dist' },
    'max-age-hours': { type: 'string', default: '6' },
    'allow-synthetic': { type: 'boolean', default: false },
  },
});

async function main() {
  const { accounts, dashboard } = await loadConfig();
  const problems = [];
  const snapshot = JSON.parse(await readFile(join(values.dist, 'data/snapshot.json'), 'utf8'));
  const mode = values['allow-synthetic'] ? 'any' : 'production';
  problems.push(...validateSnapshot(snapshot, { mode, expectedAccountIds: accounts.accounts.map((a) => a.id) }));
  if (mode === 'production') {
    if (snapshot.rows.length === 0) problems.push('snapshot sem nenhuma linha anúncio/dia — publicação de site vazio bloqueada');
    const ageH = (Date.now() - Date.parse(snapshot.generated_at)) / 3600000;
    if (!(ageH <= Number(values['max-age-hours']))) problems.push(`snapshot gerado há ${ageH.toFixed(1)} h (limite ${values['max-age-hours']} h)`);
    for (const r of accountReconciliation(snapshot, {
      maxAbsDiffBRL: dashboard.reconciliation.max_abs_diff_brl,
      maxRelDiff: dashboard.reconciliation.max_rel_diff,
    })) {
      if (!r.ok) problems.push(`${r.label}: soma dos anúncios difere do total da conta acima da tolerância — investigar antes de publicar`);
    }
  }
  const html = await readFile(join(values.dist, 'index.html'), 'utf8');
  if (/(src|href)=["']\/(?!\/)/.test(html)) problems.push('index.html usa caminho absoluto; use caminhos relativos para o base path /dash-medclinic/');
  const secrets = [process.env.META_ACCESS_TOKEN, process.env.CRON_GITHUB_TOKEN].filter(Boolean);
  for (const f of await scanForSecrets(values.dist, { exactSecrets: secrets })) problems.push(`possível credencial em ${f.file}: ${f.pattern}`);

  if (problems.length) {
    console.error(`[erro] Validação falhou:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`validação ok: ${JSON.stringify(safeSummary(snapshot))}`);
}

main().catch((e) => {
  console.error(`[erro] ${e.message}`);
  process.exitCode = 1;
});
