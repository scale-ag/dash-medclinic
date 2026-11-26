import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetaClient, MetaApiError, classifyError, parseRetryAfterMs } from '../src/node/meta-client.js';
import { createLogger, redact } from '../src/node/redact.js';
import { FAKE_TOKEN, jsonResponse } from './helpers/fake-meta.js';

const ACC = '203811442663021';
const noSleep = async () => {};

function client(fetchImpl, extra = {}) {
  return createMetaClient({ token: FAKE_TOKEN, apiVersion: 'v25.0', allowedAccountIds: [ACC], fetchImpl, sleep: noSleep, random: () => 0, ...extra });
}

test('token vai só no header Bearer, nunca na URL; redirect proibido; versão efetiva registrada', async () => {
  const calls = [];
  const c = client(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, { id: `act_${ACC}` }, { 'facebook-api-version': 'v27.0' });
  });
  await c.get(`act_${ACC}`, { fields: 'id' });
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.hostname, 'graph.facebook.com');
  assert.equal(u.pathname, `/v25.0/act_${ACC}`);
  assert.equal(u.searchParams.has('access_token'), false);
  assert.ok(!calls[0].url.includes(FAKE_TOKEN));
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual([...c.effectiveVersions], ['v27.0']);
  await assert.rejects(() => c.get(`act_${ACC}`, { access_token: 'x' }), /access_token/);
});

test('allowlist: outras contas e caminhos arbitrários são bloqueados antes de qualquer requisição', async () => {
  let n = 0;
  const c = client(async () => {
    n += 1;
    return jsonResponse(200, {});
  });
  await assert.rejects(() => c.get('act_999999999/insights'), /fora da allowlist/);
  await assert.rejects(() => c.get('me/adaccounts'), /Caminho não permitido/);
  await assert.rejects(() => c.get(`act_${ACC}/adcreatives`), /Caminho não permitido/);
  await assert.rejects(() => c.get('', { ids: '120243833203900317', fields: 'id' }), /Caminho não permitido/);
  await assert.rejects(() => c.get('120243833203900317', { ids: '1', fields: 'id' }), /Caminho não permitido/);
  assert.equal(n, 0);
});

test('leitura individual GET /<id> (sem ?ids=, descontinuado na v26.0+); objeto inexistente => null', async () => {
  const urls = [];
  const c = client(async (url) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/120243833203900317')) return jsonResponse(200, { id: '120243833203900317', account_id: ACC, destination_type: 'INSTAGRAM_PROFILE' });
    return jsonResponse(400, { error: { message: 'Unsupported get request. Object does not exist', code: 100, error_subcode: 33 } });
  });
  assert.deepEqual(await c.getObject('120243833203900317', 'id,account_id,destination_type'), { id: '120243833203900317', account_id: ACC, destination_type: 'INSTAGRAM_PROFILE' });
  assert.equal(await c.getObject('999999999', 'id'), null);
  assert.deepEqual(urls.map((x) => new URL(x).pathname), ['/v25.0/120243833203900317', '/v25.0/999999999']);
  assert.ok(urls.every((x) => !new URL(x).searchParams.has('ids')));
  await assert.rejects(() => c.getObject('../me', 'id'), /inválido/);
  const denied = client(async () => jsonResponse(400, { error: { message: 'Permissions error', code: 10 } }));
  await assert.rejects(() => denied.getObject('120243833203900317', 'id'), (e) => e.kind === 'permission');
});

test('paginação completa: segue next, remove access_token e valida host/caminho', async () => {
  const seen = [];
  const c = client(async (url) => {
    seen.push(url);
    const u = new URL(url);
    const after = Number(u.searchParams.get('after') || 0);
    const body = { data: [{ i: after }, { i: after + 1 }] };
    if (after < 4) body.paging = { next: `https://graph.facebook.com/v27.0/act_${ACC}/insights?after=${after + 2}&access_token=VAZADO123456` };
    return jsonResponse(200, body);
  });
  const items = await c.getAll(`act_${ACC}/insights`, { level: 'ad' });
  assert.deepEqual(items.map((x) => x.i), [0, 1, 2, 3, 4, 5]);
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => !s.includes('access_token') && !s.includes('VAZADO')));
});

test('paginação para host estranho ou outro recurso é interrompida sem enviar o token', async () => {
  for (const next of [
    `https://evil.example.com/v27.0/act_${ACC}/insights?after=2`,
    `http://graph.facebook.com/v27.0/act_${ACC}/insights?after=2`,
    `https://graph.facebook.com.evil.io/v27.0/act_${ACC}/insights?after=2`,
    `https://graph.facebook.com/v27.0/act_111111111/insights?after=2`,
  ]) {
    const hosts = [];
    const c = client(async (url) => {
      hosts.push(new URL(url).hostname);
      return jsonResponse(200, { data: [{}], paging: { next } });
    });
    await assert.rejects(() => c.getAll(`act_${ACC}/insights`), (e) => e instanceof MetaApiError && e.kind === 'invalid_paging');
    assert.deepEqual(hosts, ['graph.facebook.com']);
  }
});

test('cursor repetido é detectado (sem loop infinito)', async () => {
  const c = client(async () => jsonResponse(200, { data: [{}], paging: { next: `https://graph.facebook.com/v27.0/act_${ACC}/insights?after=X` } }));
  await assert.rejects(() => c.getAll(`act_${ACC}/insights`), /repetido/);
});

test('retry com backoff limitado para falhas transitórias', async () => {
  let n = 0;
  const delays = [];
  const c = client(
    async () => {
      n += 1;
      if (n < 3) return jsonResponse(500, { error: { message: 'Service temporarily unavailable', code: 2, is_transient: true } });
      return jsonResponse(200, { ok: true });
    },
    { sleep: async (ms) => delays.push(ms) },
  );
  assert.deepEqual(await c.get(`act_${ACC}`), { ok: true });
  assert.equal(n, 3);
  assert.deepEqual(delays, [2000, 4000]);

  let m = 0;
  const always = client(async () => {
    m += 1;
    return jsonResponse(503, {});
  }, { maxAttempts: 4 });
  await assert.rejects(() => always.get(`act_${ACC}`), (e) => e.kind === 'transient');
  assert.equal(m, 4, 'número de tentativas é limitado');

  let k = 0;
  const net = client(async () => {
    k += 1;
    if (k === 1) throw new TypeError('fetch failed');
    return jsonResponse(200, { ok: 1 });
  });
  assert.deepEqual(await net.get(`act_${ACC}`), { ok: 1 });
});

test('erro de autenticação/permissão falha imediatamente, com mensagem clara e sem token', async () => {
  for (const [error, kind] of [
    [{ message: `Error validating access token: ${FAKE_TOKEN}`, code: 190, error_subcode: 463 }, 'auth'],
    [{ message: '(#200) Ad account owner has NOT grant ads_management or ads_read permission', code: 200 }, 'permission'],
    [{ message: 'Permissions error', code: 10 }, 'permission'],
  ]) {
    let n = 0;
    const c = client(async () => {
      n += 1;
      return jsonResponse(400, { error });
    });
    await assert.rejects(
      () => c.get(`act_${ACC}`),
      (e) => {
        assert.equal(e.kind, kind);
        assert.ok(!e.message.includes(FAKE_TOKEN), 'token redigido');
        assert.match(e.message, kind === 'auth' ? /Renove o secret/ : /ads_read/);
        return true;
      },
    );
    assert.equal(n, 1, 'sem retry');
  }
});

test('limite de taxa com espera longa interrompe sem publicar', async () => {
  const c = client(async () =>
    jsonResponse(400, { error: { message: 'User request limit reached', code: 17 } }, { 'x-business-use-case-usage': JSON.stringify({ [ACC]: [{ type: 'ads_insights', estimated_time_to_regain_access: 30 }] }) }),
  );
  await assert.rejects(() => c.get(`act_${ACC}`), /~30 min/);
});

test('classificação de erros e leitura de headers de uso', () => {
  assert.equal(classifyError({ status: 400, error: { code: 100, message: 'Invalid parameter' } }).kind, 'invalid_request');
  assert.equal(classifyError({ status: 400, error: { code: 1, message: 'Please reduce the amount of data you are asking for' } }).kind, 'data_volume');
  assert.equal(classifyError({ status: 400, error: { code: 80004, message: 'too many calls' } }).kind, 'rate_limit');
  assert.equal(classifyError({ status: 429, error: null }).retryable, true);
  const h = new Headers({ 'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 99, estimated_time_to_regain_access: 2 }) });
  assert.equal(parseRetryAfterMs(h), 120000);
});

test('redação de segredos em logs', () => {
  const lines = [];
  const log = createLogger({ secrets: [FAKE_TOKEN], write: (l) => lines.push(l) });
  log.error(`falha url=https://graph.facebook.com/x?access_token=${FAKE_TOKEN} Authorization: Bearer ${FAKE_TOKEN}`);
  log.info(`${'EAA'}${'B'.repeat(26)} outro token`);
  assert.ok(lines.every((l) => !l.includes(FAKE_TOKEN) && !/EAA[A-Za-z0-9]{16,}/.test(l)));
  assert.equal(redact('access_token=abc123456789&x=1'), 'access_token=[REDACTED]&x=1');
  assert.throws(() => createMetaClient({ token: '', apiVersion: 'v25.0', allowedAccountIds: [ACC] }), /pendente/);
  assert.throws(() => createMetaClient({ token: FAKE_TOKEN, apiVersion: '25', allowedAccountIds: [ACC] }), /META_API_VERSION/);
});
