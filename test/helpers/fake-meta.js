// API Meta FALSA em memória (fetch injetado) para testes. Nenhuma chamada de rede real.
// Converte um snapshot sintético em respostas no formato da Graph API (strings, actions[], paging.next).
import { eachDay } from '../../src/shared/dates.js';

// Valor fictício, montado em tempo de execução para não parecer credencial real em varreduras do git.
export const FAKE_TOKEN = ['FAKE', 'token', 'para', 'testes', '0123456789abcdef'].join('-');

function jsonResponse(status, body, headers = {}) {
  const h = new Headers({ 'content-type': 'application/json', 'facebook-api-version': 'v27.0', ...headers });
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: h, text: async () => text };
}

function centsToStr(c) {
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

/** Linhas brutas de insights (formato Meta) a partir de linhas normalizadas sintéticas. */
export function toRawInsights(snapshot) {
  return snapshot.rows.map((r) => ({
    account_id: r.account_id,
    campaign_id: r.campaign_id,
    campaign_name: snapshot.campaigns[r.campaign_id]?.name,
    adset_id: r.adset_id,
    adset_name: snapshot.adsets[r.adset_id]?.name,
    ad_id: r.ad_id,
    ad_name: snapshot.ads[r.ad_id]?.name,
    date_start: r.date,
    date_stop: r.date,
    spend: centsToStr(r.spend_cents),
    impressions: String(r.impressions),
    inline_link_clicks: String(r.link_clicks),
    actions: [
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(r.conversations) },
      // Ruído que NÃO pode ser contado como conversa:
      { action_type: 'onsite_conversion.total_messaging_connection', value: String(r.conversations + 7) },
      { action_type: 'onsite_conversion.messaging_first_reply', value: String(r.conversations + 3) },
      { action_type: 'link_click', value: String(r.link_clicks) },
    ].filter((a) => !(a.action_type.endsWith('_7d') && r.conversations === 0)),
    instagram_profile_follow: r.follows ? String(r.follows) : undefined,
  }));
}

/**
 * @param state { snapshot, raw (mutável), accountDays (mutável) }
 * @param opts.pageSize tamanho de página de insights
 * @param opts.leakTokenInNext coloca access_token na URL next (deve ser removido pelo cliente)
 * @param opts.handler (url) => response|undefined para injetar falhas
 */
export function createFakeMeta(snapshot, opts = {}) {
  const state = {
    raw: toRawInsights(snapshot),
    accountDays: Object.fromEntries(snapshot.accounts.map((a) => [a.id, { ...a.days }])),
    accounts: Object.fromEntries(snapshot.accounts.map((a) => [a.id, { id: `act_${a.id}`, account_id: a.id, name: a.name, currency: 'BRL', timezone_name: 'America/Sao_Paulo', account_status: 1, business: { id: '437935417525828', name: 'BM' } }])),
    campaigns: snapshot.campaigns,
    adsets: snapshot.adsets,
    hiddenFromDiscovery: new Set(opts.hiddenFromDiscovery || []),
    appId: opts.appId || '1234567890',
  };
  const requests = [];
  const pageSize = opts.pageSize || 50;

  const page = (url, items) => {
    const offset = Number(url.searchParams.get('after') || 0);
    const slice = items.slice(offset, offset + pageSize);
    const body = { data: slice };
    if (offset + pageSize < items.length) {
      const next = new URL(url.toString());
      next.searchParams.set('after', String(offset + pageSize));
      if (opts.leakTokenInNext) next.searchParams.set('access_token', 'LEAKED_TOKEN_SHOULD_BE_STRIPPED');
      if (opts.nextHost) next.hostname = opts.nextHost;
      if (opts.nextPath) next.pathname = opts.nextPath;
      next.pathname = next.pathname.replace(/^\/v\d+\.\d+\//, '/v27.0/');
      body.paging = { cursors: {}, next: next.toString() };
    }
    return jsonResponse(200, body);
  };

  async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    requests.push({ url: url.toString(), host: url.hostname, path: url.pathname, headers: { ...(init.headers || {}) }, redirect: init.redirect });
    const injected = opts.handler?.(url, requests.length);
    if (injected) return injected;
    const path = url.pathname.replace(/^\/v\d+\.\d+\/?/, '');
    if (path === 'app') return jsonResponse(200, { id: state.appId });
    if (path === '' && url.searchParams.get('ids')) {
      const out = {};
      for (const id of url.searchParams.get('ids').split(',')) {
        if (state.adsets[id]) out[id] = { id, ...state.adsets[id], account_id: opts.adsetAccountOverride?.[id] || state.adsets[id].account_id };
        else if (state.campaigns[id]) out[id] = { id, ...state.campaigns[id] };
      }
      return jsonResponse(200, out);
    }
    const m = /^act_(\d+)(?:\/(\w+))?$/.exec(path);
    if (!m) return jsonResponse(400, { error: { message: 'Unsupported path', code: 100 } });
    const [, acc, edge] = m;
    if (!state.accounts[acc]) return jsonResponse(400, { error: { message: 'Unknown account', code: 100 } });
    if (!edge) return jsonResponse(200, { ...state.accounts[acc], ...(opts.accountOverride?.[acc] || {}) });
    if (edge === 'campaigns') {
      return page(url, Object.entries(state.campaigns).filter(([, c]) => c.account_id === acc).map(([id, c]) => ({ id, ...c })));
    }
    if (edge === 'adsets') {
      return page(
        url,
        Object.entries(state.adsets)
          .filter(([id, s]) => s.account_id === acc && !state.hiddenFromDiscovery.has(id))
          .map(([id, s]) => ({ id, ...s })),
      );
    }
    if (edge === 'insights') {
      const tr = JSON.parse(url.searchParams.get('time_range'));
      const level = url.searchParams.get('level');
      if (level === 'account') {
        const items = eachDay(tr.since, tr.until)
          .filter((d) => state.accountDays[acc][d] && state.accountDays[acc][d].account_spend_cents > 0)
          .map((d) => ({ account_id: acc, date_start: d, date_stop: d, spend: centsToStr(state.accountDays[acc][d].account_spend_cents), impressions: String(state.accountDays[acc][d].account_impressions) }));
        return page(url, items);
      }
      const items = state.raw.filter((r) => r.account_id === acc && r.date_start >= tr.since && r.date_start <= tr.until);
      return page(url, items);
    }
    return jsonResponse(400, { error: { message: 'Unsupported edge', code: 100 } });
  }
  return { fetchImpl, requests, state, jsonResponse };
}

export { jsonResponse };
