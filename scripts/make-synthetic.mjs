#!/usr/bin/env node
// Gera snapshot SINTÉTICO (kind=synthetic-test) apenas para preview local/testes de UI.
// Nunca usado no workflow de deploy; build de produção e validação o rejeitam.
import { parseArgs } from 'node:util';
import { dateInTimeZone } from '../src/shared/dates.js';
import { writeJsonAtomic } from '../src/node/snapshot.js';
import { makeSyntheticSnapshot } from '../test/fixtures/synthetic.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: '.work/synthetic-snapshot.json' },
    today: { type: 'string' },
    'data-start': { type: 'string', default: '2026-11-01' },
  },
});
const now = new Date();
const today = values.today || dateInTimeZone(now, 'America/Sao_Paulo');
const snap = makeSyntheticSnapshot({ today, dataStart: values['data-start'], generatedAt: new Date(now.getTime() - 25 * 60000).toISOString() });
await writeJsonAtomic(values.out, snap);
console.log(`snapshot SINTÉTICO gravado em ${values.out} (${snap.rows.length} linhas) — não publicar`);
