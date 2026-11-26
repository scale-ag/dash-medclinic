#!/usr/bin/env node
// Monta o site estático em --out a partir de um snapshot validado.
// Produção: só aceita snapshot kind=production da Meta. Sintético apenas com --allow-synthetic (preview/teste local).
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { withProfileCampaigns } from '../src/node/profile-campaigns.js';
import { loadConfig, ROOT } from '../src/node/config.js';
import { validateSnapshot, writeJsonAtomic } from '../src/node/snapshot.js';

const { values } = parseArgs({
  options: {
    snapshot: { type: 'string', default: '.work/snapshot.json' },
    out: { type: 'string', default: 'dist' },
    'allow-synthetic': { type: 'boolean', default: false },
  },
});

async function main() {
  const { accounts, campaignMap, dashboard } = await loadConfig();
  const snapshot = JSON.parse(await readFile(values.snapshot, 'utf8'));
  const mode = values['allow-synthetic'] ? 'any' : 'production';
  const errors = validateSnapshot(snapshot, { mode, expectedAccountIds: accounts.accounts.map((a) => a.id) });
  if (errors.length) throw new Error(`Snapshot inválido para build (${mode}):\n- ${errors.join('\n- ')}`);

  const out = values.out;
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'data'), { recursive: true });
  await cp(join(ROOT, 'src/web'), out, { recursive: true });
  await cp(join(ROOT, 'src/shared'), join(out, 'shared'), { recursive: true });

  const publicConfig = {
    campaign_map: withProfileCampaigns(snapshot, campaignMap, accounts.accounts),
    accounts: accounts.accounts.map((a) => ({ id: a.id, label: a.label, description: a.description })),
    tax: dashboard.tax,
    ui: dashboard.ui,
    reconciliation: dashboard.reconciliation,
    build: {
      built_at: new Date().toISOString(),
      commit: /^[0-9a-f]{7,40}$/.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : null,
    },
  };
  await writeJsonAtomic(join(out, 'data/config.json'), publicConfig);
  await writeJsonAtomic(join(out, 'data/snapshot.json'), snapshot);
  console.log(`build ok: ${out} (snapshot ${snapshot.kind}, ${snapshot.rows.length} linhas)`);
}

main().catch((e) => {
  console.error(`[erro] ${e.message}`);
  process.exitCode = 1;
});
