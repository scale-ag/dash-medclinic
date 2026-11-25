#!/usr/bin/env node
// Baixa o último snapshot PUBLICADO (site válido) para servir de base incremental.
// Nunca envia credenciais. Nunca falha o job: sem base válida, o coletor faz backfill completo.
import { parseArgs } from 'node:util';
import { writeJsonAtomic } from '../src/node/snapshot.js';

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string', default: '.work/base.json' } } });
const MAX_BYTES = 50 * 1024 * 1024;

async function main() {
  if (!values.url) return console.log('base: URL não informada; backfill completo.');
  const url = new URL(values.url);
  if (url.protocol !== 'https:') return console.log('base: URL deve ser https; ignorada.');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (!res.ok) return console.log(`base: HTTP ${res.status} (ainda não publicado?) — backfill completo.`);
    const text = await res.text();
    if (text.length > MAX_BYTES) return console.log('base: arquivo grande demais; ignorada.');
    const json = JSON.parse(text);
    if (json?.kind !== 'production') return console.log('base: não é snapshot de produção; ignorada.');
    await writeJsonAtomic(values.out, json);
    console.log(`base: snapshot publicado em ${json.generated_at} carregado.`);
  } catch (e) {
    console.log(`base: indisponível (${e.name}); backfill completo.`);
  } finally {
    clearTimeout(t);
  }
}
main();
