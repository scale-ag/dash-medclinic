// Tabelas ordenáveis (diária e drill-down campanha -> conjunto -> anúncio).
import { h } from './dom.js';

function compare(a, b) {
  const an = a === null || a === undefined || (typeof a === 'number' && !Number.isFinite(a));
  const bn = b === null || b === undefined || (typeof b === 'number' && !Number.isFinite(b));
  if (an && bn) return 0;
  if (an) return 1; // nulos sempre por último
  if (bn) return -1;
  if (typeof a === 'string' || typeof b === 'string') return String(a).localeCompare(String(b), 'pt-BR');
  return a - b;
}

export function sortItems(items, columns, sort) {
  const col = columns.find((c) => c.key === sort.key) || columns[0];
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...items].sort((x, y) => {
    const a = col.sortValue ? col.sortValue(x) : null;
    const b = col.sortValue ? col.sortValue(y) : null;
    const nullA = a === null || a === undefined;
    const nullB = b === null || b === undefined;
    if (nullA || nullB) return compare(a, b);
    return compare(a, b) * dir;
  });
}

function headerRow(columns, sort, onSort) {
  return h(
    'tr',
    null,
    columns.map((c) => {
      const active = sort.key === c.key;
      const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
      const content = c.sortValue
        ? h(
            'button',
            {
              type: 'button',
              class: 'sort-btn',
              onClick: () => onSort({ key: c.key, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' }),
              title: 'Ordenar',
            },
            c.label,
            h('span', { class: 'sort-ind', 'aria-hidden': 'true' }, active ? (sort.dir === 'asc' ? '▲' : '▼') : ''),
          )
        : c.label;
      return h('th', { scope: 'col', class: c.num ? 'num' : null, 'aria-sort': c.sortValue ? ariaSort : null }, content);
    }),
  );
}

/** Cor do heatmap por coluna: tom fixo por métrica (variável CSS do tema), só a opacidade varia. */
const HEAT_VARS = { gasto: '--heat-gasto', conv: '--heat-conv', seg: '--heat-seg' };
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function heatColor(rgb, v, lo, hi) {
  if (!rgb || !Number.isFinite(v) || !(hi > lo)) return '';
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(0.06 + 0.5 * t).toFixed(3)})`;
}

/**
 * Tabela plana ordenável (estilo compacto `dt`).
 * columns: [{ key, label, num, sortValue(item), cell(item) -> Node|string, heat?: 'gasto'|'conv'|'seg', heatValue?(item) }]
 * footer: { [columnKey]: Node|string } — linha de total fixa (tfoot)
 */
export function sortableTable({ caption, columns, items, sort, onSort, rowClass, rowAttrs, footer, className = '' }) {
  const sorted = sortItems(items, columns, sort);
  const ext = {};
  for (const c of columns) {
    if (!c.heat || !c.heatValue) continue;
    const vals = items.map((it) => c.heatValue(it)).filter((v) => Number.isFinite(v));
    const rgb = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue(HEAT_VARS[c.heat] || ''));
    if (vals.length && rgb) ext[c.key] = [Math.min(...vals), Math.max(...vals), rgb];
  }
  const cellFor = (c, it, isFirst) => {
    const el = h(isFirst ? 'th' : 'td', { class: c.num ? 'num' : null, scope: isFirst ? 'row' : null }, c.cell(it));
    if (ext[c.key]) {
      const bg = heatColor(ext[c.key][2], c.heatValue(it), ext[c.key][0], ext[c.key][1]);
      if (bg) el.style.backgroundColor = bg;
    }
    return el;
  };
  return h(
    'div',
    { class: 'tbl-wrap' },
    h(
      'table',
      { class: `dt ${className}`.trim() },
      caption ? h('caption', { class: 'sr-only' }, caption) : null,
      h('thead', null, headerRow(columns, sort, onSort)),
      h(
        'tbody',
        null,
        sorted.map((it) => h('tr', { class: rowClass ? rowClass(it) : null, ...rowAttrs?.(it) }, columns.map((c, i) => cellFor(c, it, i === 0)))),
      ),
      footer ? h('tfoot', null, h('tr', null, columns.map((c, i) => h(i === 0 ? 'th' : 'td', { class: c.num ? 'num' : null, scope: i === 0 ? 'row' : null }, footer[c.key] ?? '')))) : null,
    ),
  );
}

/**
 * Árvore campanha -> conjunto -> anúncio. Ordenação aplicada dentro de cada nível.
 * nodes: [{ id, level, name, children }]
 */
export function treeTable({ caption, columns, nodes, sort, onSort, expanded, onToggle }) {
  const body = h('tbody');
  const addRows = (list, depth, parentKey) => {
    for (const n of sortItems(list, columns, sort)) {
      const key = `${parentKey}/${n.level}:${n.id}`;
      const hasChildren = Array.isArray(n.children) && n.children.length > 0;
      const isOpen = expanded.has(key);
      const first = columns[0];
      const nameCell = h(
        'th',
        { scope: 'row', class: `tree-name depth-${depth}` },
        hasChildren
          ? h(
              'button',
              {
                type: 'button',
                class: 'tree-toggle',
                'aria-expanded': isOpen ? 'true' : 'false',
                'aria-label': `${isOpen ? 'Recolher' : 'Expandir'} ${n.name}`,
                onClick: () => onToggle(key),
              },
              isOpen ? '−' : '+',
            )
          : h('span', { class: 'tree-spacer', 'aria-hidden': 'true' }),
        first.cell(n),
      );
      body.append(
        h('tr', { class: `level-${n.level}` }, nameCell, columns.slice(1).map((c) => h('td', { class: c.num ? 'num' : null }, c.cell(n)))),
      );
      if (hasChildren && isOpen) addRows(n.children, depth + 1, key);
    }
  };
  addRows(nodes, 0, '');
  return h(
    'div',
    { class: 'tbl-wrap tbl-tree' },
    h('table', { class: 'dt tree' }, caption ? h('caption', { class: 'sr-only' }, caption) : null, h('thead', null, headerRow(columns, sort, onSort)), body),
  );
}
