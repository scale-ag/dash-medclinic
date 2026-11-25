// Gráficos diários em SVG (sem dependências externas).
// Especificações: barras <= 24px com topo arredondado de 4px, linhas de 2px, grade em hairline,
// um único eixo Y por gráfico, tooltip por coluna (mouse e teclado), dias parciais esmaecidos,
// dias sem coleta marcados como ausência (não como zero).
import { h, s, clear } from './dom.js';
import { formatDateBR, formatDayMonthBR, weekdayBR } from './shared/dates.js';

const HEIGHT = 220;
const M = { top: 12, right: 14, bottom: 28, left: 60 };

function niceStep(max, ticks = 4) {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

function yScale(maxValue, plotH, integer) {
  let max = maxValue > 0 ? maxValue : 1;
  let step = niceStep(max);
  if (integer) step = Math.max(1, Math.ceil(step));
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { top, ticks, y: (v) => plotH - (v / top) * plotH };
}

function roundedTopBar(x, y, w, hgt, r = 4) {
  if (hgt <= 0) return '';
  const rr = Math.min(r, hgt, w / 2);
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}

function legend(series, kind) {
  if (series.length < 2) return null;
  return h(
    'ul',
    { class: 'chart-legend', 'aria-label': 'Legenda' },
    series.map((se) =>
      h('li', null, h('span', { class: `key key-${kind}`, dataset: { color: se.color } }), se.label),
    ),
  );
}

/**
 * @param container elemento que recebe o gráfico
 * @param opts.type 'bar' | 'stacked' | 'line'
 * @param opts.points [{ date, covered, partial, values: { [key]: number|null } }]
 * @param opts.series [{ key, label, color }] cor = nome de variável CSS (ex.: '--series-1')
 * @param opts.format (v) => string para tooltip
 * @param opts.axisFormat (v) => string para eixo Y
 * @param opts.integer eixo Y inteiro
 * @param opts.title título acessível
 */
export function renderTimeChart(container, opts) {
  const draw = () => drawChart(container, opts);
  draw();
  if (typeof ResizeObserver !== 'undefined') {
    let last = container.clientWidth;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - last) < 4) return;
      last = container.clientWidth;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    });
    ro.observe(container);
  }
}

function drawChart(container, { type, points, series, format, axisFormat, integer = false, title, externalLegend = false, onSeriesClick, height = HEIGHT, emptyText = 'Sem dias no período.' }) {
  clear(container);
  container.classList.add('chart');
  if (!points.length) {
    container.append(h('p', { class: 'chart-empty' }, emptyText));
    return;
  }
  const leg = legend(series, type === 'line' ? 'line' : 'rect');
  if (leg && !externalLegend) container.append(leg);
  for (const li of container.querySelectorAll('.key')) li.style.setProperty('--key-color', `var(${li.dataset.color})`);

  const width = Math.max(280, container.clientWidth || 600);
  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const n = points.length;
  const band = plotW / n;

  const totals = points.map((p) => {
    if (type === 'stacked') return series.reduce((acc, se) => acc + (p.values[se.key] || 0), 0);
    return Math.max(0, ...series.map((se) => p.values[se.key] ?? 0));
  });
  const ys = yScale(Math.max(0, ...totals), plotH, integer);

  const svg = s('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width: '100%',
    height: height,
    role: 'img',
    'aria-label': `${title}. Use as setas para navegar pelos dias; os valores também estão na tabela diária.`,
    tabindex: '0',
    class: 'chart-svg',
  });
  const g = s('g', { transform: `translate(${M.left},${M.top})` });
  svg.append(g);

  // Dias sem coleta: faixa de fundo (ausência ≠ zero).
  points.forEach((p, i) => {
    if (!p.covered) g.append(s('rect', { x: i * band, y: 0, width: band, height: plotH, class: 'uncovered' }));
  });

  // Grade e eixo Y.
  for (const t of ys.ticks) {
    const y = ys.y(t);
    g.append(s('line', { x1: 0, x2: plotW, y1: y, y2: y, class: t === 0 ? 'axis' : 'grid' }));
    g.append(s('text', { x: -8, y: y + 4, class: 'tick', 'text-anchor': 'end' }, axisFormat(t)));
  }

  // Rótulos do eixo X sem sobreposição.
  const every = Math.max(1, Math.ceil((n * 44) / plotW));
  const labelIdx = [];
  for (let i = 0; i < n; i += every) labelIdx.push(i);
  if (labelIdx.at(-1) !== n - 1) {
    // Sempre rotula o último dia; se ficar perto demais do anterior, substitui o anterior.
    if (n - 1 - labelIdx.at(-1) < every && labelIdx.length > 1) labelIdx.pop();
    labelIdx.push(n - 1);
  }
  for (const i of labelIdx) {
    g.append(s('text', { x: i * band + band / 2, y: plotH + 18, class: 'tick', 'text-anchor': 'middle' }, formatDayMonthBR(points[i].date)));
  }

  const hl = s('rect', { x: 0, y: 0, width: band, height: plotH, class: 'hover-band', visibility: 'hidden' });
  g.append(hl);

  if (type === 'bar' || type === 'stacked') {
    const barW = Math.max(2, Math.min(24, band * 0.62));
    points.forEach((p, i) => {
      const x = i * band + (band - barW) / 2;
      let acc = 0;
      const keys = type === 'stacked' ? series : [series[0]];
      keys.forEach((se, si) => {
        const v = p.values[se.key] || 0;
        if (v <= 0) return;
        const y0 = ys.y(acc);
        const y1 = ys.y(acc + v);
        acc += v;
        const isTop = type !== 'stacked' || keys.slice(si + 1).every((k) => !(p.values[k.key] > 0));
        const gap = type === 'stacked' && si > 0 ? 1 : 0; // separação de 2px entre segmentos (1px de cada lado)
        const hgt = Math.max(0, y0 - y1 - gap);
        const path = isTop ? roundedTopBar(x, y1, barW, hgt) : `M${x},${y1}h${barW}v${hgt}h${-barW}Z`;
        if (!path) return;
        const el = s('path', { d: path, class: `mark${p.partial ? ' partial' : ''}` });
        el.style.fill = `var(${se.color})`;
        g.append(el);
      });
    });
  } else {
    // Linha: segmentos interrompidos em valores nulos (custo não calculável) ou dias sem coleta.
    for (const se of series) {
      let d = '';
      let open = false;
      points.forEach((p, i) => {
        const v = p.covered ? p.values[se.key] : null;
        if (v === null || v === undefined) {
          open = false;
          return;
        }
        const x = i * band + band / 2;
        const y = ys.y(v);
        d += `${open ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
        open = true;
      });
      if (d) {
        const path = s('path', { d, class: 'line' });
        path.style.stroke = `var(${se.color})`;
        if (onSeriesClick) path.addEventListener('click', e => onSeriesClick(se.key, e));
        g.append(path);
      }
      points.forEach((p, i) => {
        const v = p.covered ? p.values[se.key] : null;
        if (v === null || v === undefined) return;
        const prev = i > 0 && points[i - 1].covered ? points[i - 1].values[se.key] : null;
        const next = i < n - 1 && points[i + 1].covered ? points[i + 1].values[se.key] : null;
        const isolated = (prev === null || prev === undefined) && (next === null || next === undefined);
        if (!isolated && !p.partial && i !== n - 1) return;
        const c = s('circle', { cx: i * band + band / 2, cy: ys.y(v), r: 4, class: `dot${p.partial ? ' partial' : ''}` });
        c.style.fill = `var(${se.color})`;
        if (onSeriesClick) c.addEventListener('click', e => onSeriesClick(se.key, e));
        g.append(c);
      });
    }
  }

  const tip = h('div', { class: 'chart-tip', role: 'status', 'aria-live': 'polite', hidden: true });
  const wrap = h('div', { class: 'chart-wrap' }, svg, tip);
  container.append(wrap);

  let active = -1;
  const show = (i) => {
    if (i < 0 || i >= n) return hide();
    active = i;
    const p = points[i];
    hl.setAttribute('x', i * band);
    hl.setAttribute('visibility', 'visible');
    clear(tip);
    tip.append(h('div', { class: 'tip-date' }, `${weekdayBR(p.date)} ${formatDateBR(p.date)}${p.partial ? ' · parcial' : ''}`));
    if (!p.covered) {
      tip.append(h('div', { class: 'tip-row muted' }, 'Sem coleta para este dia (ausência, não zero)'));
    } else {
      for (const se of series) {
        const v = p.values[se.key];
        const row = h('div', { class: 'tip-row' }, h('span', { class: 'tip-key' }), h('strong', null, format(v, se)), h('span', { class: 'tip-label' }, se.label));
        row.querySelector('.tip-key').style.setProperty('--key-color', `var(${se.color})`);
        tip.append(row);
      }
      if (type === 'stacked') {
        const total = series.reduce((a, se) => a + (p.values[se.key] || 0), 0);
        tip.append(h('div', { class: 'tip-row tip-total' }, h('strong', null, format(total)), h('span', { class: 'tip-label' }, 'Total')));
      }
    }
    tip.hidden = false;
    const svgRect = svg.getBoundingClientRect();
    const scale = svgRect.width / width;
    const cx = (M.left + i * band + band / 2) * scale;
    const tipW = tip.offsetWidth || 180;
    const left = Math.min(Math.max(4, cx - tipW / 2), Math.max(4, svgRect.width - tipW - 4));
    tip.style.left = `${left}px`;
    tip.style.top = `${4}px`;
  };
  const hide = () => {
    active = -1;
    hl.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  svg.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * width - M.left;
    show(Math.floor(px / band));
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      const next = active < 0 ? (ev.key === 'ArrowRight' ? 0 : n - 1) : active + (ev.key === 'ArrowRight' ? 1 : -1);
      show(Math.min(n - 1, Math.max(0, next)));
    } else if (ev.key === 'Escape') hide();
  });
}

// ---------------------------------------------------------------------------
// Gráfico COMBINADO diário (padrão Scale): barras empilhadas de quantidade no eixo
// esquerdo + linhas de valores em R$ no eixo direito (gasto e custo por resultado).
// A curva é só interpolação VISUAL (cúbica monotônica: não ultrapassa os pontos);
// os valores exibidos (tooltip/tabela) são os originais. Custo não calculável
// (0 resultados) ou dia sem coleta interrompem a linha — nunca é interpolado.
// ---------------------------------------------------------------------------
const CM = { top: 22, right: 62, bottom: 28, left: 46 };
const COMBO_HEIGHT = 280;

function monotonePath(pts) {
  const n = pts.length;
  if (n === 1) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  const dx = [];
  const m = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = pts[i + 1].x - pts[i].x;
    m[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  const t = new Array(n);
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i += 1) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i += 1) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const sq = a * a + b * b;
    if (sq > 9) {
      const tau = 3 / Math.sqrt(sq);
      t[i] = tau * a * m[i];
      t[i + 1] = tau * b * m[i];
    }
  }
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const hh = dx[i] / 3;
    d += `C${(pts[i].x + hh).toFixed(1)},${(pts[i].y + t[i] * hh).toFixed(1)} ${(pts[i + 1].x - hh).toFixed(1)},${(pts[i + 1].y - t[i + 1] * hh).toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

/**
 * @param opts.points [{ date, covered, partial, values: { [key]: number|null } }]
 * @param opts.bars [{ key, label, color }] (empilhadas, eixo esquerdo — quantidades)
 * @param opts.lines [{ key, label, color }] (eixo direito — R$)
 * @param opts.countFormat / opts.moneyFormat / opts.countAxis / opts.moneyAxis formatadores
 */
export function renderComboChart(container, opts) {
  const draw = () => drawCombo(container, opts);
  draw();
  if (typeof ResizeObserver !== 'undefined') {
    let last = container.clientWidth;
    let raf = 0;
    new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - last) < 4) return;
      last = container.clientWidth;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    }).observe(container);
  }
}

function drawCombo(container, { points, bars, lines, countFormat, moneyFormat, countAxis, moneyAxis, title, countTitle, emptyText = 'Sem dias no período.' }) {
  clear(container);
  container.classList.add('chart');
  if (!points.length) {
    container.append(h('p', { class: 'chart-empty' }, emptyText));
    return;
  }
  container.append(
    h(
      'ul',
      { class: 'chart-legend', 'aria-label': 'Legenda' },
      bars.map((b) => h('li', null, h('span', { class: 'key key-rect', dataset: { color: b.color } }), b.label)),
      lines.map((l) => h('li', null, h('span', { class: 'key key-line', dataset: { color: l.color } }), l.label)),
    ),
  );
  for (const k of container.querySelectorAll('.key')) k.style.setProperty('--key-color', `var(${k.dataset.color})`);

  const width = Math.max(300, container.clientWidth || 640);
  const plotW = width - CM.left - CM.right;
  const plotH = COMBO_HEIGHT - CM.top - CM.bottom;
  const n = points.length;
  const band = plotW / n;
  const stackMax = Math.max(0, ...points.map((p) => bars.reduce((a, b) => a + (p.covered ? p.values[b.key] || 0 : 0), 0)));
  const lineVals = points.flatMap((p) => (p.covered ? lines.map((l) => p.values[l.key]).filter((v) => Number.isFinite(v)) : []));
  const yl = yScale(stackMax, plotH, true);
  const yr = yScale(Math.max(0, ...lineVals), plotH, false);

  const svg = s('svg', {
    viewBox: `0 0 ${width} ${COMBO_HEIGHT}`,
    width: '100%',
    height: COMBO_HEIGHT,
    role: 'img',
    'aria-label': `${title}. Barras: ${bars.map((b) => b.label).join(', ')} (eixo esquerdo). Linhas: ${lines.map((l) => l.label).join(', ')} (eixo direito, R$). Use as setas para navegar pelos dias; os valores também estão na tabela diária.`,
    tabindex: '0',
    class: 'chart-svg combo',
  });
  const g = s('g', { transform: `translate(${CM.left},${CM.top})` });
  svg.append(g);
  g.append(s('text', { x: -CM.left + 2, y: -10, class: 'axis-title' }, countTitle || 'Qtd.'));
  g.append(s('text', { x: plotW + CM.right - 2, y: -10, class: 'axis-title', 'text-anchor': 'end' }, 'R$'));

  points.forEach((p, i) => {
    if (!p.covered) g.append(s('rect', { x: i * band, y: 0, width: band, height: plotH, class: 'uncovered' }));
  });
  for (const t of yl.ticks) {
    const y = yl.y(t);
    g.append(s('line', { x1: 0, x2: plotW, y1: y, y2: y, class: t === 0 ? 'axis' : 'grid' }));
    g.append(s('text', { x: -8, y: y + 4, class: 'tick', 'text-anchor': 'end' }, countAxis(t)));
  }
  for (const t of yr.ticks) {
    g.append(s('text', { x: plotW + 8, y: yr.y(t) + 4, class: 'tick', 'text-anchor': 'start' }, moneyAxis(t)));
  }
  const every = Math.max(1, Math.ceil((n * 44) / plotW));
  const labelIdx = [];
  for (let i = 0; i < n; i += every) labelIdx.push(i);
  if (labelIdx.at(-1) !== n - 1) {
    if (n - 1 - labelIdx.at(-1) < every && labelIdx.length > 1) labelIdx.pop();
    labelIdx.push(n - 1);
  }
  for (const i of labelIdx) g.append(s('text', { x: i * band + band / 2, y: plotH + 18, class: 'tick', 'text-anchor': 'middle' }, formatDayMonthBR(points[i].date)));

  const hl = s('rect', { x: 0, y: 0, width: band, height: plotH, class: 'hover-band', visibility: 'hidden' });
  g.append(hl);

  // Barras empilhadas (2px de separação entre segmentos, topo arredondado).
  const barW = Math.max(2, Math.min(22, band * 0.6));
  points.forEach((p, i) => {
    if (!p.covered) return;
    const x = i * band + (band - barW) / 2;
    let acc = 0;
    bars.forEach((b, bi) => {
      const v = p.values[b.key] || 0;
      if (v <= 0) return;
      const y0 = yl.y(acc);
      const y1 = yl.y(acc + v);
      acc += v;
      const isTop = bars.slice(bi + 1).every((k) => !(p.values[k.key] > 0));
      const gap = bi > 0 && acc - v > 0 ? 2 : 0;
      const hgt = Math.max(0, y0 - y1 - gap);
      const d = isTop ? roundedTopBar(x, y1, barW, hgt, 3) : `M${x},${y1}h${barW}v${hgt}h${-barW}Z`;
      if (!d) return;
      const el = s('path', { d, class: `mark${p.partial ? ' partial' : ''}` });
      el.style.fill = `var(${b.color})`;
      g.append(el);
    });
  });

  // Linhas (eixo direito) com pontos.
  for (const l of lines) {
    const runs = [];
    let cur = [];
    points.forEach((p, i) => {
      const v = p.covered ? p.values[l.key] : null;
      if (!Number.isFinite(v)) {
        if (cur.length) runs.push(cur);
        cur = [];
        return;
      }
      cur.push({ x: i * band + band / 2, y: yr.y(v), partial: p.partial });
    });
    if (cur.length) runs.push(cur);
    for (const run of runs) {
      if (run.length > 1) {
        const path = s('path', { d: monotonePath(run), class: 'line' });
        path.style.stroke = `var(${l.color})`;
        g.append(path);
      }
      for (const pt of run) {
        const c = s('circle', { cx: pt.x, cy: pt.y, r: 2.8, class: `dot${pt.partial ? ' partial' : ''}` });
        c.style.fill = `var(${l.color})`;
        g.append(c);
      }
    }
  }

  const tip = h('div', { class: 'chart-tip', role: 'status', 'aria-live': 'polite', hidden: true });
  const wrap = h('div', { class: 'chart-wrap' }, svg, tip);
  container.append(wrap);
  let active = -1;
  const row = (color, value, label, kind) => {
    const r = h('div', { class: 'tip-row' }, h('span', { class: `tip-key tip-${kind}` }), h('strong', null, value), h('span', { class: 'tip-label' }, label));
    r.querySelector('.tip-key').style.setProperty('--key-color', `var(${color})`);
    return r;
  };
  const show = (i) => {
    if (i < 0 || i >= n) return hide();
    active = i;
    const p = points[i];
    hl.setAttribute('x', i * band);
    hl.setAttribute('visibility', 'visible');
    clear(tip);
    tip.append(h('div', { class: 'tip-date' }, `${weekdayBR(p.date)} ${formatDateBR(p.date)}${p.partial ? ' · parcial' : ''}`));
    if (!p.covered) tip.append(h('div', { class: 'tip-row muted' }, 'Sem coleta para este dia (ausência, não zero)'));
    else {
      for (const b of bars) tip.append(row(b.color, countFormat(p.values[b.key] || 0), b.label, 'rect'));
      if (bars.length > 1) tip.append(h('div', { class: 'tip-row tip-total' }, h('strong', null, countFormat(bars.reduce((a, b) => a + (p.values[b.key] || 0), 0))), h('span', { class: 'tip-label' }, 'Total')));
      for (const l of lines) {
        const v = p.values[l.key];
        tip.append(row(l.color, Number.isFinite(v) ? moneyFormat(v) : 'não calculável', l.label, 'line'));
      }
    }
    tip.hidden = false;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / width;
    const cx = (CM.left + i * band + band / 2) * scale;
    const tipW = tip.offsetWidth || 200;
    tip.style.left = `${Math.min(Math.max(4, cx - tipW / 2), Math.max(4, rect.width - tipW - 4))}px`;
    tip.style.top = '4px';
  };
  const hide = () => {
    active = -1;
    hl.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  svg.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    show(Math.floor((((ev.clientX - rect.left) / rect.width) * width - CM.left) / band));
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      const next = active < 0 ? (ev.key === 'ArrowRight' ? 0 : n - 1) : active + (ev.key === 'ArrowRight' ? 1 : -1);
      show(Math.min(n - 1, Math.max(0, next)));
    } else if (ev.key === 'Escape') hide();
  });
}
