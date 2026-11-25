// CSV para Excel/planilhas em pt-BR: separador ';', decimal ',', UTF-8 com BOM.
// Proteção contra formula injection: texto que começa com = + - @ TAB CR (mesmo após espaços)
// recebe um apóstrofo inicial. Números são emitidos como números (não prefixados).

const DANGEROUS_START = /^[\s ]*[=+\-@＝＋－＠]|^[\t\r]/;

export function csvText(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (DANGEROUS_START.test(s)) s = `'${s}`;
  if (/[";\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvNumber(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return value.toFixed(decimals).replace('.', ',');
}

export function csvInteger(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(Math.round(value));
}

/**
 * @param columns [{ header, value: (row) => any, type: 'text'|'number'|'integer', decimals }]
 */
export function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvText(c.header)).join(';')];
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          const v = c.value(row);
          if (c.type === 'number') return csvNumber(v, c.decimals ?? 2);
          if (c.type === 'integer') return csvInteger(v);
          return csvText(v);
        })
        .join(';'),
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function safeFilenamePart(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
}
