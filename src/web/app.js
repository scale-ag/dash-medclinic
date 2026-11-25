// Dashboard MedClinic — captação por conversas iniciadas no WhatsApp e seguidores, por médico.
// Fonte única: snapshot coletado da Meta Marketing API (somente leitura). Nenhum dado de demonstração:
// se o snapshot não carregar, a página mostra o erro; se for sintético, mostra uma faixa de alerta.
import { h, clear, put } from './dom.js';
import { renderTimeChart } from './charts.js';
import { sortableTable, treeTable } from './tables.js';
import { PRESETS, PRESET_IDS, presetRange, dateInTimeZone, formatDateBR, formatDateTimeBR, isIsoDate, diffDays, weekdayBR } from './shared/dates.js';
import {
  VIEWS,
  findView,
  buildModel,
  viewRows,
  mappedCampaignsFor,
  filterRows,
  filterOptions,
  dailySeries,
  buildTree,
  reconciliation,
  doctorOutsideCost,
  coverageSummary,
  identifiedCampaigns,
  pendingDoctorAdsets,
} from './shared/model.js';
import { sumRows, deriveMetrics, taxFactorFromConfig, spendBRL, ratio, emptyTotals, addRowInto } from './shared/metrics.js';
import { CATEGORY, CATEGORY_LABELS } from './shared/classify.js';
import { fmtBRL, fmtInt, fmtPct, fmtAxisBRL, fmtMinutesAgo, fmtDec, DASH } from './shared/format.js';
import { toCsv, safeFilenamePart } from './shared/csv.js';

const TZ = 'America/Sao_Paulo';
const DOCTOR_COLOR = { taisa: '--series-1', ailton: '--series-2' };
const app = { config: null, snapshot: null, model: null, taxFactor: 1, loadedAt: null };
const state = {
  view: 'geral',
  preset: null,
  since: '',
  until: '',
  campaignId: '',
  adsetId: '',
  adId: '',
  tax: true,
  dailySort: { key: 'date', dir: 'desc' },
  treeSort: { key: 'spend', dir: 'desc' },
  pendingSort: { key: 'spend', dir: 'desc' },
  expanded: new Set(),
};

const $ = (id) => document.getElementById(id);

// ---------- Estado na URL ----------
function readHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const v = p.get('v');
  if (v && VIEWS.some((x) => x.id === v)) state.view = v;
  const preset = p.get('p');
  if (preset && PRESET_IDS.has(preset)) state.preset = preset;
  if (isIsoDate(p.get('de') || '')) state.since = p.get('de');
  if (isIsoDate(p.get('ate') || '')) state.until = p.get('ate');
  for (const [k, q] of [['campaignId', 'c'], ['adsetId', 'cj'], ['adId', 'an']]) {
    const val = p.get(q) || '';
    state[k] = /^\d{1,25}$/.test(val) ? val : '';
  }
  if (p.has('imp')) state.tax = p.get('imp') !== '0';
}

function writeHash() {
  const p = new URLSearchParams();
  p.set('v', state.view);
  p.set('p', state.preset);
  if (state.preset === 'custom') {
    if (state.since) p.set('de', state.since);
    if (state.until) p.set('ate', state.until);
  }
  if (state.campaignId) p.set('c', state.campaignId);
  if (state.adsetId) p.set('cj', state.adsetId);
  if (state.adId) p.set('an', state.adId);
  p.set('imp', state.tax ? '1' : '0');
  history.replaceState(null, '', `#${p.toString()}`);
}

// ---------- Tema ----------
function storedTheme() {
  try {
    return localStorage.getItem('medclinic-theme');
  } catch {
    return null;
  }
}
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem('medclinic-theme', next);
  } catch {
    /* sem armazenamento: tema vale só nesta sessão */
  }
  render();
}

// ---------- Dados ----------
async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao carregar ${url.split('?')[0]}`);
  return res.json();
}

async function load({ reload = false } = {}) {
  const bust = reload ? `?t=${Date.now()}` : '';
  const [config, snapshot] = await Promise.all([fetchJson(`./data/config.json${bust}`), fetchJson(`./data/snapshot.json${bust}`)]);
  if (snapshot?.schema_version !== 1 || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.accounts)) {
    throw new Error('Snapshot em formato inesperado');
  }
  if (!['production', 'synthetic-test'].includes(snapshot.kind)) throw new Error('Snapshot de origem desconhecida');
  const previous = app.snapshot?.generated_at || null;
  app.config = config;
  app.snapshot = snapshot;
  app.model = buildModel(snapshot, config.campaign_map);
  app.taxFactor = taxFactorFromConfig(config.tax);
  app.loadedAt = new Date();
  return { previous, current: snapshot.generated_at };
}

// ---------- Helpers de período/filtro ----------
function today() {
  return dateInTimeZone(new Date(), TZ);
}
function partialDay() {
  return app.snapshot.today_is_partial ? app.snapshot.today : null;
}
function currentRange() {
  return presetRange(state.preset, today(), { since: state.since, until: state.until });
}
function filters(range) {
  return { range, campaignId: state.campaignId, adsetId: state.adsetId, adId: state.adId };
}
function spendOf(cents) {
  return spendBRL(cents, { taxEnabled: state.tax, taxFactor: app.taxFactor });
}
function spendLabel() {
  return state.tax ? 'Investimento (c/ imposto estimado)' : 'Investimento (bruto)';
}
function resultLabels(view) {
  return view.result === 'conversations'
    ? { result: 'Conversas iniciadas', short: 'Conversas', cost: 'Custo por conversa', unit: 'conversa' }
    : { result: 'Seguidores', short: 'Seguidores', cost: 'Custo por seguidor', unit: 'seguidor' };
}
function rangeText(range) {
  if (range.empty) return 'Sem dias completos no período';
  const n = diffDays(range.since, range.until) + 1;
  return `${formatDateBR(range.since)} – ${formatDateBR(range.until)} (${n} ${n === 1 ? 'dia' : 'dias'})`;
}

// ---------- Componentes ----------
function kpi(label, value, sub, { hero = false, nullReason = null, tone = null } = {}) {
  return h(
    'div',
    { class: `kpi${hero ? ' kpi-hero' : ''}${tone ? ` tone-${tone}` : ''}` },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value' }, value),
    sub || nullReason ? h('div', { class: 'kpi-sub' }, nullReason || sub) : null,
  );
}

function notice(kind, ...content) {
  const icon = { info: 'ℹ', warn: '!', critical: '×', ok: '✓' }[kind] || 'ℹ';
  return h('div', { class: `notice notice-${kind}`, role: kind === 'critical' ? 'alert' : null }, h('span', { class: 'notice-icon', 'aria-hidden': 'true' }, icon), h('div', null, ...content));
}

function section(title, subtitle, ...content) {
  return h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', null, title), subtitle ? h('p', { class: 'panel-sub' }, subtitle) : null), ...content);
}

function chartCard(title, subtitle, opts) {
  const body = h('div', { class: 'chart-body' });
  const card = h('figure', { class: 'chart-card' }, h('figcaption', null, h('h3', null, title), subtitle ? h('p', null, subtitle) : null), body);
  queueMicrotask(() => renderTimeChart(body, { ...opts, title }));
  return card;
}

function costText(v, nullReason) {
  return v === null ? h('span', { class: 'na', title: nullReason }, DASH) : fmtBRL(v);
}

function coverageNotices(range) {
  const out = [];
  const cov = coverageSummary(app.model, range);
  if (range.empty) {
    out.push(notice('info', range.reason === 'primeiro_dia_do_mes' ? 'Hoje é o primeiro dia do mês: ainda não há dias completos em “Mês até ontem”.' : 'Período sem dias válidos.'));
    return out;
  }
  if (cov.missing.length) {
    out.push(
      notice(
        'warn',
        `${cov.missing.length} de ${cov.totalDays} dia(s) do período não foram coletados (${cov.missing.length > 4 ? `${formatDateBR(cov.missing[0])} … ${formatDateBR(cov.missing.at(-1))}` : cov.missing.map(formatDateBR).join(', ')}). `,
        `Esses dias aparecem como “sem coleta” — ausência de dado, não zero. Histórico disponível a partir de ${formatDateBR(app.snapshot.data_start)}.`,
      ),
    );
  }
  const pd = partialDay();
  if (pd && pd >= range.since && pd <= range.until) {
    out.push(notice('info', `${formatDateBR(pd)} está incluído e é PARCIAL (coletado em ${formatDateTimeBR(app.snapshot.generated_at)}); os números desse dia ainda vão mudar.`));
  }
  if (range.clampedFuture) out.push(notice('info', 'O fim do período personalizado foi limitado a hoje (não existem dados futuros).'));
  return out;
}

// ---------- Cabeçalho / status ----------
function freshness() {
  const times = app.snapshot.accounts.map((a) => Date.parse(a.last_success_at)).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : NaN;
  const minutes = (Date.now() - oldest) / 60000;
  const ui = app.config.ui || {};
  const level = !Number.isFinite(minutes) ? 'critical' : minutes > (ui.freshness_critical_minutes ?? 360) ? 'critical' : minutes > (ui.freshness_warn_minutes ?? 90) ? 'warn' : 'ok';
  return { oldest, minutes, level };
}

function renderStatus() {
  const root = $('status');
  clear(root);
  const f = freshness();
  root.append(
    h('span', { class: 'chip' }, h('span', { class: 'chip-k' }, 'Fonte'), 'Meta Marketing API'),
    h(
      'span',
      { class: `chip chip-${f.level}`, title: 'Coleta mais antiga entre as contas (horário de Brasília)' },
      h('span', { class: 'chip-k' }, f.level === 'ok' ? '✓ Atualizado' : f.level === 'warn' ? '! Atraso' : '× Desatualizado'),
      Number.isFinite(f.oldest) ? `${formatDateTimeBR(new Date(f.oldest).toISOString())} (${fmtMinutesAgo(f.minutes)})` : 'sem data',
    ),
    h(
      'label',
      { class: 'switch', title: app.config.tax.description },
      h('input', {
        type: 'checkbox',
        checked: state.tax,
        onChange: (e) => {
          state.tax = e.target.checked;
          update();
        },
      }),
      h('span', null, 'Imposto Meta ', h('span', { class: 'badge badge-warn' }, app.config.tax.label || 'ESTIMATIVA')),
    ),
    h('button', { type: 'button', class: 'btn', onClick: reloadData, title: 'Recarrega o snapshot publicado. Não dispara nova coleta.' }, 'Recarregar dados'),
    h('button', { type: 'button', class: 'btn btn-ghost', onClick: toggleTheme, 'aria-label': 'Alternar tema claro/escuro' }, currentTheme() === 'dark' ? '☀ Claro' : '☾ Escuro'),
  );
  const banner = $('banner');
  clear(banner);
  if (app.snapshot.kind !== 'production') {
    banner.append(
      notice('critical', h('strong', null, 'DADOS SINTÉTICOS DE TESTE'), ' — gerados localmente para validar a interface. Não representam a MedClinic e nunca são publicados.'),
    );
  }
}

async function reloadData() {
  const btn = document.activeElement;
  document.body.classList.add('is-loading');
  try {
    const { previous, current } = await load({ reload: true });
    toast(
      previous === current
        ? `Snapshot recarregado: nenhuma coleta mais recente disponível (última: ${formatDateTimeBR(current)}). Este botão não dispara coleta.`
        : `Snapshot recarregado: coleta de ${formatDateTimeBR(current)}. Este botão não dispara coleta.`,
    );
    render();
  } catch (e) {
    toast(`Falha ao recarregar: ${e.message}. Os dados exibidos continuam os anteriores.`, true);
  } finally {
    document.body.classList.remove('is-loading');
    if (btn && btn.focus) btn.focus();
  }
}

let toastTimer = 0;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' toast-error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 7000);
}

// ---------- Abas ----------
function renderTabs() {
  const nav = $('tabs');
  clear(nav);
  nav.append(
    ...VIEWS.map((v) =>
      h(
        'a',
        {
          href: '#',
          class: `tab${v.id === state.view ? ' active' : ''}`,
          'aria-current': v.id === state.view ? 'page' : null,
          onClick: (e) => {
            e.preventDefault();
            state.view = v.id;
            update();
          },
        },
        v.label,
      ),
    ),
  );
}

// ---------- Filtros ----------
function renderFilters(view, range) {
  const root = $('filters');
  clear(root);
  const td = today();
  const scoped = filterRows(viewRows(app.model, view), { range });
  const opts = filterOptions(scoped, state);
  const select = (label, value, list, allLabel, onChange) => {
    const known = list.some((o) => o.id === value);
    return h(
      'label',
      { class: 'field' },
      h('span', null, label),
      h(
        'select',
        { onChange: (e) => onChange(e.target.value) },
        h('option', { value: '', selected: !value }, allLabel),
        list.map((o) => h('option', { value: o.id, selected: o.id === value }, o.name)),
        value && !known ? h('option', { value, selected: true }, `(sem dados nesta visão/período) ${value}`) : null,
      ),
    );
  };
  put(
    root,
    h(
      'label',
      { class: 'field' },
      h('span', null, 'Período'),
      h(
        'select',
        {
          onChange: (e) => {
            state.preset = e.target.value;
            if (state.preset === 'custom' && (!state.since || !state.until)) {
              const r = presetRange(app.config.ui.default_preset || 'month_to_yesterday', td);
              state.since = r.since;
              state.until = r.empty ? td : r.until;
            }
            update();
          },
        },
        PRESETS.map((p) => h('option', { value: p.id, selected: p.id === state.preset }, p.label)),
      ),
    ),
    state.preset === 'custom'
      ? [
          h('label', { class: 'field field-date' }, h('span', null, 'De'), h('input', { type: 'date', value: state.since, min: app.snapshot.data_start, max: td, onChange: (e) => ((state.since = e.target.value), update()) })),
          h('label', { class: 'field field-date' }, h('span', null, 'Até (hoje = parcial)'), h('input', { type: 'date', value: state.until, min: app.snapshot.data_start, max: td, onChange: (e) => ((state.until = e.target.value), update()) })),
        ]
      : null,
    select('Campanha', state.campaignId, opts.campaigns, 'Todas as campanhas', (v) => {
      state.campaignId = v;
      state.adsetId = '';
      state.adId = '';
      update();
    }),
    select('Conjunto', state.adsetId, opts.adsets, 'Todos os conjuntos', (v) => {
      state.adsetId = v;
      state.adId = '';
      update();
    }),
    select('Anúncio', state.adId, opts.ads, 'Todos os anúncios', (v) => {
      state.adId = v;
      update();
    }),
    h('div', { class: 'filter-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', onClick: clearFilters }, 'Limpar filtros'), h('button', { type: 'button', class: 'btn', onClick: () => exportCsv(view, range), disabled: range.empty }, 'Exportar CSV')),
    h('p', { class: 'range-text', 'aria-live': 'polite' }, rangeText(range), range.includesToday ? h('span', { class: 'badge badge-warn' }, 'inclui hoje (parcial)') : null),
  );
}

function clearFilters() {
  state.preset = app.config.ui.default_preset || 'month_to_yesterday';
  state.since = '';
  state.until = '';
  state.campaignId = '';
  state.adsetId = '';
  state.adId = '';
  update();
}

// ---------- CSV ----------
function exportCsv(view, range) {
  const rows = filterRows(viewRows(app.model, view), filters(range));
  const doctors = app.config.campaign_map.doctors;
  const columns = [
    { header: 'data', value: (r) => formatDateBR(r.date) },
    { header: 'conta', value: (r) => r.account_label },
    { header: 'medico', value: (r) => (r.doctor ? doctors[r.doctor]?.label : '') },
    { header: 'categoria', value: (r) => CATEGORY_LABELS[r.category] },
    { header: 'motivo_classificacao', value: (r) => r.reason },
    { header: 'campanha_id', value: (r) => r.campaign_id },
    { header: 'campanha', value: (r) => r.campaign_name },
    { header: 'conjunto_id', value: (r) => r.adset_id },
    { header: 'conjunto', value: (r) => r.adset_name },
    { header: 'destino_conjunto', value: (r) => r.destination_type || '' },
    { header: 'anuncio_id', value: (r) => r.ad_id },
    { header: 'anuncio', value: (r) => r.ad_name },
    { header: 'investimento_bruto_brl', type: 'number', value: (r) => r.spend_cents / 100 },
    { header: 'fator_imposto_estimado', type: 'number', decimals: 9, value: () => app.taxFactor },
    { header: 'investimento_com_imposto_estimado_brl', type: 'number', value: (r) => (r.spend_cents / 100) * app.taxFactor },
    { header: 'conversas_whatsapp_conciliadas', type: 'integer', value: (r) => (r.category === CATEGORY.WHATSAPP ? r.conversations : null) },
    { header: 'seguidores_campanha_seguidores', type: 'integer', value: (r) => (r.category === CATEGORY.SEGUIDORES ? r.follows : null) },
    { header: 'impressoes', type: 'integer', value: (r) => r.impressions },
    { header: 'cliques_no_link', type: 'integer', value: (r) => r.link_clicks },
  ];
  const csv = toCsv(columns, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `medclinic_${safeFilenamePart(view.id)}_${range.since}_${range.until}${app.snapshot.kind !== 'production' ? '_SINTETICO' : ''}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
  toast(`CSV exportado: ${rows.length} linha(s) anúncio/dia com os filtros atuais.`);
}

// ---------- Colunas de métricas ----------
function metricColumns(view, { withResult = true } = {}) {
  const L = view.kind === 'funnel' ? resultLabels(view) : null;
  const metrics = (t) => deriveMetrics(t, { taxEnabled: state.tax, taxFactor: app.taxFactor, result: view.result || null });
  const cols = [{ key: 'spend', label: state.tax ? 'Invest. (c/ imposto est.)' : 'Invest. (bruto)', num: true, sortValue: (n) => n.totals.spend_cents, cell: (n) => fmtBRL(spendOf(n.totals.spend_cents)) }];
  if (withResult && L) {
    cols.push(
      { key: 'result', label: L.short, num: true, sortValue: (n) => n.totals[view.result], cell: (n) => fmtInt(n.totals[view.result]) },
      { key: 'cost', label: L.cost, num: true, sortValue: (n) => metrics(n.totals).cost_per_result, cell: (n) => costText(metrics(n.totals).cost_per_result, `não calculável: 0 ${L.short.toLowerCase()}`) },
    );
  }
  cols.push(
    { key: 'impressions', label: 'Impressões', num: true, sortValue: (n) => n.totals.impressions, cell: (n) => fmtInt(n.totals.impressions) },
    { key: 'clicks', label: 'Cliques no link', num: true, sortValue: (n) => n.totals.link_clicks, cell: (n) => fmtInt(n.totals.link_clicks) },
    { key: 'ctr', label: 'CTR', num: true, sortValue: (n) => metrics(n.totals).ctr, cell: (n) => fmtPct(metrics(n.totals).ctr) },
    { key: 'cpc', label: 'CPC', num: true, sortValue: (n) => metrics(n.totals).cpc, cell: (n) => costText(metrics(n.totals).cpc, 'não calculável: 0 cliques') },
    { key: 'cpm', label: 'CPM', num: true, sortValue: (n) => metrics(n.totals).cpm, cell: (n) => costText(metrics(n.totals).cpm, 'não calculável: 0 impressões') },
  );
  return cols;
}

function treeSection(view, rows, { overview = false } = {}) {
  const prepared = overview
    ? rows.map((r) => ({ ...r, conversations: r.category === CATEGORY.WHATSAPP ? r.conversations : 0, follows: r.category === CATEGORY.SEGUIDORES ? r.follows : 0 }))
    : rows;
  const nodes = buildTree(prepared).map((c) => {
    const cats = new Set(c.children.map((s) => s.category));
    return { ...c, category: cats.size === 1 ? [...cats][0] : 'misto' };
  });
  const first = {
    key: 'name',
    label: 'Campanha / conjunto / anúncio',
    sortValue: (n) => n.name,
    cell: (n) =>
      h(
        'span',
        { class: 'cell-name' },
        h('span', { class: 'name-text', title: n.id }, n.name),
        n.level === 'campaign' ? h('span', { class: 'meta' }, `${n.account_label} · ${n.id}`) : null,
        n.level === 'adset' ? h('span', { class: 'meta' }, `${n.destination_type || 'destino desconhecido'}${n.optimization_goal ? ` · ${n.optimization_goal}` : ''} · ${n.id}`) : null,
        n.level === 'ad' ? h('span', { class: 'meta' }, n.id) : null,
      ),
  };
  const extra = overview
    ? [
        { key: 'category', label: 'Categoria', sortValue: (n) => (n.category ? CATEGORY_LABELS[n.category] || 'Misto' : null), cell: (n) => (n.level === 'ad' ? '' : categoryBadge(n.category)) },
        { key: 'conv', label: 'Conversas WA', num: true, sortValue: (n) => n.totals.conversations, cell: (n) => fmtInt(n.totals.conversations) },
        { key: 'fol', label: 'Seguidores', num: true, sortValue: (n) => n.totals.follows, cell: (n) => fmtInt(n.totals.follows) },
      ]
    : [];
  const columns = [first, ...extra, ...metricColumns(view, { withResult: !overview })];
  return section(
    'Detalhamento: campanha → conjunto → anúncio',
    overview
      ? 'Todas as campanhas com entrega no período. Conversas contam apenas conjuntos WhatsApp conciliados; seguidores apenas campanhas de seguidores conciliadas.'
      : 'Clique em + para abrir conjuntos e anúncios; clique no cabeçalho para ordenar.',
    nodes.length
      ? treeTable({
          caption: 'Detalhamento por campanha, conjunto e anúncio',
          columns,
          nodes,
          sort: state.treeSort,
          onSort: (s) => ((state.treeSort = s), update()),
          expanded: state.expanded,
          onToggle: (k) => {
            if (state.expanded.has(k)) state.expanded.delete(k);
            else state.expanded.add(k);
            update();
          },
        })
      : h('p', { class: 'empty' }, 'Nenhuma entrega no período/filtros selecionados.'),
  );
}

function categoryBadge(cat) {
  if (!cat) return '';
  const tone = { whatsapp: 'ok', seguidores: 'ok', excluido: 'muted', nao_conciliado: 'warn', nao_classificado: 'warn', misto: 'warn' }[cat] || 'muted';
  return h('span', { class: `badge badge-${tone}` }, CATEGORY_LABELS[cat] || 'Misto (ver conjuntos)');
}

// ---------- Visão de funil (WhatsApp / Seguidores por médico) ----------
function renderFunnel(main, view, range) {
  const map = app.config.campaign_map;
  const doctor = map.doctors[view.doctor];
  const L = resultLabels(view);
  const mapped = mappedCampaignsFor(map, view);
  main.append(
    h(
      'div',
      { class: 'view-head' },
      h('h1', null, `${view.category === 'whatsapp' ? 'WhatsApp' : 'Seguidores'} · ${doctor.label}`),
      h('p', null, `${doctor.specialty} · ${view.category === 'whatsapp' ? 'Resultado = conversas iniciadas no WhatsApp (não são pacientes, agendamentos nem consultas).' : 'Resultado = seguidores do Instagram vindos de campanhas EXCLUSIVAS de seguidores.'}`),
    ),
  );
  const pendingDoctor = pendingDoctorAdsets(app.model, view);
  const pendingDoctorNotice = pendingDoctor.length
    ? notice(
        'warn',
        `${pendingDoctor.length} conjunto(s) de ${view.category === 'seguidores' ? 'seguidores' : 'WhatsApp'} em campanha mista por médico aguardam confirmação do médico e não contam para nenhum médico: `,
        pendingDoctor.map((p, i) => [i ? '; ' : '', h('strong', null, p.adset_name), ` (${p.adset_id}, campanha ${p.campaign_name})`]),
        '.',
      )
    : null;
  if (!mapped.length) {
    main.append(
      h(
        'div',
        { class: 'empty-state' },
        h('h2', null, view.category === 'seguidores' ? 'Nenhuma campanha de seguidores identificada' : 'Nenhuma campanha de WhatsApp mapeada'),
        h(
          'p',
          null,
          view.category === 'seguidores'
            ? `Nenhuma campanha (ou conjunto, em campanha mista) exclusiva de seguidores está confirmada para ${doctor.label}. Seguidores orgânicos ou incidentais de campanhas de WhatsApp não são contados aqui.`
            : `Nenhuma campanha de WhatsApp foi mapeada para ${doctor.label}.`,
        ),
        h('p', null, 'Quando houver campanha confirmada, adicione o campaign_id em config/campaign-map.json com o funil e o médico (ou o médico por conjunto, em campanha mista). O conjunto precisa ter o destination_type esperado para entrar no custo.'),
      ),
    );
    if (pendingDoctorNotice) main.append(pendingDoctorNotice);
    return;
  }
  coverageNotices(range).forEach((n) => main.append(n));
  if (pendingDoctorNotice) main.append(pendingDoctorNotice);
  const rows = filterRows(viewRows(app.model, view), filters(range));
  const totals = sumRows(rows);
  const m = deriveMetrics(totals, { taxEnabled: state.tax, taxFactor: app.taxFactor, result: view.result });
  const identified = range.empty ? [] : identifiedCampaigns(app.model, view, range);
  const idle = identified.filter((c) => !c.delivered);
  const entityFilter = Boolean(state.campaignId || state.adsetId || state.adId);
  if (!range.empty && rows.length === 0 && !entityFilter) {
    main.append(
      notice(
        'info',
        h('strong', null, `${identified.length} campanha(s) de ${view.category === 'seguidores' ? 'seguidores' : 'WhatsApp'} identificada(s) para ${doctor.label}, sem veiculação no período selecionado.`),
        ' Não é ausência de campanha: o investimento e os resultados do período são zero confirmado nos dias coletados.',
      ),
      identifiedSection(identified, 'Campanhas identificadas'),
    );
    return;
  }
  const outside = doctorOutsideCost(app.model, view.doctor, range);
  main.append(
    h(
      'div',
      { class: 'kpis' },
      kpi(spendLabel(), fmtBRL(m.spend), state.tax ? `Bruto ${fmtBRL(m.spend_gross)} · imposto ESTIMADO` : 'Valor bruto da Meta', { hero: true }),
      kpi(L.result, fmtInt(m.results), view.category === 'whatsapp' ? 'onsite_conversion.messaging_conversation_started_7d' : app.snapshot.api.follow_field, { hero: true }),
      kpi(L.cost, m.cost_per_result === null ? DASH : fmtBRL(m.cost_per_result), null, { hero: true, nullReason: m.cost_per_result === null ? `não calculável: 0 ${L.short.toLowerCase()} no período` : `${spendLabel().toLowerCase()} ÷ ${L.short.toLowerCase()}` }),
      kpi('Impressões', fmtInt(m.impressions)),
      kpi('Cliques no link', fmtInt(m.link_clicks)),
      kpi('CTR', fmtPct(m.ctr), null, { nullReason: m.ctr === null ? 'não calculável: 0 impressões' : 'cliques ÷ impressões' }),
      kpi('CPC', m.cpc === null ? DASH : fmtBRL(m.cpc), null, { nullReason: m.cpc === null ? 'não calculável: 0 cliques' : 'investimento ÷ cliques' }),
      kpi('CPM', m.cpm === null ? DASH : fmtBRL(m.cpm), null, { nullReason: m.cpm === null ? 'não calculável: 0 impressões' : 'investimento ÷ impressões × 1000' }),
    ),
  );
  if (outside.totals.rows > 0 && !state.campaignId) {
    const ex = outside.byCategory[CATEGORY.EXCLUIDO];
    const nc = outside.byCategory[CATEGORY.NAO_CONCILIADO];
    main.append(
      notice(
        'info',
        `Fora deste custo no período (${doctor.label}): `,
        ex ? `${fmtBRL(spendOf(ex.spend_cents))} em campanhas fora da captação (LP/site/VideoView)` : '',
        ex && nc ? ' e ' : '',
        nc ? `${fmtBRL(spendOf(nc.spend_cents))} em conjuntos com destino não conciliado (misto/divergente)` : '',
        '. Detalhes na conciliação da visão Geral.',
      ),
    );
  }
  const points = dailySeries(rows, range, { coveredDates: app.model.coveredDates, today: partialDay() });
  const color = DOCTOR_COLOR[view.doctor] || '--series-1';
  const spendPts = points.map((p) => ({ ...p, values: { v: spendOf(p.totals.spend_cents) } }));
  const resPts = points.map((p) => ({ ...p, values: { v: p.totals[view.result] } }));
  const costPts = points.map((p) => ({ ...p, values: { v: ratio(spendOf(p.totals.spend_cents), p.totals[view.result]) } }));
  main.append(
    h(
      'div',
      { class: 'charts' },
      chartCard(spendLabel(), 'por dia', { type: 'bar', points: spendPts, series: [{ key: 'v', label: spendLabel(), color }], format: (v) => fmtBRL(v), axisFormat: fmtAxisBRL }),
      chartCard(L.result, 'por dia', { type: 'bar', points: resPts, series: [{ key: 'v', label: L.result, color }], format: (v) => fmtInt(v), axisFormat: (v) => fmtInt(v), integer: true }),
      chartCard(L.cost, 'por dia · lacunas = não calculável (0 resultados) ou sem coleta', {
        type: 'line',
        points: costPts,
        series: [{ key: 'v', label: L.cost, color }],
        format: (v) => (v === null || v === undefined ? 'não calculável' : fmtBRL(v)),
        axisFormat: fmtAxisBRL,
      }),
    ),
  );
  main.append(dailyTableFunnel(view, points), treeSection(view, rows));
  if (idle.length && !entityFilter) main.append(identifiedSection(idle, 'Campanhas identificadas sem veiculação no período'));
}

function identifiedSection(list, title) {
  const statusText = (c) => (c.effective_status ? c.effective_status : c.discovered ? 'status não informado' : 'não retornada pela descoberta da conta');
  return section(
    title,
    'Campanhas do mapa explícito para esta visão. Em campanha mista por médico, apenas os conjuntos atribuídos a este médico.',
    sortableTable({
      caption: title,
      sort: { key: 'name', dir: 'asc' },
      onSort: () => {},
      items: list,
      columns: [
        { key: 'name', label: 'Campanha', cell: (c) => h('span', { class: 'cell-name' }, h('span', { class: 'name-text' }, c.name), h('span', { class: 'meta' }, `${c.account_label} · ${c.id}${c.doctor_scope === 'adset' ? ' · mista por médico' : ''}`)) },
        { key: 'status', label: 'Status', cell: (c) => statusText(c) },
        {
          key: 'adsets',
          label: 'Conjuntos deste médico',
          cell: (c) =>
            c.adsets.length
              ? h('span', { class: 'cell-name' }, c.adsets.map((a) => h('span', { class: 'meta' }, `${a.name} · ${a.destination_type || 'destino ?'}${a.optimization_goal ? ` · ${a.optimization_goal}` : ''} · ${a.id}`)))
              : h('span', { class: 'muted' }, 'nenhum conjunto descoberto'),
        },
        { key: 'validation', label: 'Validação', cell: (c) => validationBadge(c.validation) },
        { key: 'spend', label: spendLabel(), num: true, cell: (c) => fmtBRL(spendOf(c.totals.spend_cents)) },
      ],
    }),
  );
}

function validationBadge(v) {
  const map = { pendente: ['warn', 'a validar'], destino_conferido: ['muted', 'destino conferido (API)'], conferido: ['ok', 'conferido com a UI'] };
  const [tone, label] = map[v] || map.pendente;
  return h('span', { class: `badge badge-${tone}` }, label);
}

function dailyTableFunnel(view, points) {
  const L = resultLabels(view);
  const metrics = (t) => deriveMetrics(t, { taxEnabled: state.tax, taxFactor: app.taxFactor, result: view.result });
  const na = (p, fn) => (p.covered ? fn() : h('span', { class: 'na' }, 'sem coleta'));
  const columns = [
    { key: 'date', label: 'Data', sortValue: (p) => p.date, cell: (p) => h('span', null, `${weekdayBR(p.date)} ${formatDateBR(p.date)}`, p.partial ? h('span', { class: 'badge badge-warn' }, 'parcial') : null) },
    { key: 'spend', label: state.tax ? 'Invest. (c/ imposto est.)' : 'Invest. (bruto)', num: true, sortValue: (p) => (p.covered ? p.totals.spend_cents : null), cell: (p) => na(p, () => fmtBRL(spendOf(p.totals.spend_cents))) },
    { key: 'result', label: L.short, num: true, sortValue: (p) => (p.covered ? p.totals[view.result] : null), cell: (p) => na(p, () => fmtInt(p.totals[view.result])) },
    { key: 'cost', label: L.cost, num: true, sortValue: (p) => (p.covered ? metrics(p.totals).cost_per_result : null), cell: (p) => na(p, () => costText(metrics(p.totals).cost_per_result, 'não calculável')) },
    { key: 'impressions', label: 'Impressões', num: true, sortValue: (p) => (p.covered ? p.totals.impressions : null), cell: (p) => na(p, () => fmtInt(p.totals.impressions)) },
    { key: 'clicks', label: 'Cliques', num: true, sortValue: (p) => (p.covered ? p.totals.link_clicks : null), cell: (p) => na(p, () => fmtInt(p.totals.link_clicks)) },
    { key: 'ctr', label: 'CTR', num: true, sortValue: (p) => (p.covered ? metrics(p.totals).ctr : null), cell: (p) => na(p, () => fmtPct(metrics(p.totals).ctr)) },
    { key: 'cpc', label: 'CPC', num: true, sortValue: (p) => (p.covered ? metrics(p.totals).cpc : null), cell: (p) => na(p, () => costText(metrics(p.totals).cpc, 'não calculável')) },
    { key: 'cpm', label: 'CPM', num: true, sortValue: (p) => (p.covered ? metrics(p.totals).cpm : null), cell: (p) => na(p, () => costText(metrics(p.totals).cpm, 'não calculável')) },
  ];
  return section(
    'Tabela diária',
    'Custos do dia = razão dos totais do dia. “—” = não calculável (denominador zero); “sem coleta” = dia não coletado.',
    sortableTable({ caption: 'Tabela diária', columns, items: points, sort: state.dailySort, onSort: (s) => ((state.dailySort = s), update()), rowClass: (p) => (p.partial ? 'row-partial' : !p.covered ? 'row-uncovered' : null) }),
  );
}

// ---------- Visão Geral ----------
const OVERVIEW_SERIES = [
  { key: 'wa_taisa', label: 'WhatsApp Taísa', color: '--series-1' },
  { key: 'wa_ailton', label: 'WhatsApp Ailton', color: '--series-2' },
  { key: 'seguidores', label: 'Seguidores', color: '--series-3' },
  { key: 'excluido', label: 'Fora da captação', color: '--series-4' },
  { key: 'pendente', label: 'Pendente de conciliação', color: '--series-5' },
];

function overviewBucket(r) {
  if (r.category === CATEGORY.WHATSAPP) return r.doctor === 'taisa' ? 'wa_taisa' : r.doctor === 'ailton' ? 'wa_ailton' : 'pendente';
  if (r.category === CATEGORY.SEGUIDORES) return 'seguidores';
  if (r.category === CATEGORY.EXCLUIDO) return 'excluido';
  return 'pendente';
}

function renderOverview(main, view, range) {
  const map = app.config.campaign_map;
  main.append(
    h(
      'div',
      { class: 'view-head' },
      h('h1', null, 'Visão geral · MedClinic Bauru/SP'),
      h('p', null, 'Investimento Meta por categoria e comparação entre médicos. Conversas iniciadas no WhatsApp e seguidores são resultados distintos e nunca são somados.'),
    ),
  );
  coverageNotices(range).forEach((n) => main.append(n));
  const rows = filterRows(app.model.rows, filters(range));
  const rec = reconciliation(app.model, rows, range);
  const total = sumRows(rows);
  const cat = rec.byCategory;
  const pendingCents = cat.nao_conciliado.spend_cents + cat.nao_classificado.spend_cents;
  const classifiedCents = cat.whatsapp.spend_cents + cat.seguidores.spend_cents + cat.excluido.spend_cents;
  main.append(
    h(
      'div',
      { class: 'kpis' },
      kpi(`${spendLabel()} — total`, fmtBRL(spendOf(total.spend_cents)), state.tax ? `Bruto ${fmtBRL(total.spend_cents / 100)} · imposto ESTIMADO` : 'Todas as campanhas com entrega nas 2 contas', { hero: true }),
      kpi('Classificado', fmtBRL(spendOf(classifiedCents)), 'WhatsApp + Seguidores + Fora da captação'),
      kpi('WhatsApp (conciliado)', fmtBRL(spendOf(cat.whatsapp.spend_cents)), `${fmtInt(cat.whatsapp.conversations)} conversas iniciadas`),
      kpi('Seguidores (conciliado)', fmtBRL(spendOf(cat.seguidores.spend_cents)), cat.seguidores.rows ? `${fmtInt(cat.seguidores.follows)} seguidores` : 'Nenhuma campanha de seguidores identificada'),
      kpi('Fora da captação', fmtBRL(spendOf(cat.excluido.spend_cents)), 'LP/site/VideoView — fora de qualquer custo'),
      kpi('Pendente de conciliação', fmtBRL(spendOf(pendingCents)), 'Não classificado ou destino misto/divergente', { tone: pendingCents > 0 ? 'warn' : null }),
    ),
  );

  // Comparativo por médico (denominadores próprios).
  const doctorRows = Object.entries(map.doctors).map(([id, d]) => {
    const by = rec.byDoctor[id] || {};
    const wa = by.whatsapp || emptyTotals();
    const sg = by.seguidores || emptyTotals();
    const mw = deriveMetrics(wa, { taxEnabled: state.tax, taxFactor: app.taxFactor, result: 'conversations' });
    const ms = deriveMetrics(sg, { taxEnabled: state.tax, taxFactor: app.taxFactor, result: 'follows' });
    const hasFollowers = mappedCampaignsFor(map, { kind: 'funnel', doctor: id, category: 'seguidores' }).length > 0;
    return {
      id,
      label: d.label,
      wa_spend: mw.spend,
      wa_conv: wa.conversations,
      cpl: mw.cost_per_result,
      sg_spend: hasFollowers ? ms.spend : null,
      sg_fol: hasFollowers ? sg.follows : null,
      cps: hasFollowers ? ms.cost_per_result : null,
      hasFollowers,
      excl: spendOf((by.excluido || emptyTotals()).spend_cents),
      nc: spendOf((by.nao_conciliado || emptyTotals()).spend_cents),
    };
  });
  const noFollow = (r, fn) => (r.hasFollowers ? fn() : h('span', { class: 'na', title: 'Nenhuma campanha de seguidores identificada' }, 'sem campanha'));
  main.append(
    section(
      'Comparativo por médico',
      'Cada custo usa o próprio denominador: CPL = investimento WhatsApp ÷ conversas WhatsApp; CPS = investimento de campanhas de seguidores ÷ seguidores dessas campanhas.',
      sortableTable({
        caption: 'Comparativo por médico',
        sort: { key: 'label', dir: 'asc' },
        onSort: () => {},
        items: doctorRows,
        columns: [
          { key: 'label', label: 'Médico', cell: (r) => h('span', { class: 'cell-key' }, h('span', { class: 'key key-rect', dataset: { color: DOCTOR_COLOR[r.id] } }), r.label) },
          { key: 'wa_spend', label: 'Invest. WhatsApp', num: true, cell: (r) => fmtBRL(r.wa_spend) },
          { key: 'wa_conv', label: 'Conversas', num: true, cell: (r) => fmtInt(r.wa_conv) },
          { key: 'cpl', label: 'Custo por conversa', num: true, cell: (r) => costText(r.cpl, 'não calculável: 0 conversas') },
          { key: 'sg_spend', label: 'Invest. Seguidores', num: true, cell: (r) => noFollow(r, () => fmtBRL(r.sg_spend)) },
          { key: 'sg_fol', label: 'Seguidores', num: true, cell: (r) => noFollow(r, () => fmtInt(r.sg_fol)) },
          { key: 'cps', label: 'Custo por seguidor', num: true, cell: (r) => noFollow(r, () => costText(r.cps, 'não calculável: 0 seguidores')) },
          { key: 'excl', label: 'Fora da captação', num: true, cell: (r) => fmtBRL(r.excl) },
          { key: 'nc', label: 'Destino não conciliado', num: true, cell: (r) => fmtBRL(r.nc) },
        ],
      }),
    ),
  );

  // Gráficos diários.
  const byDay = new Map();
  for (const r of rows) {
    let d = byDay.get(r.date);
    if (!d) {
      d = { buckets: Object.fromEntries(OVERVIEW_SERIES.map((s) => [s.key, emptyTotals()])) };
      byDay.set(r.date, d);
    }
    addRowInto(d.buckets[overviewBucket(r)], r);
  }
  const base = dailySeries(rows, range, { coveredDates: app.model.coveredDates, today: partialDay() });
  const bucketOf = (date, key) => byDay.get(date)?.buckets[key] || emptyTotals();
  const stackPts = base.map((p) => ({ ...p, values: Object.fromEntries(OVERVIEW_SERIES.map((s) => [s.key, spendOf(bucketOf(p.date, s.key).spend_cents)])) }));
  const docSeries = [
    { key: 'wa_taisa', label: 'Dra. Taísa', color: DOCTOR_COLOR.taisa },
    { key: 'wa_ailton', label: 'Dr. Ailton', color: DOCTOR_COLOR.ailton },
  ];
  const convPts = base.map((p) => ({ ...p, values: { wa_taisa: bucketOf(p.date, 'wa_taisa').conversations, wa_ailton: bucketOf(p.date, 'wa_ailton').conversations } }));
  const cplPts = base.map((p) => ({
    ...p,
    values: Object.fromEntries(docSeries.map((s) => [s.key, ratio(spendOf(bucketOf(p.date, s.key).spend_cents), bucketOf(p.date, s.key).conversations)])),
  }));
  main.append(
    h(
      'div',
      { class: 'charts' },
      chartCard(`${spendLabel()} por categoria`, 'por dia, empilhado', { type: 'stacked', points: stackPts, series: OVERVIEW_SERIES, format: (v) => fmtBRL(v), axisFormat: fmtAxisBRL }),
      chartCard('Conversas iniciadas no WhatsApp', 'por dia e médico (conjuntos conciliados)', { type: 'line', points: convPts, series: docSeries, format: (v) => fmtInt(v), axisFormat: (v) => fmtInt(v), integer: true }),
      chartCard('Custo por conversa', 'por dia e médico · lacunas = não calculável', { type: 'line', points: cplPts, series: docSeries, format: (v) => (v === null || v === undefined ? 'não calculável' : fmtBRL(v)), axisFormat: fmtAxisBRL }),
    ),
  );

  // Tabela diária (visão tabular dos gráficos).
  const na = (p, fn) => (p.covered ? fn() : h('span', { class: 'na' }, 'sem coleta'));
  const dailyCols = [
    { key: 'date', label: 'Data', sortValue: (p) => p.date, cell: (p) => h('span', null, `${weekdayBR(p.date)} ${formatDateBR(p.date)}`, p.partial ? h('span', { class: 'badge badge-warn' }, 'parcial') : null) },
    { key: 'total', label: 'Total', num: true, sortValue: (p) => (p.covered ? p.totals.spend_cents : null), cell: (p) => na(p, () => fmtBRL(spendOf(p.totals.spend_cents))) },
    ...OVERVIEW_SERIES.map((s) => ({ key: s.key, label: s.label, num: true, sortValue: (p) => (p.covered ? bucketOf(p.date, s.key).spend_cents : null), cell: (p) => na(p, () => fmtBRL(spendOf(bucketOf(p.date, s.key).spend_cents))) })),
    { key: 'conv_t', label: 'Conversas Taísa', num: true, sortValue: (p) => (p.covered ? bucketOf(p.date, 'wa_taisa').conversations : null), cell: (p) => na(p, () => fmtInt(bucketOf(p.date, 'wa_taisa').conversations)) },
    { key: 'conv_a', label: 'Conversas Ailton', num: true, sortValue: (p) => (p.covered ? bucketOf(p.date, 'wa_ailton').conversations : null), cell: (p) => na(p, () => fmtInt(bucketOf(p.date, 'wa_ailton').conversations)) },
  ];
  main.append(
    section('Tabela diária', 'Investimento por categoria e conversas por médico.', sortableTable({ caption: 'Tabela diária geral', columns: dailyCols, items: base, sort: state.dailySort, onSort: (s) => ((state.dailySort = s), update()), rowClass: (p) => (p.partial ? 'row-partial' : !p.covered ? 'row-uncovered' : null) })),
  );

  main.append(reconciliationSection(rec, total), treeSection(view, rows, { overview: true }), methodologySection());
}

function reconciliationSection(rec, total) {
  const pct = (c) => (total.spend_cents > 0 ? fmtPct((c / total.spend_cents) * 100) : DASH);
  const cats = [
    [CATEGORY.WHATSAPP, 'Entra no custo por conversa (CPL).'],
    [CATEGORY.SEGUIDORES, 'Entra no custo por seguidor (CPS).'],
    [CATEGORY.EXCLUIDO, 'LP/site/VideoView: fora de qualquer custo.'],
    [CATEGORY.NAO_CONCILIADO, 'Mapeado, mas destino do conjunto misto/divergente/desconhecido: fora do custo.'],
    [CATEGORY.NAO_CLASSIFICADO, 'Campanha fora do mapa explícito: fora do custo até ser classificada.'],
  ];
  const entityFilter = Boolean(state.campaignId || state.adsetId || state.adId);
  const doctors = app.config.campaign_map.doctors;
  const pendingCols = [
    { key: 'campaign', label: 'Campanha', sortValue: (p) => p.campaign_name, cell: (p) => h('span', { class: 'cell-name' }, h('span', { class: 'name-text' }, p.campaign_name), h('span', { class: 'meta' }, `${p.account_label} · ${p.campaign_id}${p.campaign_objective ? ` · ${p.campaign_objective}` : ''}${p.campaign_status ? ` · ${p.campaign_status}` : ''}`)) },
    { key: 'adset', label: 'Conjunto', sortValue: (p) => p.adset_name, cell: (p) => h('span', { class: 'cell-name' }, h('span', { class: 'name-text' }, p.adset_name), h('span', { class: 'meta' }, p.adset_id)) },
    { key: 'dest', label: 'Destino', sortValue: (p) => p.destination_type, cell: (p) => p.destination_type || 'desconhecido' },
    { key: 'status', label: 'Situação', sortValue: (p) => p.category, cell: (p) => h('span', null, categoryBadge(p.category), h('span', { class: 'meta' }, p.reason)) },
    { key: 'hint', label: 'Médico / sugestão', sortValue: (p) => p.suggestion || p.doctor, cell: (p) => (p.doctor ? doctors[p.doctor]?.label : p.doctor_pending ? 'médico a confirmar (conjunto)' : p.suggestion ? `${p.suggestion} (não aplicada)` : '') },
    { key: 'spend', label: state.tax ? 'Invest. (c/ imposto est.)' : 'Invest. (bruto)', num: true, sortValue: (p) => p.totals.spend_cents, cell: (p) => fmtBRL(spendOf(p.totals.spend_cents)) },
  ];
  return section(
    'Conciliação do investimento',
    'Todo o gasto das contas é distribuído em categorias; apenas WhatsApp e Seguidores conciliados entram em custos. Nada é contado em dobro.',
    sortableTable({
      caption: 'Investimento por categoria',
      sort: { key: 'cat', dir: 'asc' },
      onSort: () => {},
      items: cats.map(([k, note]) => ({ k, note, t: rec.byCategory[k] })),
      columns: [
        { key: 'cat', label: 'Categoria', cell: (r) => categoryBadge(r.k) },
        { key: 'spend', label: spendLabel(), num: true, cell: (r) => fmtBRL(spendOf(r.t.spend_cents)) },
        { key: 'pct', label: '% do total', num: true, cell: (r) => pct(r.t.spend_cents) },
        { key: 'note', label: 'Regra', cell: (r) => r.note },
      ],
    }),
    h('h3', { class: 'sub-h' }, 'Conferência com o total da conta (nível conta, Meta)'),
    entityFilter
      ? h('p', { class: 'muted' }, 'Disponível apenas sem filtro de campanha/conjunto/anúncio.')
      : sortableTable({
          caption: 'Conferência por conta',
          sort: { key: 'label', dir: 'asc' },
          onSort: () => {},
          items: rec.accountCheck,
          columns: [
            { key: 'label', label: 'Conta', cell: (a) => a.label },
            { key: 'acc', label: 'Total da conta (bruto)', num: true, cell: (a) => fmtBRL(a.account_spend_cents / 100) },
            { key: 'ads', label: 'Soma dos anúncios coletados (bruto)', num: true, cell: (a) => fmtBRL(a.ad_spend_cents / 100) },
            {
              key: 'diff',
              label: 'Diferença',
              num: true,
              cell: (a) => {
                const tol = Math.max(Math.round((app.config.reconciliation?.max_abs_diff_brl ?? 1) * 100), Math.round(a.account_spend_cents * (app.config.reconciliation?.max_rel_diff ?? 0.01)));
                if (a.diff_cents === 0) return h('span', { class: 'ok' }, '✓ R$ 0,00');
                return Math.abs(a.diff_cents) <= tol
                  ? h('span', { class: 'ok', title: 'Dentro da tolerância configurada' }, `✓ ${fmtBRL(a.diff_cents / 100)} (tolerância)`)
                  : h('span', { class: 'warn-text', title: 'Acima da tolerância: investigar (anúncios excluídos, filtro de status, atraso da Meta)' }, `! ${fmtBRL(a.diff_cents / 100)}`);
              },
            },
            { key: 'days', label: 'Dias cobertos', num: true, cell: (a) => fmtInt(a.covered_days) },
          ],
        }),
    h('h3', { class: 'sub-h' }, `Pendências de conciliação (${rec.pending.length})`),
    rec.pending.length
      ? sortableTable({ caption: 'Pendências de conciliação', columns: pendingCols, items: rec.pending, sort: state.pendingSort, onSort: (s) => ((state.pendingSort = s), update()) })
      : h('p', { class: 'ok' }, '✓ Nenhuma pendência no período.'),
    h('h3', { class: 'sub-h' }, `Fora da captação (${rec.excluded.length})`),
    rec.excluded.length
      ? sortableTable({ caption: 'Campanhas fora da captação', columns: pendingCols, items: rec.excluded, sort: state.pendingSort, onSort: (s) => ((state.pendingSort = s), update()) })
      : h('p', { class: 'muted' }, 'Nenhum gasto fora da captação no período.'),
  );
}

function methodologySection() {
  const snap = app.snapshot;
  const api = snap.api || {};
  const map = app.config.campaign_map;
  const states = { pendente: 0, destino_conferido: 0, conferido: 0 };
  for (const [id, e] of Object.entries(map.campaigns)) if (!id.startsWith('$')) states[e.validation || 'pendente'] = (states[e.validation || 'pendente'] || 0) + 1;
  const effective = api.effective_versions || [];
  const versionMismatch = effective.length && !effective.includes(api.requested_version);
  const f = freshness();
  const item = (k, ...v) => h('div', { class: 'dl-row' }, h('dt', null, k), h('dd', null, ...v));
  return section(
    'Coleta, cobertura e metodologia',
    null,
    h(
      'dl',
      { class: 'dl' },
      item('Fonte', 'Meta Marketing API, somente leitura (Insights nível anúncio/dia). Sem Google, CRM, planilhas, ROAS ou faturamento.'),
      item('Snapshot gerado', `${formatDateTimeBR(snap.generated_at)} (horário de Brasília) · ${fmtMinutesAgo((Date.now() - Date.parse(snap.generated_at)) / 60000)} · modo ${snap.collection?.mode === 'incremental' ? 'incremental' : 'completo'}`),
      ...snap.accounts.map((a) =>
        item(
          `Conta ${a.label}`,
          `${a.name || a.id} · última coleta com sucesso ${formatDateTimeBR(a.last_success_at)} · cobertura ${formatDateBR(a.coverage.since)}–${formatDateBR(a.coverage.until)}`,
          a.recollected_range ? ` · recoletado ${formatDateBR(a.recollected_range.since)}–${formatDateBR(a.recollected_range.until)}` : '',
          ...(a.warnings || []).map((w) => h('div', { class: 'warn-text' }, `! ${w}`)),
        ),
      ),
      item('Atraso', h('span', { class: f.level === 'ok' ? 'ok' : 'warn-text' }, `${fmtMinutesAgo(f.minutes)} desde a coleta mais antiga entre as contas`)),
      item('Versão da API', `solicitada ${api.requested_version || 'n/d'} · efetiva (header facebook-api-version) ${effective.join(', ') || 'n/d'}`, versionMismatch ? h('div', { class: 'warn-text' }, '! A versão efetiva difere da solicitada.') : ''),
      item('Atribuição', api.attribution_rule || 'n/d', api.action_report_time ? ` · action_report_time=${api.action_report_time}` : ' · action_report_time padrão da API'),
      item('Conversas (WhatsApp)', `actions[action_type = ${api.conversation_action_type}], somente conjuntos com destination_type WHATSAPP. Não usa total_messaging_connection nem first_reply; Messenger/Instagram Direct não contam.`),
      item('Seguidores', `campo ${api.follow_field}, somente campanhas mapeadas como seguidores com destino conciliado. Seguidores incidentais de campanhas de WhatsApp não contam.`),
      item('Imposto Meta', `${app.config.tax.label}: bruto × 1/${String(app.config.tax.net_share).replace('.', ',')} ≈ ${fmtDec(app.taxFactor, 9)} — aplicado uma única vez sobre o bruto; ${state.tax ? 'ligado' : 'desligado'} agora. Pendente de confirmação fiscal.`),
      item('Custos', 'Razão dos totais do período (não média de custos diários). Denominador zero = não calculável (—).'),
      item('Mapa de classificação', `versão ${map.version} · ${Object.keys(map.campaigns).filter((k) => !k.startsWith('$')).length} campanhas mapeadas · ${states.conferido} conferidas com a UI · ${states.destino_conferido} com destino conferido via API (resultados a comparar com a UI) · ${states.pendente} a validar`),
      item('Alcance/frequência', 'Não exibidos: alcance não pode ser somado entre dias/anúncios e não é inventado.'),
      item('Build', `${formatDateTimeBR(app.config.build?.built_at)}${app.config.build?.commit ? ` · commit ${app.config.build.commit.slice(0, 7)}` : ''}`),
    ),
  );
}

// ---------- Render ----------
function render() {
  if (!app.snapshot) return;
  const view = findView(state.view);
  const range = currentRange();
  writeHash();
  renderStatus();
  renderTabs();
  renderFilters(view, range);
  const main = $('main');
  clear(main);
  if (view.kind === 'overview') renderOverview(main, view, range);
  else renderFunnel(main, view, range);
  for (const el of document.querySelectorAll('.key[data-color]')) el.style.setProperty('--key-color', `var(${el.dataset.color})`);
  document.title = `${view.label} · MedClinic`;
}

function update() {
  render();
}

function renderFatal(message) {
  const main = $('main');
  clear(main);
  main.append(
    h(
      'div',
      { class: 'empty-state' },
      h('h1', null, 'Dados indisponíveis'),
      h('p', null, message),
      h('p', null, 'Nenhum dado de demonstração é exibido. Se a primeira coleta real ainda não foi publicada, isso é esperado.'),
    ),
  );
}

async function init() {
  applyTheme(storedTheme());
  readHash();
  try {
    await load();
  } catch (e) {
    renderFatal(`Não foi possível carregar o snapshot (${e.message}).`);
    return;
  }
  if (!state.preset) state.preset = app.config.ui.default_preset || 'month_to_yesterday';
  if (!new URLSearchParams(location.hash.slice(1)).has('imp')) state.tax = app.config.tax.enabled_by_default !== false;
  window.addEventListener('hashchange', () => {
    readHash();
    render();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => render());
  render();
}

init();
