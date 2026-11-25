// Cliente somente leitura da Meta Graph/Marketing API.
// - Token enviado EXCLUSIVAMENTE no header Authorization: Bearer, e só para https://graph.facebook.com.
// - Nunca coloca o token em URL; remove access_token de URLs de paginação; não segue redirects.
// - Allowlist de caminhos e contas: nenhuma outra conta pode ser consultada.
// - Retry com backoff limitado apenas para falhas transitórias/limite de taxa.
import { redact, silentLogger } from './redact.js';

export const GRAPH_HOST = 'graph.facebook.com';
const VERSION_RE = /^v\d{1,3}\.\d{1,2}$/;
const ID_RE = /^\d{5,25}$/;

const AUTH_CODES = new Set([102, 190, 458, 459, 460, 463, 464, 467]);
const PERMISSION_CODES = new Set([3, 10, 278, 294]);
const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
const TRANSIENT_CODES = new Set([1, 2]);

export class MetaApiError extends Error {
  constructor(message, { kind, status = null, code = null, subcode = null, fbtraceId = null, retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'MetaApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.fbtraceId = fbtraceId;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Extrai, do header de uso da Meta, o tempo estimado para recuperar acesso (ms). */
export function parseRetryAfterMs(headers) {
  let maxMinutes = 0;
  for (const name of ['x-business-use-case-usage', 'x-ad-account-usage', 'x-app-usage']) {
    const raw = headers?.get?.(name);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const visit = (v) => {
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object') {
          for (const [k, val] of Object.entries(v)) {
            if (k === 'estimated_time_to_regain_access' && Number.isFinite(Number(val))) {
              maxMinutes = Math.max(maxMinutes, Number(val));
            } else visit(val);
          }
        }
      };
      visit(parsed);
    } catch {
      /* header malformado: ignora */
    }
  }
  const retryAfter = Number(headers?.get?.('retry-after'));
  const ms = Math.max(maxMinutes * 60000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0);
  return ms > 0 ? ms : null;
}

/** Classifica erro de resposta da Meta em categorias acionáveis. */
export function classifyError({ status, error }) {
  const code = Number.isFinite(Number(error?.code)) ? Number(error.code) : null;
  const subcode = Number.isFinite(Number(error?.error_subcode)) ? Number(error.error_subcode) : null;
  const msg = String(error?.message || '');
  if (code !== null && AUTH_CODES.has(code)) return { kind: 'auth', retryable: false };
  if (code !== null && (PERMISSION_CODES.has(code) || (code >= 200 && code <= 299))) return { kind: 'permission', retryable: false };
  if (status === 401) return { kind: 'auth', retryable: false };
  if (status === 403 && code === null) return { kind: 'permission', retryable: false };
  if (code !== null && RATE_CODES.has(code)) return { kind: 'rate_limit', retryable: true };
  if (status === 429) return { kind: 'rate_limit', retryable: true };
  if ((code === 1 || code === 100) && (/reduce the amount of data/i.test(msg) || subcode === 1487534)) {
    return { kind: 'data_volume', retryable: false };
  }
  if (error?.is_transient === true) return { kind: 'transient', retryable: true };
  if (code !== null && TRANSIENT_CODES.has(code)) return { kind: 'transient', retryable: true };
  if (code === 100) return { kind: 'invalid_request', retryable: false };
  if (status >= 500) return { kind: 'transient', retryable: true };
  return { kind: 'unknown', retryable: false };
}

const KIND_HINT = {
  auth: 'Token inválido, expirado ou revogado. Renove o secret META_ACCESS_TOKEN (não reutilize tokens de outros projetos).',
  permission: 'Sem permissão de leitura nesta conta/objeto. Conceda apenas ads_read ao usuário/sistema do token; nenhuma permissão de escrita é necessária.',
  rate_limit: 'Limite de taxa da Meta.',
  data_volume: 'Volume de dados excessivo para a janela solicitada.',
  invalid_request: 'Parâmetro/campo rejeitado pela API (verifique META_API_VERSION e campos configurados).',
  transient: 'Falha transitória da Meta.',
  network: 'Falha de rede/timeout.',
  invalid_paging: 'Paginação inválida.',
  unknown: 'Erro não classificado.',
};

function safeParams(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (k === 'access_token') throw new Error('access_token nunca pode ir em parâmetros de URL');
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

export function createMetaClient({
  token,
  apiVersion,
  allowedAccountIds,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  logger = silentLogger,
  maxAttempts = 5,
  baseDelayMs = 2000,
  maxDelayMs = 60000,
  timeoutMs = 60000,
  maxPages = 1000,
} = {}) {
  if (typeof token !== 'string' || token.trim().length < 20) {
    throw new MetaApiError('META_ACCESS_TOKEN ausente ou inválido no ambiente. Implantação real pendente do secret.', { kind: 'auth' });
  }
  if (!VERSION_RE.test(apiVersion || '')) throw new Error(`META_API_VERSION inválida: ${String(apiVersion).slice(0, 12)} (ex.: v25.0)`);
  if (!Array.isArray(allowedAccountIds) || allowedAccountIds.length === 0) throw new Error('allowlist de contas vazia');
  const allowed = new Set(allowedAccountIds.map(String));
  const effectiveVersions = new Set();
  const stats = { requests: 0, retries: 0, pages: 0 };

  const assertPathAllowed = (path, params = {}) => {
    const m = /^act_(\d+)(?:\/(insights|campaigns|adsets))?$/.exec(path);
    if (m) {
      if (!allowed.has(m[1])) throw new MetaApiError(`Conta act_${m[1]} fora da allowlist — consulta bloqueada`, { kind: 'config' });
      return;
    }
    if (path === 'app') return;
    if (path === '' && typeof params.ids === 'string' && params.ids.split(',').every((id) => ID_RE.test(id))) return;
    throw new MetaApiError(`Caminho não permitido: ${path.slice(0, 60)}`, { kind: 'config' });
  };

  const assertGraphUrl = (url) => {
    if (url.protocol !== 'https:' || url.hostname !== GRAPH_HOST || url.port !== '' || url.username || url.password) {
      throw new MetaApiError(`Host não permitido para envio de credencial: ${url.hostname}`, { kind: 'invalid_paging' });
    }
    if (url.searchParams.has('access_token')) throw new MetaApiError('URL contém access_token — bloqueado', { kind: 'invalid_paging' });
  };

  const describe = (url) => url.pathname; // nunca registra query string

  async function once(url) {
    assertGraphUrl(url);
    stats.requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (e) {
      throw new MetaApiError(`${KIND_HINT.network} em ${describe(url)}: ${redact(e?.message || e, [token])}`, {
        kind: 'network',
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
    const ver = res.headers?.get?.('facebook-api-version');
    if (ver) effectiveVersions.add(ver);
    let body = null;
    let text = '';
    try {
      text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.ok && body && !body.error) return { body, headers: res.headers };
    const error = body?.error || null;
    const { kind, retryable } = error || res.status >= 400 ? classifyError({ status: res.status, error }) : { kind: 'unknown', retryable: false };
    const code = error?.code ?? null;
    const subcode = error?.error_subcode ?? null;
    const detail = error?.message ? redact(error.message, [token]).slice(0, 300) : `HTTP ${res.status} sem corpo JSON válido`;
    throw new MetaApiError(
      `Meta API [${kind}] HTTP ${res.status}${code !== null ? ` code ${code}` : ''}${subcode !== null ? `/${subcode}` : ''} em ${describe(url)}: ${detail}. ${KIND_HINT[kind] || ''}${error?.fbtrace_id ? ` (fbtrace_id ${String(error.fbtrace_id).slice(0, 40)})` : ''}`,
      { kind, status: res.status, code, subcode, fbtraceId: error?.fbtrace_id || null, retryable, retryAfterMs: parseRetryAfterMs(res.headers) },
    );
  }

  async function withRetry(url) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(url);
      } catch (e) {
        if (!(e instanceof MetaApiError) || !e.retryable || attempt >= maxAttempts) throw e;
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        const delay = Math.round(Math.max(backoff, e.retryAfterMs || 0) * (1 + random() * 0.25));
        if (e.retryAfterMs && e.retryAfterMs > maxDelayMs) {
          throw new MetaApiError(
            `${e.message} A Meta pediu ~${Math.ceil(e.retryAfterMs / 60000)} min de espera, acima do limite do coletor; a execução foi interrompida sem publicar.`,
            { kind: 'rate_limit', status: e.status, code: e.code, subcode: e.subcode, retryable: false },
          );
        }
        stats.retries += 1;
        logger.warn(`tentativa ${attempt}/${maxAttempts} falhou (${e.kind}) em ${describe(url)}; nova tentativa em ${Math.round(delay / 1000)}s`);
        await sleep(delay);
      }
    }
  }

  function buildUrl(path, params) {
    assertPathAllowed(path, params);
    const url = new URL(`https://${GRAPH_HOST}/${apiVersion}/${path}`);
    for (const [k, v] of Object.entries(safeParams(params))) url.searchParams.set(k, v);
    return url;
  }

  /** Valida a URL `paging.next`: mesmo host, mesmo caminho lógico, sem token. */
  function sanitizeNext(next, expectedPath) {
    let url;
    try {
      url = new URL(next);
    } catch {
      throw new MetaApiError('paging.next malformado', { kind: 'invalid_paging' });
    }
    if (url.protocol !== 'https:' || url.hostname !== GRAPH_HOST || url.port !== '' || url.username || url.password) {
      throw new MetaApiError(`paging.next aponta para host não permitido (${url.hostname}) — interrompido`, { kind: 'invalid_paging' });
    }
    url.searchParams.delete('access_token');
    const logical = url.pathname.replace(/^\/v\d{1,3}\.\d{1,2}\//, '').replace(/^\//, '');
    if (logical !== expectedPath) {
      throw new MetaApiError('paging.next aponta para outro recurso — interrompido', { kind: 'invalid_paging' });
    }
    return url;
  }

  async function get(path, params = {}) {
    const { body } = await withRetry(buildUrl(path, params));
    return body;
  }

  /** Lê TODAS as páginas de uma edge, validando cada `next`. */
  async function getAll(path, params = {}) {
    let url = buildUrl(path, params);
    const items = [];
    const seen = new Set();
    for (let page = 1; ; page += 1) {
      if (page > maxPages) throw new MetaApiError(`Mais de ${maxPages} páginas em ${path} — interrompido`, { kind: 'invalid_paging' });
      const { body } = await withRetry(url);
      stats.pages += 1;
      if (!Array.isArray(body?.data)) throw new MetaApiError(`Resposta sem data[] em ${path}`, { kind: 'unknown' });
      items.push(...body.data);
      const next = body.paging?.next;
      if (!next) break;
      const nextUrl = sanitizeNext(next, path);
      const key = nextUrl.toString();
      if (seen.has(key)) throw new MetaApiError(`Cursor de paginação repetido em ${path} — interrompido`, { kind: 'invalid_paging' });
      seen.add(key);
      url = nextUrl;
    }
    return items;
  }

  /** Leitura de objetos por ID (?ids=...), em blocos de 50. */
  async function getByIds(ids, fields) {
    const out = {};
    const unique = [...new Set(ids.map(String))];
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      if (!chunk.every((id) => ID_RE.test(id))) throw new MetaApiError('ID inválido em getByIds', { kind: 'config' });
      const body = await get('', { ids: chunk.join(','), fields });
      Object.assign(out, body || {});
    }
    return out;
  }

  return { get, getAll, getByIds, effectiveVersions, stats, sanitizeNext };
}
