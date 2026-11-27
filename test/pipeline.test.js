// Pipeline: build, validação pré-publicação, portão de aprovação, varredura de segredos e regras do workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { accountReconciliation, scanForSecrets } from '../src/node/checks.js';
import { validateSnapshot, evaluateBase } from '../src/node/snapshot.js';
import { makeSyntheticSnapshot } from './fixtures/synthetic.js';
import { FAKE_TOKEN } from './helpers/fake-meta.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url)); // compatível com Windows (URL.pathname gera C:\\C:\\)

async function node(args, env = {}) {
  try {
    const r = await run(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH, ...env } });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    return { code: e.code, out: (e.stdout || '') + (e.stderr || '') };
  }
}

async function syntheticDist() {
  const dir = await mkdtemp(join(tmpdir(), 'medclinic-dist-'));
  const snapPath = join(dir, 'snap.json');
  await writeFile(snapPath, JSON.stringify(makeSyntheticSnapshot()));
  const out = join(dir, 'dist');
  const r = await node(['scripts/build.mjs', '--snapshot', snapPath, '--out', out, '--allow-synthetic']);
  assert.equal(r.code, 0, r.out);
  return { dir, snapPath, out };
}

test('build de produção recusa snapshot sintético; validação de produção também', async () => {
  const { snapPath, out, dir } = await syntheticDist();
  const prod = await node(['scripts/build.mjs', '--snapshot', snapPath, '--out', join(dir, 'prod')]);
  assert.notEqual(prod.code, 0);
  assert.match(prod.out, /sintéticos nunca são publicados/);
  const val = await node(['scripts/validate-dist.mjs', '--dist', out]);
  assert.notEqual(val.code, 0);
  assert.match(val.out, /não é produção/);
});

test('site montado não contém credenciais nem acesso à API; caminhos relativos ao base path', async () => {
  const { out } = await syntheticDist();
  assert.deepEqual(await scanForSecrets(out, { exactSecrets: [FAKE_TOKEN] }), []);
  const files = (await readdir(out, { recursive: true })).map((f) => f.split(sep).join('/')); // separador '/' também no Windows
  for (const f of files.filter((x) => /\.(js|html|json|css)$/.test(x))) {
    const text = await readFile(join(out, f), 'utf8');
    assert.ok(!/graph\.facebook\.com|META_ACCESS_TOKEN|Authorization/.test(text), `${f} não deve falar com a API nem citar credenciais`);
  }
  const html = await readFile(join(out, 'index.html'), 'utf8');
  assert.ok(!/(src|href)="\//.test(html), 'sem caminhos absolutos');
  assert.match(html, /Content-Security-Policy/);
  assert.ok(files.includes('data/snapshot.json') && files.includes('data/config.json') && files.includes('shared/model.js'));
  // Validação local (modo sintético) passa.
  const val = await node(['scripts/validate-dist.mjs', '--dist', out, '--allow-synthetic']);
  assert.equal(val.code, 0, val.out);
});

test('validação bloqueia publicação se um token aparecer no site', async () => {
  const { out } = await syntheticDist();
  await writeFile(join(out, 'vazamento.txt'), `config ${FAKE_TOKEN}`);
  const val = await node(['scripts/validate-dist.mjs', '--dist', out, '--allow-synthetic'], { META_ACCESS_TOKEN: FAKE_TOKEN });
  assert.notEqual(val.code, 0);
  assert.match(val.out, /possível credencial em vazamento\.txt/);
  assert.ok(!val.out.includes(FAKE_TOKEN), 'a mensagem de erro não repete o token');
});

test('portão PUBLIC_DATA_APPROVED: só "true" libera', async () => {
  for (const v of [undefined, '', 'false', 'TRUE', 'yes', '1']) {
    const env = v === undefined ? {} : { PUBLIC_DATA_APPROVED: v };
    const r = await node(['scripts/publish-gate.mjs'], env);
    assert.equal(r.code, 1, `valor ${v}`);
    assert.match(r.out, /Publicação bloqueada/);
  }
  assert.equal((await node(['scripts/publish-gate.mjs'], { PUBLIC_DATA_APPROVED: 'true' })).code, 0);
});

test('coleta sem secret falha com mensagem clara (implantação pendente) e não grava nada', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'medclinic-nosecret-'));
  const r = await node(['scripts/collect.mjs', '--out', join(dir, 's.json')]);
  assert.equal(r.code, 1);
  assert.match(r.out, /META_ACCESS_TOKEN não definido/);
  assert.deepEqual(await readdir(dir), []);
});

test('validação de snapshot: produção exige Meta, BRL, fuso, cobertura contínua e sem duplicatas', () => {
  const s = makeSyntheticSnapshot();
  const prodLike = { ...structuredClone(s), kind: 'production', source: 'meta_marketing_api' };
  assert.deepEqual(validateSnapshot(prodLike, { mode: 'production' }), []);
  const dup = structuredClone(prodLike);
  dup.rows.push({ ...dup.rows[0] });
  assert.ok(validateSnapshot(dup).some((e) => /duplicada/.test(e)));
  const gap = structuredClone(prodLike);
  delete gap.accounts[0].days['2026-11-10'];
  assert.ok(validateSnapshot(gap).some((e) => /sem coleta dentro da cobertura/.test(e)));
  const usd = structuredClone(prodLike);
  usd.accounts[1].currency = 'USD';
  assert.ok(validateSnapshot(usd).some((e) => /USD/.test(e)));
  const neg = structuredClone(prodLike);
  neg.rows[0].spend_cents = -1;
  assert.ok(validateSnapshot(neg).some((e) => /spend_cents/.test(e)));
  assert.equal(evaluateBase(s, { accountIds: s.accounts.map((a) => a.id), dataStart: s.data_start, timezone: s.timezone }).usable, false, 'base sintética nunca vira base de produção');
  assert.equal(evaluateBase(prodLike, { accountIds: prodLike.accounts.map((a) => a.id), dataStart: '2026-10-01', timezone: 'America/Sao_Paulo' }).reason, 'DATA_START mudou');
});

test('conciliação conta x anúncios com tolerância', () => {
  const s = makeSyntheticSnapshot();
  const ok = accountReconciliation(s, { maxAbsDiffBRL: 1, maxRelDiff: 0 });
  assert.ok(ok.every((r) => r.ok));
  const bad = accountReconciliation(s, { maxAbsDiffBRL: 0.1, maxRelDiff: 0 });
  assert.equal(bad.find((r) => r.label === 'CA01').ok, false);
});

test('workflow de deploy: permissões mínimas, ações fixadas por SHA, portão antes do upload, secrets só na coleta', () => {
  // Normaliza CRLF -> LF (checkout no Windows com core.autocrlf) antes das regex multilinha.
  const readLf = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const y = readLf('.github/workflows/deploy.yml');
  const ci = readLf('.github/workflows/ci.yml');
  for (const text of [y, ci]) {
    const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    assert.ok(uses.length > 0);
    for (const u of uses) assert.match(u, /^actions\/[a-z-]+@[0-9a-f]{40}$/, `ação não fixada por SHA: ${u}`);
    assert.ok(!/pull_request_target/.test(text));
    // Nenhuma interpolação de expressão dentro de scripts run: (evita injeção).
    const runBlocks = [...text.matchAll(/run:\s*\|?\n?([\s\S]*?)(?=\n\s*-\s|\n\s{2}\w|\n\w|$)/g)].map((m) => m[1]);
    for (const b of runBlocks) assert.ok(!b.includes('${{'), `expressão em run: ${b.slice(0, 60)}`);
  }
  assert.match(y, /^permissions: \{\}$/m);
  assert.match(y, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:/m);
  assert.match(y, /schedule:\n(?:\s+#.*\n)?\s+- cron: '41 \* \* \* \*'/);
  assert.match(y, /concurrency:\n {2}group: medclinic-pages-deploy\n {2}cancel-in-progress: false/);
  assert.match(y, /if: github\.repository == 'scale-ag\/dash-medclinic' && github\.ref == 'refs\/heads\/main'/);
  const jobs = y.split(/\n {2}(?=[a-z-]+:\n {4}name:)/).slice(1);
  const perms = Object.fromEntries(jobs.map((j) => [j.split(':')[0], /permissions:\n((?: {6}.+\n)+)/.exec(j)[1].trim().split(/\n\s*/)]));
  assert.deepEqual(perms, { test: ['contents: read'], 'collect-build': ['contents: read'], deploy: ['pages: write', 'id-token: write'] });
  const secretLines = y.split('\n').filter((l) => l.includes('secrets.'));
  assert.ok(secretLines.every((l) => /^\s+(META_ACCESS_TOKEN|GOOGLE_ADS_OAUTH|GOOGLE_LEADS_SHEET_ID): \$\{\{ secrets\.\1 \}\}$/.test(l)));
  assert.match(y, /name: Coletar Google Ads das duas contas\n        env:\n          GOOGLE_ADS_OAUTH:/);
  const order = ['npm test', 'scripts/collect.mjs', 'scripts/build.mjs', 'scripts/validate-dist.mjs', 'scripts/publish-gate.mjs', 'upload-pages-artifact', 'deploy-pages'];
  const idx = order.map((k) => y.indexOf(k));
  assert.ok(idx.every((v, i) => v > 0 && (i === 0 || v > idx[i - 1])), `ordem das etapas: ${idx}`);
  assert.ok(!/secrets\./.test(ci), 'CI de PR não usa secrets');
  assert.match(ci, /^permissions:\n {2}contents: read$/m);
});

test('código do navegador não acessa a API nem credenciais; coletor só fala com graph.facebook.com', async () => {
  const web = await readdir(join(ROOT, 'src/web'));
  const shared = await readdir(join(ROOT, 'src/shared'));
  for (const f of [...web.map((x) => `src/web/${x}`), ...shared.map((x) => `src/shared/${x}`)]) {
    const t = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!/graph\.facebook\.com|access_token|META_ACCESS_TOKEN|Bearer/.test(t), f);
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(t.replace(/'innerHTML não é permitido'/, '')), `${f}: API de HTML inseguro`);
  }
  // Identificadores técnicos da Meta ficam só na seção de metodologia (lidos do snapshot), nunca em cards.
  const appJs = readFileSync(join(ROOT, 'src/web/app.js'), 'utf8');
  assert.ok(!/onsite_conversion\.|'instagram_profile_follow'/.test(appJs), 'sem identificador técnico literal na UI');
  assert.match(appJs, /Conversas atribuídas aos anúncios no período/);
  const client = readFileSync(join(ROOT, 'src/node/meta-client.js'), 'utf8');
  assert.equal([...client.matchAll(/https:\/\/[a-z0-9.-]+/gi)].map((m) => m[0].replace(/\.$/, '')).filter((u) => u !== 'https://graph.facebook.com').length, 0);
});
