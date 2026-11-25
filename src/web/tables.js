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

/** Tabela plana ordenável. columns: [{ key, label, num, sortValue(item), cell(item) -> Node|string }] */
export function sortableTable({ caption, columns, items, sort, onSort, rowClass }) {
  const sorted = sortItems(items, columns, sort);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      null,
      caption ? h('caption', { class: 'sr-only' }, caption) : null,
      h('thead', null, headerRow(columns, sort, onSort)),
      h(
        'tbody',
        null,
        sorted.map((it) =>
          h(
            'tr',
            { class: rowClass ? rowClass(it) : null },
            columns.map((c) => h(c.key === columns[0].key ? 'th' : 'td', { class: c.num ? 'num' : null, scope: c.key === columns[0].key ? 'row' : null }, c.cell(it))),
          ),
        ),
      ),
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
    { class: 'table-wrap' },
    h('table', { class: 'tree' }, caption ? h('caption', { class: 'sr-only' }, caption) : null, h('thead', null, headerRow(columns, sort, onSort)), body),
  );
}
