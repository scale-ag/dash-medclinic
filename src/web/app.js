// Dashboard MedClinic — captação por conversas iniciadas no WhatsApp e seguidores, por médico.
// Fonte única: snapshot coletado da Meta Marketing API (somente leitura). Nenhum dado de demonstração:
// se o snapshot não carregar, a página mostra o erro; se for sintético, mostra uma faixa de alerta.
// Layout no padrão visual dos dashboards da agência Scale (sidebar, topbar, funil + painel combinado).
import { h, clear, put } from './dom.js';
import { renderGoogle } from './google.js';
import { renderTimeChart, renderComboChart } from './charts.js';
import { sortableTable } from './tables.js';
import { hierarchy, adRanking } from './hierarchy.js';
import { periodPicker } from './period.js';
import { PRESET_IDS, presetRange, dateInTimeZone, formatDateBR, formatDateTimeBR, isIsoDate, diffDays, weekdayBR } from './shared/dates.js';
import {
  VIEWS,
  findView,
  buildModel,
  viewRows,
  mappedCampaignsFor,
  filterRows,
  filterOptions,
  dailySeries,
  reconciliation,
  doctorOutsideCost,
  coverageSummary,
  identifiedCampaigns,
  pendingDoctorAdsets,
  followersStatus,
} from './shared/model.js';
import { sumRows, deriveMetrics, taxFactorFromConfig, spendBRL, ratio, emptyTotals, addRowInto } from './shared/metrics.js';
import { CATEGORY, CATEGORY_LABELS } from './shared/classify.js';
import { fmtBRL, fmtInt, fmtPct, fmtAxisBRL, fmtMinutesAgo, fmtDec, DASH } from './shared/format.js';
import { toCsv, safeFilenamePart } from './shared/csv.js';

const TZ = 'America/Sao_Paulo';
const NAV_ICON = { overview: '◱', whatsapp: '◨', seguidores: '♥' };
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
  pendingSort: { key: 'spend', dir: 'desc' },
  open: new Set(),
};

const $ = (id) => document.getElementById(id);

// ---------- Estado na URL ----------
function readHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const v = p.get('v');
  if (v && (v === 'google' || VIEWS.some((x) => x.id === v))) state.view = v;
  const preset = p.get('p');
  if (preset && PRESET_IDS.has(preset)) state.preset = preset;
  if (isIsoDate(p.get('de') || '')) state.since = p.get('de');
  if (isIsoDate(p.get('ate') || '')) state.until = p.get('ate');
  for (const [k, q] of [['campaignId', 'c'], ['adsetId', 'cj'], ['adId', 'an']]) {
    const val = p.get(q) || '';
    state[k] = /^\d{1,25}(,\d{1,25})*$/.test(val) ? val : '';
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

// ---------- Menu lateral (mobile) ----------
function setNav(open, { focus = false } = {}) {
  document.body.classList.toggle('nav-open', open);
  const btn = $('navBtn');
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  }
  if (open && focus) $('tabs').querySelector('.nav-item')?.focus();
  if (!open && focus) btn?.focus();
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
  app.google = await fetchJson(`./data/google.json${bust}`).catch(() => null);
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
  return presetRange(state.preset, today(), { since: state.since, until: state.until, dataStart: app.snapshot.data_start });
}
function filters(range) {
  return { range, campaignId: state.campaignId, adsetId: state.adsetId, adId: state.adId };
}
function entityFilterActive() {
  return Boolean(state.campaignId || state.adsetId || state.adId);
}
function spendOf(cents) {
  return spendBRL(cents, { taxEnabled: state.tax, taxFactor: app.taxFactor });
}
function spendLabel() {
  return state.tax ? 'Investimento (c/ imposto estimado)' : 'Investimento (bruto)';
}
function spendShort() {
  return state.tax ? 'Invest. (c/ imposto est.)' : 'Invest. (bruto)';
}
function resultLabels(view) {
  return view.result === 'conversations'
    ? { result: 'Conversas iniciadas', short: 'Conversas', cost: 'Custo por conversa', unit: 'conversa', sub: 'Conversas atribuídas aos anúncios no período', bar: '--chart-conv', costColor: '--chart-cost', heat: 'conv', step: 'hl-conv' }
    : { result: 'Seguidores', short: 'Seguidores', cost: 'Custo por seguidor', unit: 'seguidor', sub: 'Seguidores atribuídos aos anúncios no período', bar: '--chart-seg', costColor: '--chart-cps', heat: 'seg', step: 'hl-seg' };
}
function rangeText(range) {
  if (range.empty) return 'Sem dias completos no período';
  const n = diffDays(range.since, range.until) + 1;
  return `${formatDateBR(range.since)} – ${formatDateBR(range.until)} (${n} ${n === 1 ? 'dia' : 'dias'})`;
}

// ---------- Componentes ----------
function notice(kind, ...content) {
  const icon = { info: 'ℹ', warn: '!', critical: '×', ok: '✓' }[kind] || 'ℹ';
  return h('div', { class: `notice notice-${kind}`, role: kind === 'critical' ? 'alert' : null }, h('span', { class: 'notice-icon', 'aria-hidden': 'true' }, icon), h('div', null, ...content));
}

function secTitle(text) {
  return h('h2', { class: 'sec-title' }, text);
}

function card(...content) {
  return h('section', { class: 'card' }, ...content);
}

/** Disclosure fechado por padrão; lembra o estado aberto durante a sessão. */
function disclosure(id, title, hint, ...content) {
  const d = h('details', { class: 'disclosure', open: state.open.has(id) }, h('summary', null, title, hint ? h('span', { class: 'hint' }, hint) : null), h('div', { class: 'disclosure-body' }, ...content));
  d.addEventListener('toggle', () => (d.open ? state.open.add(id) : state.open.delete(id)));
  return d;
}

/** Card de etapa do funil: valor principal à esquerda, secundárias alinhadas à direita. */
function step({ label, value, sub, secs = [], tone = '', extra = null, title = null }) {
  return h(
    'div',
    { class: `step ${tone}`.trim(), title },
    h('div', { class: 'step-main' }, h('div', { class: 'm-label' }, label), h('div', { class: 'm-val' }, value)),
    secs.length ? h('div', { class: 'secs' }, secs.map(([l, v, t]) => h('div', { title: t || null }, h('span', { class: 's-label' }, l), h('span', { class: 's-val' }, v)))) : null,
    sub ? h('div', { class: 'm-sub' }, sub) : null,
    extra,
  );
}

function costText(v, nullReason) {
  return v === null || v === undefined ? h('span', { class: 'na', title: nullReason }, DASH) : fmtBRL(v);
}

function dayCell(p) {
  return h('span', null, `${weekdayBR(p.date)} ${formatDateBR(p.date)}`, p.partial ? h('span', { class: 'badge badge-warn' }, 'parcial') : null);
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

// ---------- Frescor / recarga ----------
function freshness() {
  const times = app.snapshot.accounts.map((a) => Date.parse(a.last_success_at)).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : NaN;
  const minutes = (Date.now() - oldest) / 60000;
  const ui = app.config.ui || {};
  const level = !Number.isFinite(minutes) ? 'critical' : minutes > (ui.freshness_critical_minutes ?? 360) ? 'critical' : minutes > (ui.freshness_warn_minutes ?? 90) ? 'warn' : 'ok';
  return { oldest, minutes, level };
}

async function reloadData() {
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
    $('refreshBtn')?.focus();
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

// ---------- Sidebar ----------
function renderSidebar() {
  const nav = $('tabs');
  clear(nav);
  put(
    nav,
    VIEWS.map((v) =>
      h(
        'a',
        {
          href: `#v=${v.id}`,
          class: `nav-item${v.id === state.view ? ' active' : ''}`,
          'aria-current': v.id === state.view ? 'page' : null,
          onClick: (e) => {
            e.preventDefault();
            state.view = v.id;
            setNav(false);
            update();
            $('main').focus({ preventScroll: true });
          },
        },
        h('span', { class: 'ic', 'aria-hidden': 'true' }, NAV_ICON[v.kind === 'overview' ? 'overview' : v.category]),
        v.label,
      ),
    ),
  );
  const b = app.config.build || {};
  put(nav, h('a', {href:'#v=google', class:'nav-item' + (state.view === 'google' ? ' active' : ''),
    onClick(e) {e.preventDefault(); state.view='google'; setNav(false); update();}}, 'Google Ads'));
  $('buildFoot').textContent = b.built_at ? `Build ${formatDateTimeBR(b.built_at)}${b.commit ? ` · ${b.commit.slice(0, 7)}` : ''}` : '';
}

// ---------- Topbar ----------
function renderTopbar(view, range) {
  const root = $('topbar');
  clear(root);
  const td = today();
  const f = freshness();
  const open = document.body.classList.contains('nav-open');
  put(
    root,
    h('button', { type: 'button', class: 'ham', id: 'navBtn', 'aria-controls': 'sidebar', 'aria-expanded': open ? 'true' : 'false', 'aria-label': open ? 'Fechar menu' : 'Abrir menu', onClick: () => setNav(!document.body.classList.contains('nav-open'), { focus: true }) }, '☰'),
    h('h1', { class: 'ptitle' }, view.label),
    h('div', { class: 'sep', 'aria-hidden': 'true' }),
    periodPicker({ preset: state.preset, range, today: td, start: app.snapshot.data_start, apply(preset, since, until) {
      Object.assign(state, { preset, since, until });
      update();
      document.querySelector('.period-trigger')?.focus();
    } }),
    h('button', { type: 'button', class: 'btn', onClick: clearFilters }, 'Remover Filtros'),
    h('div', { class: 'sep', 'aria-hidden': 'true' }),
    h(
      'button',
      {
        type: 'button',
        class: 'tax-toggle',
        role: 'switch',
        'aria-checked': state.tax ? 'true' : 'false',
        title: app.config.tax.description,
        onClick: () => {
          state.tax = !state.tax;
          update();
        },
      },
      h('span', { class: 'toggle-track', 'aria-hidden': 'true' }, h('span', { class: 'toggle-thumb' })),
      h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-label' }, 'Imposto Meta'), h('span', { class: 'toggle-note' }, app.config.tax.label || 'ESTIMATIVA')),
    ),
    h('button', { type: 'button', class: 'btn', onClick: toggleTheme, 'aria-label': `Alternar tema (atual: ${currentTheme() === 'dark' ? 'escuro' : 'claro'})` }, h('span', { 'aria-hidden': 'true' }, '◐'), 'Tema'),
    h('div', { class: 'spacer' }),
    h(
      'div',
      { class: 'updated', title: 'Coleta mais antiga entre as contas (horário de Brasília)' },
      h('span', { class: `fresh-${f.level}` }, f.level === 'ok' ? '● Última atualização' : f.level === 'warn' ? '● Atualização com atraso' : '● Dados desatualizados'),
      h('br'),
      Number.isFinite(f.oldest) ? [h('strong', null, formatDateTimeBR(new Date(f.oldest).toISOString())), ` · ${fmtMinutesAgo(f.minutes)}`] : 'sem data',
    ),
    h('button', { type: 'button', class: 'btn primary', id: 'refreshBtn', onClick: reloadData, title: 'Recarrega o snapshot publicado. A coleta roda automaticamente (~30 min); este botão não dispara coleta.' }, h('span', { 'aria-hidden': 'true' }, '↻'), 'Atualizar Dados'),
  );
  const banner = $('banner');
  clear(banner);
  if (app.snapshot.kind !== 'production') {
    banner.append(notice('critical', h('strong', null, 'DADOS SINTÉTICOS DE TESTE'), ' — gerados localmente para validar a interface. Não representam a MedClinic e nunca são publicados.'));
  }
}

// ---------- Filtros secundários ----------
function renderSubbar(view, range) {
  const root = $('filters');
  clear(root);
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
        { class: 'select', onChange: (e) => onChange(e.target.value) },
        h('option', { value: '', selected: !value }, allLabel),
        list.map((o) => h('option', { value: o.id, selected: o.id === value }, o.name)),
        value && !known ? h('option', { value, selected: true }, `${value.includes(',') ? value.split(',').length + ' selecionados' : '(sem dados nesta visão/período) ' + value}`) : null,
      ),
    );
  };
  put(
    root,
    select('Campanha', state.campaignId, opts.campaigns, 'Todas', (v) => {
      state.campaignId = v;
      state.adsetId = '';
      state.adId = '';
      update();
    }),
    select('Conjunto', state.adsetId, opts.adsets, 'Todos', (v) => {
      state.adsetId = v;
      state.adId = '';
      update();
    }),
    select('Anúncio', state.adId, opts.ads, 'Todos', (v) => {
      state.adId = v;
      update();
    }),
    h('button', { type: 'button', class: 'btn', onClick: () => exportCsv(view, range), disabled: range.empty }, h('span', { 'aria-hidden': 'true' }, '⤓'), 'Exportar CSV'),
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

// ---------- Hierarquia (drill-down) ----------
function categoryBadge(cat) {
  if (!cat) return '';
  const tone = { whatsapp: 'ok', seguidores: 'ok', excluido: 'muted', nao_conciliado: 'warn', nao_classificado: 'warn', misto: 'warn' }[cat] || 'muted';
  return h('span', { class: `badge badge-${tone}` }, CATEGORY_LABELS[cat] || 'Misto (ver conjuntos)');
}

function entityPanels(view, range) {
  const rows = filterRows(viewRows(app.model, view), { range });
  const select = (key, id, multiple) => {
    const field = key + 'Id';
    const ids = new Set(state[field].split(',').filter(Boolean));
    if (multiple) {
      const chosen = id.split(',');
      const remove = chosen.every(value => ids.has(value));
      for (const value of chosen) {
        if (remove) ids.delete(value);
        else ids.add(value);
      }
      state[field] = [...ids].join(',');
    } else {
      state[field] = state[field] === id ? '' : id;
    }
    if (key === 'campaign') state.adsetId = '';
    if (key !== 'ad') state.adId = '';
    update();
  };
  const tax = { taxEnabled: state.tax, taxFactor: app.taxFactor };
  const ranking = view.kind === 'funnel' ? adRanking(filterRows(rows, filters(range)), view, tax, select) : [];
  return [ranking, hierarchy({ rows, view, range, state, tax, coveredDates: app.model.coveredDates, select, render: update })];
}

// ---------- Painel combinado (gráfico + tabela diária no mesmo painel) ----------
function comboPanel({ title, hint, chart, table, note }) {
  const body = h('div', { class: 'chart-body' });
  queueMicrotask(() => renderComboChart(body, { ...chart, title }));
  return h('section', { class: 'panel' }, h('div', { class: 'panel-chart' }, h('h3', null, title), h('p', { class: 'hint' }, hint), body), table, note ? h('p', { class: 'note' }, note) : null);
}

function dailyTable(caption, columns, items, footer) {
  const t = sortableTable({
    caption,
    columns,
    items,
    sort: state.dailySort,
    onSort: (s) => ((state.dailySort = s), update()),
    rowAttrs: p => {
      const pickDay = () => { Object.assign(state, {preset:'custom', since:p.date, until:p.date}); update(); };
      return {tabindex:0, title:'Filtrar '+formatDateBR(p.date), onClick:pickDay, onKeydown:e=>{
        if (e.key==='Enter' || e.key===' ') { e.preventDefault(); pickDay(); }
      }};
    },
    rowClass: (p) => (p.partial ? 'row-partial' : !p.covered ? 'row-uncovered' : null),
    footer,
    className: 'dt-daily',
  });
  t.classList.add('tbl-daily');
  return t;
}

// ---------- Visão de funil (WhatsApp / Seguidores por médico) ----------
function identifiedSection(list, title) {
  return disclosure('historico-'+state.view, title, String(list.length)+' campanhas', identifiedTable(list, title));
}

function identifiedTable(list, title) {
  const statusText = (c) => (c.effective_status ? c.effective_status : c.discovered ? 'status não informado' : 'não retornada pela descoberta da conta');
  return sortableTable({
      caption: title,
      sort: { key: 'name', dir: 'asc' },
      onSort: () => {},
      items: list,
      columns: [
        { key: 'name', label: 'Campanha', cell: (c) => h('span', { class: 'cell-name' }, h('span', { class: 'name-text' }, c.name), h('span', { class: 'meta' }, `${c.account_label} · ${c.id}${c.doctor_scope === 'adset' ? ' · médico identificado por conjunto' : ''}`)) },
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
        { key: 'spend', label: spendShort(), num: true, cell: (c) => fmtBRL(spendOf(c.totals.spend_cents)) },
      ],
    });
}

function validationBadge(v) {
  const map = { pendente: ['warn', 'a validar'], destino_conferido: ['muted', 'destino conferido (API)'], conferido: ['ok', 'conferido com a UI'] };
  const [tone, label] = map[v] || map.pendente;
  return h('span', { class: `badge badge-${tone}` }, label);
}

function funnelSteps(view, m) {
  const L = resultLabels(view);
  const investment = step({
      label: spendLabel(),
      value: fmtBRL(m.spend),
      tone: 'hl-gasto',
      secs: [state.tax ? ['Bruto Meta', fmtBRL(m.spend_gross)] : ['c/ imposto est.', fmtBRL(m.spend_gross * app.taxFactor)]],
  });
  if (view.category === 'whatsapp') {
    return [
      investment,
      step({ label: L.result, value: fmtInt(m.results), tone: L.step }),
      step({ label: 'Custo por conversa iniciada', value: costText(m.cost_per_result, 'não calculável: 0 conversas'), tone: L.step }),
      step({ label: 'Cliques no link', value: fmtInt(m.link_clicks) }),
      step({ label: 'CPC (custo por clique)', value: costText(m.cpc, 'não calculável: 0 cliques') }),
    ];
  }
  return [
    step({ label: spendLabel(), value: fmtBRL(m.spend), tone: 'hl-gasto' }),
    step({ label: L.result, value: fmtInt(m.results), sub: L.sub, tone: L.step }),
    step({ label: 'Custo por seguidor', value: costText(m.cost_per_result, 'não calculável: 0 seguidores'), tone: L.step, title: 'Investimento do período ÷ seguidores atribuídos' }),
    step({ label: 'Cliques no link', value: fmtInt(m.link_clicks) }),
    step({ label: 'CPC (custo por clique)', value: costText(m.cpc, 'não calculável: 0 cliques') }),
  ];
}

function renderFunnel(main, view, range) {
  const map = app.config.campaign_map;
  const doctor = map.doctors[view.doctor];
  const L = resultLabels(view);
  const mapped = mappedCampaignsFor(map, view);
  put(
    main,
    secTitle(`${view.category === 'whatsapp' ? 'Funil WhatsApp' : 'Funil de seguidores'} & evolução diária · ${doctor.label}`),
    h('p', { class: 'view-intro' }, `${doctor.specialty} · ${view.category === 'whatsapp' ? 'Resultado = conversas iniciadas no WhatsApp (não são pacientes, agendamentos nem consultas).' : 'Resultado = seguidores do Instagram vindos de campanhas EXCLUSIVAS de seguidores.'}`),
  );
  const activeSets = new Set(filterRows(app.model.rows, { range }).map(row => row.adset_id));
  const pendingDoctor = pendingDoctorAdsets(app.model, view).filter(item => activeSets.has(item.adset_id));
  const pendingDoctorNotice = pendingDoctor.length
    ? notice(
        'warn',
        `${pendingDoctor.length} conjunto(s) de ${view.category === 'seguidores' ? 'seguidores' : 'WhatsApp'} aguardam confirmação do médico no período selecionado: `,
        pendingDoctor.map((p, i) => [i ? '; ' : '', h('strong', null, p.adset_name), ` (${p.adset_id}, campanha ${p.campaign_name})`]),
        '.',
      )
    : null;
  if (!mapped.length) {
    put(
      main,
      h(
        'section',
        { class: 'card empty-panel' },
        h('h3', null, view.category === 'seguidores' ? 'Nenhuma campanha de seguidores identificada' : 'Nenhuma campanha de WhatsApp mapeada'),
        h(
          'p',
          null,
          view.category === 'seguidores'
            ? `Nenhuma campanha (ou conjunto, em campanha mista) exclusiva de seguidores está confirmada para ${doctor.label}. Seguidores orgânicos ou incidentais de campanhas de WhatsApp não são contados aqui.`
            : `Nenhuma campanha de WhatsApp foi mapeada para ${doctor.label}.`,
        ),
        h('p', null, 'Quando houver campanha confirmada, adicione o campaign_id em config/campaign-map.json com o funil e o médico (ou o médico por conjunto, em campanha mista). O conjunto precisa ter o destination_type esperado para entrar no custo.'),
      ),
      pendingDoctorNotice,
    );
    return;
  }
  coverageNotices(range).forEach((n) => main.append(n));
  if (pendingDoctorNotice) main.append(pendingDoctorNotice);
  const rows = filterRows(viewRows(app.model, view), filters(range));
  const totals = sumRows(rows);
  const m = deriveMetrics(totals, { taxEnabled: state.tax, taxFactor: app.taxFactor, result: view.result });
  const identified = range.empty ? [] : identifiedCampaigns(app.model, view, range);
  const idle = identified.filter((c) => !c.delivered);
  const outside = doctorOutsideCost(app.model, view.doctor, range);
  const notes = [];
  if (view.category === 'whatsapp' && outside.totals.rows > 0 && !state.campaignId) {
    const ex = outside.byCategory[CATEGORY.EXCLUIDO];
    const nc = outside.byCategory[CATEGORY.NAO_CONCILIADO];
    notes.push(
      h(
        'p',
        { class: 'note' },
        `Fora deste custo (${doctor.label}): `,
        ex ? `${fmtBRL(spendOf(ex.spend_cents))} em campanhas fora da captação (LP/site/VideoView)` : '',
        ex && nc ? ' e ' : '',
        nc ? `${fmtBRL(spendOf(nc.spend_cents))} em conjuntos com destino não conciliado` : '',
        '. Detalhes na conciliação da visão Geral.',
      ),
    );
  }
  const leftCard = h('section', { class: 'card', 'aria-label': 'Indicadores do período' }, h('div', { class: 'funnel' }, funnelSteps(view, m)), ...notes);

  const noDelivery = !range.empty && rows.length === 0 && !entityFilterActive();
  let right;
  if (noDelivery) {
    right = h(
      'section',
      { class: 'panel' },
      h(
        'div',
        { class: 'empty-panel' },
        h('h3', null, 'Campanhas identificadas, sem veiculação no período'),
        h('p', null, `${identified.length} campanha(s) de ${view.category === 'seguidores' ? 'seguidores' : 'WhatsApp'} identificada(s) para ${doctor.label}, sem entrega no período selecionado. Não é ausência de campanha: investimento e resultados são zero confirmado nos dias coletados.`),
      ),
      identifiedSection(identified, 'Campanhas identificadas'),
    );
  } else {
    const points = dailySeries(rows, range, { coveredDates: app.model.coveredDates, today: partialDay() });
    const metrics = (t) => deriveMetrics(t, { taxEnabled: state.tax, taxFactor: app.taxFactor, result: view.result });
    const chartPts = points.map((p) => {
      const spend = spendOf(p.totals.spend_cents);
      return { ...p, values: { res: p.totals[view.result], spend, cost: ratio(spend, p.totals[view.result]) } };
    });
    const cov = (p, fn) => (p.covered ? fn() : h('span', { class: 'na' }, 'sem coleta'));
    const columns = [
      { key: 'date', label: 'Data', sortValue: p => p.date, cell: p => formatDateBR(p.date) },
      { key: 'weekday', label: 'Dia', cell: p => weekdayBR(p.date) },
      { key: 'spend', label: spendShort(), num: true, sortValue: (p) => (p.covered ? p.totals.spend_cents : null), heat: 'gasto', heatValue: (p) => (p.covered ? p.totals.spend_cents : null), cell: (p) => cov(p, () => fmtBRL(spendOf(p.totals.spend_cents))) },
      { key: 'result', label: L.short, num: true, sortValue: (p) => (p.covered ? p.totals[view.result] : null), heat: L.heat, heatValue: (p) => (p.covered ? p.totals[view.result] : null), cell: (p) => cov(p, () => fmtInt(p.totals[view.result])) },
      { key: 'cost', label: L.cost, num: true, sortValue: (p) => (p.covered ? metrics(p.totals).cost_per_result : null), cell: (p) => cov(p, () => costText(metrics(p.totals).cost_per_result, 'não calculável')) },
      { key: 'impressions', label: 'Impressões', num: true, sortValue: (p) => (p.covered ? p.totals.impressions : null), cell: (p) => cov(p, () => fmtInt(p.totals.impressions)) },
      { key: 'clicks', label: 'Cliques', num: true, sortValue: (p) => (p.covered ? p.totals.link_clicks : null), cell: (p) => cov(p, () => fmtInt(p.totals.link_clicks)) },
      { key: 'ctr', label: 'CTR', num: true, sortValue: (p) => (p.covered ? metrics(p.totals).ctr : null), cell: (p) => cov(p, () => fmtPct(metrics(p.totals).ctr)) },
      { key: 'cpc', label: 'CPC', num: true, sortValue: (p) => (p.covered ? metrics(p.totals).cpc : null), cell: (p) => cov(p, () => costText(metrics(p.totals).cpc, 'não calculável')) },
      { key: 'cpm', label: 'CPM', num: true, sortValue: (p) => (p.covered ? metrics(p.totals).cpm : null), cell: (p) => cov(p, () => costText(metrics(p.totals).cpm, 'não calculável')) },
    ];
    const order = ['date','weekday','spend','cpm','ctr','cr','convlp','result','cost','impressions','clicks','cpc'];
    columns.find(c => c.key === 'spend').label = 'Gasto';
    columns.find(c => c.key === 'cost').label = view.result === 'follows' ? 'CPS' : 'CPL';
    if (view.result === 'conversations') {
      for (const [key, label] of [['cr', 'CR'], ['convlp', 'ConvLP']]) {
        columns.push({ key, label, num: true, cell: () => h('span', {title: 'Sem página de destino neste funil.'}, DASH) });
      }
    }
    columns.sort((a,b) => order.indexOf(a.key) - order.indexOf(b.key));
    const footer = {
      date: 'Total Geral', cr: DASH, convlp: DASH,
      spend: fmtBRL(m.spend),
      result: fmtInt(m.results),
      cost: costText(m.cost_per_result, 'não calculável'),
      impressions: fmtInt(m.impressions),
      clicks: fmtInt(m.link_clicks),
      ctr: fmtPct(m.ctr),
      cpc: costText(m.cpc, 'não calculável'),
      cpm: costText(m.cpm, 'não calculável'),
    };
    right = comboPanel({
      title: 'Combinação diária',
      hint: `${L.result} (barra, eixo esquerdo) · ${spendLabel()} (linha vermelha) · ${L.cost} (linha ${view.result === 'conversations' ? 'clara' : 'amarela'}) — valores em R$ no eixo direito`,
      chart: {
        points: chartPts,
        bars: [{ key: 'res', label: L.result, color: L.bar }],
        lines: [
          { key: 'spend', label: spendLabel(), color: '--chart-gasto' },
          { key: 'cost', label: L.cost, color: L.costColor },
        ],
        countFormat: fmtInt,
        moneyFormat: fmtBRL,
        countAxis: fmtInt,
        moneyAxis: fmtAxisBRL,
        countTitle: L.short,
      },
      table: dailyTable('Tabela diária', columns, points, footer),
      note: 'Heatmap por coluna (investimento · resultado) · dia mais recente no topo · total ponderado (custo = razão dos totais) · “—” = não calculável; “sem coleta” = dia não coletado.',
    });
  }
  put(main, h('div', { class: 'grid funnel-grid' }, leftCard, right));
  if (!noDelivery) {
    put(main, entityPanels(view, range));
    if (idle.length && !entityFilterActive()) put(main, identifiedSection(idle, 'Campanhas identificadas sem veiculação no período'));
  }
  put(main, secTitle('Dados técnicos'), disclosure('metodologia', 'Coleta, cobertura e metodologia', 'fonte, versão da API, atribuição, imposto, mapa', methodologyList()));
}

// ---------- Visão Geral ----------
const OVERVIEW_SERIES = [
  { key: 'wa_taisa', label: 'WhatsApp Taísa', color: '--chart-conv' },
  { key: 'wa_ailton', label: 'WhatsApp Ailton', color: '--chart-conv-2' },
  { key: 'seguidores', label: 'Seguidores', color: '--chart-seg' },
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
  put(
    main,
    secTitle('Investimento & captação · evolução diária'),
    h('p', { class: 'view-intro' }, 'MedClinic Bauru/SP · conversas iniciadas no WhatsApp e seguidores são resultados distintos e nunca são somados.'),
  );
  coverageNotices(range).forEach((n) => main.append(n));
  const rows = filterRows(app.model.rows, filters(range));
  const rec = reconciliation(app.model, rows, range);
  const total = sumRows(rows);
  const cat = rec.byCategory;
  const all = deriveMetrics(total, { taxEnabled: state.tax, taxFactor: app.taxFactor });
  const wa = deriveMetrics(cat.whatsapp, { taxEnabled: state.tax, taxFactor: app.taxFactor, result: 'conversations' });
  const sg = deriveMetrics(cat.seguidores, { taxEnabled: state.tax, taxFactor: app.taxFactor, result: 'follows' });
  const pendingCents = cat.nao_conciliado.spend_cents + cat.nao_classificado.spend_cents;
  const convBy = (d) => rec.byDoctor[d]?.whatsapp?.conversations || 0;
  const fStatus = followersStatus(map, cat.seguidores);

  const scope = h(
    'dl',
    { class: 'scope-list' },
    [
      ['WhatsApp (conciliado)', cat.whatsapp.spend_cents],
      ['Seguidores (conciliado)', cat.seguidores.spend_cents],
      ['Fora da captação (LP/VideoView)', cat.excluido.spend_cents],
      ['Pendente de conciliação', pendingCents],
    ].map(([k, c]) => [h('dt', null, k), h('dd', null, fmtBRL(spendOf(c)))]),
  );
  const leftCard = h(
    'section',
    { class: 'card', 'aria-label': 'Indicadores do período' },
    h(
      'div',
      { class: 'funnel' },
      step({ label: `${spendLabel()} — total`, value: fmtBRL(all.spend), tone: 'hl-gasto', secs: [state.tax ? ['Bruto Meta', fmtBRL(all.spend_gross)] : ['c/ imposto est.', fmtBRL(all.spend_gross * app.taxFactor)]], extra: scope }),
      step({ label: 'Impressões (todas as campanhas)', value: fmtInt(all.impressions), secs: [['CPM', costText(all.cpm, 'não calculável: 0 impressões')]] }),
      step({ label: 'Cliques no link (todas as campanhas)', value: fmtInt(all.link_clicks), secs: [['CTR', fmtPct(all.ctr)], ['CPC', costText(all.cpc, 'não calculável: 0 cliques')]] }),
      step({
        label: 'Conversas iniciadas · WhatsApp',
        value: fmtInt(cat.whatsapp.conversations),
        sub: `Dra. Taísa ${fmtInt(convBy('taisa'))} · Dr. Ailton ${fmtInt(convBy('ailton'))} — conversas atribuídas aos anúncios no período`,
        tone: 'hl-conv',
        secs: [['Custo/conversa', costText(wa.cost_per_result, 'não calculável: 0 conversas'), 'investimento WhatsApp conciliado ÷ conversas']],
      }),
      step({
        label: 'Seguidores · campanhas exclusivas',
        value: fmtInt(cat.seguidores.follows),
        sub: { com_veiculacao: 'Seguidores atribuídos aos anúncios no período', identificada_sem_veiculacao: 'Campanhas identificadas, sem veiculação no período', sem_campanha: 'Nenhuma campanha de seguidores identificada' }[fStatus],
        tone: 'hl-seg',
        secs: [['Custo/seguidor', costText(sg.cost_per_result, 'não calculável: 0 seguidores'), 'investimento de campanhas de seguidores ÷ seguidores']],
      }),
    ),
    h('p', { class: 'note' }, 'Custo por conversa usa só o investimento WhatsApp conciliado (sem LP, VideoView, seguidores ou pendências). Conversas e seguidores nunca são somados.'),
  );

  const byDay = new Map();
  const seriesTotals = Object.fromEntries(OVERVIEW_SERIES.map((se) => [se.key, emptyTotals()]));
  for (const r of rows) {
    let d = byDay.get(r.date);
    if (!d) {
      d = Object.fromEntries(OVERVIEW_SERIES.map((se) => [se.key, emptyTotals()]));
      byDay.set(r.date, d);
    }
    addRowInto(d[overviewBucket(r)], r);
    addRowInto(seriesTotals[overviewBucket(r)], r);
  }
  const bucketOf = (date, key) => byDay.get(date)?.[key] || emptyTotals();
  const points = dailySeries(rows, range, { coveredDates: app.model.coveredDates, today: partialDay() });
  const waCents = (date) => bucketOf(date, 'wa_taisa').spend_cents + bucketOf(date, 'wa_ailton').spend_cents;
  const waConv = (date) => bucketOf(date, 'wa_taisa').conversations + bucketOf(date, 'wa_ailton').conversations;
  const chartPts = points.map((p) => ({
    ...p,
    values: {
      taisa: bucketOf(p.date, 'wa_taisa').conversations,
      ailton: bucketOf(p.date, 'wa_ailton').conversations,
      spend: spendOf(p.totals.spend_cents),
      cost: ratio(spendOf(waCents(p.date)), waConv(p.date)),
    },
  }));
  const cov = (p, fn) => (p.covered ? fn() : h('span', { class: 'na' }, 'sem coleta'));
  const money = (key, label, getter, heat) => ({ key, label, num: true, sortValue: (p) => (p.covered ? getter(p) : null), heat, heatValue: heat ? (p) => (p.covered ? getter(p) : null) : undefined, cell: (p) => cov(p, () => fmtBRL(spendOf(getter(p)))) });
  const count = (key, label, getter) => ({ key, label, num: true, sortValue: (p) => (p.covered ? getter(p) : null), heat: 'conv', heatValue: (p) => (p.covered ? getter(p) : null), cell: (p) => cov(p, () => fmtInt(getter(p))) });
  const columns = [
    { key: 'date', label: 'Dia', sortValue: (p) => p.date, cell: dayCell },
    money('total', 'Invest. total', (p) => p.totals.spend_cents, 'gasto'),
    money('wa', 'Invest. WhatsApp', (p) => waCents(p.date), 'gasto'),
    count('conv_t', 'Conv. Taísa', (p) => bucketOf(p.date, 'wa_taisa').conversations),
    count('conv_a', 'Conv. Ailton', (p) => bucketOf(p.date, 'wa_ailton').conversations),
    count('conv', 'Conversas', (p) => waConv(p.date)),
    { key: 'cpl', label: 'Custo/conversa', num: true, sortValue: (p) => (p.covered ? ratio(spendOf(waCents(p.date)), waConv(p.date)) : null), cell: (p) => cov(p, () => costText(ratio(spendOf(waCents(p.date)), waConv(p.date)), 'não calculável: 0 conversas')) },
  ];
  const footer = {
    date: 'Total do período',
    total: fmtBRL(all.spend),
    wa: fmtBRL(wa.spend),
    conv_t: fmtInt(convBy('taisa')),
    conv_a: fmtInt(convBy('ailton')),
    conv: fmtInt(cat.whatsapp.conversations),
    cpl: costText(wa.cost_per_result, 'não calculável'),
  };
  const right = comboPanel({
    title: 'Evolução diária',
    hint: 'Conversas WhatsApp por médico (barras empilhadas, eixo esquerdo) · Investimento total de todas as campanhas (linha vermelha) · Custo por conversa = investimento WhatsApp ÷ conversas (linha clara) — R$ no eixo direito',
    chart: {
      points: chartPts,
      bars: [
        { key: 'taisa', label: 'Conversas · Dra. Taísa', color: '--chart-conv' },
        { key: 'ailton', label: 'Conversas · Dr. Ailton', color: '--chart-conv-2' },
      ],
      lines: [
        { key: 'spend', label: `${spendLabel()} total`, color: '--chart-gasto' },
        { key: 'cost', label: 'Custo por conversa (só WhatsApp)', color: '--chart-cost' },
      ],
      countFormat: fmtInt,
      moneyFormat: fmtBRL,
      countAxis: fmtInt,
      moneyAxis: fmtAxisBRL,
      countTitle: 'Conversas',
    },
    table: dailyTable('Tabela diária geral', columns, points, footer),
    note: 'Heatmap por coluna (investimento · conversas) · dia mais recente no topo · total ponderado · “sem coleta” = dia não coletado. Investimento diário por categoria (fora da captação, pendente) na conciliação abaixo.',
  });
  put(main, h('div', { class: 'grid funnel-grid' }, leftCard, right));

  // Comparativo por médico (denominadores próprios).
  const doctorRows = Object.entries(map.doctors).map(([id, d]) => {
    const by = rec.byDoctor[id] || {};
    const waT = by.whatsapp || emptyTotals();
    const sgT = by.seguidores || emptyTotals();
    const mw = deriveMetrics(waT, { taxEnabled: state.tax, taxFactor: app.taxFactor, result: 'conversations' });
    const ms = deriveMetrics(sgT, { taxEnabled: state.tax, taxFactor: app.taxFactor, result: 'follows' });
    const hasFollowers = mappedCampaignsFor(map, { kind: 'funnel', doctor: id, category: 'seguidores' }).length > 0;
    return {
      id,
      label: d.label,
      wa_spend: mw.spend,
      wa_conv: waT.conversations,
      cpl: mw.cost_per_result,
      sg_spend: hasFollowers ? ms.spend : null,
      sg_fol: hasFollowers ? sgT.follows : null,
      cps: hasFollowers ? ms.cost_per_result : null,
      hasFollowers,
      excl: spendOf((by.excluido || emptyTotals()).spend_cents),
      nc: spendOf((by.nao_conciliado || emptyTotals()).spend_cents),
    };
  });
  const noFollow = (r, fn) => (r.hasFollowers ? fn() : h('span', { class: 'na', title: 'Nenhuma campanha de seguidores identificada' }, 'sem campanha'));
  put(
    main,
    secTitle('Comparativo por médico'),
    h('p', { class: 'view-intro' }, 'Cada custo usa o próprio denominador: custo por conversa = investimento WhatsApp ÷ conversas WhatsApp; custo por seguidor = investimento de campanhas de seguidores ÷ seguidores dessas campanhas.'),
    sortableTable({
      caption: 'Comparativo por médico',
      sort: { key: 'label', dir: 'asc' },
      onSort: () => {},
      items: doctorRows,
      className: 'dt-compare',
      columns: [
        { key: 'label', label: 'Médico', cell: (r) => r.label },
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
  );
  put(main, entityPanels(view, range));

  // Evidências em disclosures fechados (não poluem a primeira dobra).
  const stackPts = points.map((p) => ({ ...p, values: Object.fromEntries(OVERVIEW_SERIES.map((s) => [s.key, spendOf(bucketOf(p.date, s.key).spend_cents)])) }));
  const catChart = h('div', { class: 'chart-body' });
  put(
    main,
    secTitle('Conciliação, dados técnicos e metodologia'),
    disclosure(
      'conciliacao',
      'Conciliação do investimento',
      `categorias, conferência com o total da conta, ${rec.pending.length} pendência(s)`,
      reconciliationContent(rec, total),
      h('h3', { class: 'sub-h' }, `${spendLabel()} diário por categoria`),
      catChart,
      sortableTable({
        caption: 'Investimento diário por categoria',
        columns: [
          { key: 'date', label: 'Dia', sortValue: (p) => p.date, cell: dayCell },
          money('total', 'Total', (p) => p.totals.spend_cents, 'gasto'),
          ...OVERVIEW_SERIES.map((se) => money(se.key, se.label, (p) => bucketOf(p.date, se.key).spend_cents)),
        ],
        items: points,
        sort: state.dailySort,
        onSort: (x) => ((state.dailySort = x), update()),
        rowAttrs: p => {
      const pickDay = () => { Object.assign(state, {preset:'custom', since:p.date, until:p.date}); update(); };
      return {tabindex:0, title:'Filtrar '+formatDateBR(p.date), onClick:pickDay, onKeydown:e=>{
        if (e.key==='Enter' || e.key===' ') { e.preventDefault(); pickDay(); }
      }};
    },
    rowClass: (p) => (p.partial ? 'row-partial' : !p.covered ? 'row-uncovered' : null),
        footer: { date: 'Total do período', total: fmtBRL(all.spend), ...Object.fromEntries(OVERVIEW_SERIES.map((se) => [se.key, fmtBRL(spendOf(seriesTotals[se.key].spend_cents))])) },
      }),
    ),
    disclosure('metodologia', 'Coleta, cobertura e metodologia', 'fonte, versão da API, atribuição, imposto, mapa', methodologyList()),
  );
  queueMicrotask(() => renderTimeChart(catChart, { type: 'stacked', points: stackPts, series: OVERVIEW_SERIES, format: (v) => fmtBRL(v), axisFormat: fmtAxisBRL, title: 'Investimento diário por categoria' }));
}

function reconciliationContent(rec, total) {
  const pct = (c) => (total.spend_cents > 0 ? fmtPct((c / total.spend_cents) * 100) : DASH);
  const cats = [
    [CATEGORY.WHATSAPP, 'Entra no custo por conversa (CPL).'],
    [CATEGORY.SEGUIDORES, 'Entra no custo por seguidor (CPS).'],
    [CATEGORY.EXCLUIDO, 'LP/site/VideoView: fora de qualquer custo.'],
    [CATEGORY.NAO_CONCILIADO, 'Mapeado, mas destino do conjunto misto/divergente/desconhecido ou médico a confirmar: fora do custo.'],
    [CATEGORY.NAO_CLASSIFICADO, 'Campanha fora do mapa explícito: fora do custo até ser classificada.'],
  ];
  const doctors = app.config.campaign_map.doctors;
  const pendingCols = [
    { key: 'campaign', label: 'Campanha', sortValue: (p) => p.campaign_name, cell: (p) => h('span', { class: 'cell-name' }, h('span', { class: 'name-text' }, p.campaign_name), h('span', { class: 'meta' }, `${p.account_label} · ${p.campaign_id}${p.campaign_objective ? ` · ${p.campaign_objective}` : ''}${p.campaign_status ? ` · ${p.campaign_status}` : ''}`)) },
    { key: 'adset', label: 'Conjunto', sortValue: (p) => p.adset_name, cell: (p) => h('span', { class: 'cell-name' }, h('span', { class: 'name-text' }, p.adset_name), h('span', { class: 'meta' }, p.adset_id)) },
    { key: 'dest', label: 'Destino', sortValue: (p) => p.destination_type, cell: (p) => p.destination_type || 'desconhecido' },
    { key: 'status', label: 'Situação', sortValue: (p) => p.category, cell: (p) => h('span', { class: 'cell-name' }, categoryBadge(p.category), h('span', { class: 'meta' }, p.reason)) },
    { key: 'hint', label: 'Médico / sugestão', sortValue: (p) => p.suggestion || p.doctor, cell: (p) => (p.doctor ? doctors[p.doctor]?.label : p.doctor_pending ? 'médico a confirmar (conjunto)' : p.suggestion ? `${p.suggestion} (não aplicada)` : '') },
    { key: 'spend', label: spendShort(), num: true, sortValue: (p) => p.totals.spend_cents, cell: (p) => fmtBRL(spendOf(p.totals.spend_cents)) },
  ];
  return [
    h('p', { class: 'hint' }, 'Todo o gasto das contas é distribuído em categorias; apenas WhatsApp e Seguidores conciliados entram em custos. Nada é contado em dobro.'),
    sortableTable({
      caption: 'Investimento por categoria',
      sort: { key: 'cat', dir: 'asc' },
      onSort: () => {},
      items: cats.map(([k, note]) => ({ k, note, t: rec.byCategory[k] })),
      footer: { cat: 'Total', spend: fmtBRL(spendOf(total.spend_cents)), pct: total.spend_cents > 0 ? '100,00%' : DASH, note: '' },
      columns: [
        { key: 'cat', label: 'Categoria', cell: (r) => categoryBadge(r.k) },
        { key: 'spend', label: spendLabel(), num: true, cell: (r) => fmtBRL(spendOf(r.t.spend_cents)) },
        { key: 'pct', label: '% do total', num: true, cell: (r) => pct(r.t.spend_cents) },
        { key: 'note', label: 'Regra', cell: (r) => r.note },
      ],
    }),
    h('h3', { class: 'sub-h' }, 'Conferência com o total da conta (nível conta, Meta)'),
    entityFilterActive()
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
  ];
}

function methodologyList() {
  const snap = app.snapshot;
  const api = snap.api || {};
  const map = app.config.campaign_map;
  const states = { pendente: 0, destino_conferido: 0, conferido: 0 };
  for (const [id, e] of Object.entries(map.campaigns)) if (!id.startsWith('$')) states[e.validation || 'pendente'] = (states[e.validation || 'pendente'] || 0) + 1;
  const effective = api.effective_versions || [];
  const versionMismatch = effective.length && !effective.includes(api.requested_version);
  const f = freshness();
  const item = (k, ...v) => h('div', { class: 'dl-row' }, h('dt', null, k), h('dd', null, ...v));
  return h(
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
    item('Imposto Meta', `${app.config.tax.label}: bruto × ${fmtDec(app.taxFactor, 4)} — aplicado uma única vez sobre o bruto; ${state.tax ? 'ligado' : 'desligado'} agora. Pendente de confirmação fiscal.`),
    item('Custos', 'Razão dos totais do período (não média de custos diários). Denominador zero = não calculável (—). Curvas dos gráficos são só suavização visual; tooltip e tabela mostram os valores originais.'),
    item('Mapa de classificação', `versão ${map.version} · ${Object.keys(map.campaigns).filter((k) => !k.startsWith('$')).length} campanhas mapeadas · ${states.conferido} conferidas com a UI · ${states.destino_conferido} com destino conferido via API (resultados a comparar com a UI) · ${states.pendente} a validar`),
    item('Alcance/frequência', 'Não exibidos: alcance não pode ser somado entre dias/anúncios e não é inventado.'),
    item('Build', `${formatDateTimeBR(app.config.build?.built_at)}${app.config.build?.commit ? ` · commit ${app.config.build.commit.slice(0, 7)}` : ''}`),
  );
}

// ---------- Render ----------
function render() {
  if (!app.snapshot) return;
  if (state.view === 'google') {
    const range = currentRange();
    writeHash();
    renderSidebar();
    renderTopbar({label:'Google Ads'}, range);
    $('topbar').querySelector('.tax-toggle')?.remove();
    $('topbar').querySelector('.updated')?.remove();
    clear($('filters'));
    renderGoogle($('main'),app.google,range);
    document.title='Google Ads · MedClinic';
    return;
  }
  const view = findView(state.view);
  const range = currentRange();
  writeHash();
  renderSidebar();
  renderTopbar(view, range);
  renderSubbar(view, range);
  const main = $('main');
  clear(main);
  if (view.kind === 'overview') renderOverview(main, view, range);
  else renderFunnel(main, view, range);
  put(main, h('p', { class: 'page-foot' }, 'Fonte: Meta Marketing API (somente leitura). Resultado de captação = conversas iniciadas no WhatsApp — não são pacientes, agendamentos ou consultas. Datas em DD/MM/AAAA, fuso America/Sao_Paulo, valores em BRL.'));
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
      'section',
      { class: 'card empty-panel' },
      h('h3', null, 'Dados indisponíveis'),
      h('p', null, message),
      h('p', null, 'Nenhum dado de demonstração é exibido. Se a primeira coleta real ainda não foi publicada, isso é esperado.'),
    ),
  );
}

async function init() {
  applyTheme(storedTheme());
  readHash();
  $('scrim').addEventListener('click', () => setNav(false, { focus: true }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('nav-open')) setNav(false, { focus: true });
  });
  matchMedia('(min-width: 901px)').addEventListener?.('change', (e) => {
    if (e.matches) setNav(false);
  });
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
