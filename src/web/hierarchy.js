import { h } from './dom.js';
import { sortableTable } from './tables.js';
import { renderTimeChart } from './charts.js';
import { eachDay } from './shared/dates.js';
import { sumRows, deriveMetrics, spendBRL, ratio } from './shared/metrics.js';
import { fmtBRL, fmtInt, fmtPct, fmtAxisBRL } from './shared/format.js';
import { CATEGORY } from './shared/classify.js';

const levels = [
  { key: 'campaign', singular: 'Campanha', title: 'Campanhas' },
  { key: 'adset', singular: 'Conjunto', title: 'Conjuntos (Ad Sets)' },
  { key: 'ad', singular: 'Anúncio', title: 'Anúncios' },
];
const widths = new Map();
const sorts = new Map();

function groupRows(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return groups;
}

function summarize(rows, tax) {
  const m = deriveMetrics(sumRows(rows), tax);
  for (const [count, cost, category] of [['conversations', 'cpl', CATEGORY.WHATSAPP], ['follows', 'cps', CATEGORY.SEGUIDORES]]) {
    const t = sumRows(rows.filter(r => r.category === category));
    m[count] = t[count];
    m[cost] = ratio(spendBRL(t.spend_cents, tax), t[count]);
  }
  return m;
}

function columnsFor(view, singular) {
  const specs = [['spend','Gasto',fmtBRL], ['cpm','CPM',fmtBRL], ['ctr','CTR',fmtPct]];
  if (view.result !== 'follows') {
    specs.push(['cr','CR',fmtPct], ['convlp','ConvLP',fmtPct], ['conversations','Conversas',fmtInt], ['cpl','CPL',fmtBRL]);
  }
  if (view.result !== 'conversations') specs.push(['follows','Seguidores',fmtInt], ['cps','CPS',fmtBRL]);
  specs.push(['impressions','Impr.',fmtInt], ['link_clicks','Cliques',fmtInt], ['cpc','CPC',fmtBRL]);
  return [{ key:'name', label:singular, sortValue:r=>r.name, cell:r=>r.name },
    ...specs.map(([key,label,format])=>({key,label,num:true,sortValue:r=>r[key],cell:r=>
      ['cr','convlp'].includes(key) ? h('span',{title:'Métrica de página. A captação desta visão ocorre no WhatsApp.'},'—') : format(r[key])
    }))];
}

function sizeColumn(table, key, names) {
  const head = table.querySelector('thead th');
  const canvas = document.createElement('canvas').getContext('2d');
  canvas.font = '500 12.5px "Segoe UI",system-ui,sans-serif';
  const natural = Math.max(136, ...names.map(name=>Math.ceil(canvas.measureText(name).width)+26));
  const set = width => table.style.setProperty('--dim-width', 'min('+Math.max(100,width)+'px, 50vw)');
  set(widths.get(key) || natural);
  const handle = h('span',{class:'resize-column',title:'Arraste para ajustar. Dois cliques restauram a largura.'});
  head.append(handle);
  handle.onpointerdown = event => {
    const start = event.clientX, initial = head.offsetWidth;
    handle.setPointerCapture(event.pointerId);
    handle.onpointermove = e => { const w = Math.max(100,initial+e.clientX-start); widths.set(key,w); set(w); };
    handle.onlostpointercapture = () => {handle.onpointermove=null;};
  };
  handle.ondblclick = () => { widths.delete(key); set(natural); };
}

function trend(items, level, view, range, coveredDates, tax, selected, onSelect) {
  const following = view.result === 'follows';
  const cost = following ? 'cps' : 'cpl';
  const title = 'Custo por '+(following?'seguidor':'conversa')+', por '+level.singular.toLowerCase()+', por dia';
  const members = [...items].sort((a,b)=>(a[cost]??Infinity)-(b[cost]??Infinity) || a.name.localeCompare(b.name,'pt-BR'));
  const series = members.map((m,i)=>({key:m.id,label:m.name,color:'--entity-'+(i%10),item:m}));
  const visible = series.filter(s=>!selected.size || selected.has(s.key));
  const dates = range.empty ? [] : eachDay(range.since,range.until);
  const points = dates.map(date=>({date,covered:coveredDates.has(date),values:{}}));
  const byDate = new Map(points.map(p=>[p.date,p]));
  for (const member of visible) {
    for (const [date,rows] of groupRows(member.item.rows,'date')) {
      byDate.get(date).values[member.key]=summarize(rows,tax)[cost];
    }
  }
  const chart = h('div',{class:'entity-chart'});
  const legend = h('div',{class:'entity-legend'},series.map(s=>{
    const swatch=h('span',{class:'entity-swatch'});
    swatch.style.backgroundColor='var('+s.color+')';
    return h('button',{type:'button','aria-pressed':String(selected.has(s.key)),onClick:e=>onSelect(s.key,e)},
      swatch,s.label,h('small',null,fmtBRL(s.item[cost])));
  }));
  queueMicrotask(()=>{if(chart.isConnected) renderTimeChart(chart,{type:'line',series:visible,points,format:fmtBRL,axisFormat:fmtAxisBRL,title,height:150,externalLegend:true,onSeriesClick:onSelect});});
  return h('div',{class:'pair-chart'},h('div',{class:'pc-title'},title+' · clique numa linha ou na legenda para filtrar'),chart,legend);
}

export function hierarchy({ rows, view, range, state, tax, coveredDates, select, render }) {
  const panels=levels.map(level=>{
    const selected=new Set(state[level.key+'Id'].split(',').filter(Boolean));
    const scope=rows.filter(r=>levels.every(dim=>dim===level || !state[dim.key+'Id'] || state[dim.key+'Id'].split(',').includes(r[dim.key+'_id'])));
    const items=Array.from(groupRows(scope,level.key+'_id'),([id,group])=>({id,name:group[0][level.key+'_name'],rows:group,...summarize(group,tax)}));
    const columns=columnsFor(view,level.singular);
    const total=summarize(scope,tax);
    const footer=Object.fromEntries(columns.map(col=>[col.key,col.key==='name'?'Total Geral':col.cell(total)]));
    const pick=(id,e)=>select(level.key,id,e.ctrlKey||e.metaKey);
    const wrap=sortableTable({caption:level.title,columns,items,sort:sorts.get(level.key)||{key:'spend',dir:'desc'},
      onSort:s=>{sorts.set(level.key,s);render();},footer:scope.length?footer:null,
      rowAttrs:r=>({class:selected.has(r.id)?'entity-selected':'',title:r.name,tabindex:'0',
        onClick:e=>pick(r.id,e),onKeydown:e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick(r.id,e);}}})});
    sizeColumn(wrap.querySelector('table'),level.key,items.map(r=>r.name));
    return h('section',{class:'table-chart-pair',dataset:{level:level.key}},h('h3',{class:'thead-title'},level.title),wrap,
      items.length?trend(items,level,view,range,coveredDates,tax,selected,pick):h('p',{class:'note empty-dimension'},'Sem veiculação neste período ou filtro.'));
  });
  return [h('h2',{class:'sec-title'},'Hierarquia · Campanha → Conjunto → Anúncio'),...panels];
}


export function adRanking(rows, view, tax, select) {
  if (!rows.length) return [];
  const following = view.result === 'follows';
  const result = following ? 'follows' : 'conversations';
  const unit = following ? 'Seguidores' : 'Conversas';
  const cost = following ? 'cps' : 'cpl';
  const ads = Array.from(groupRows(rows, 'ad_id'), ([id, group]) => ({
    id, name: group[0].ad_name, ...summarize(group, tax)
  }));
  const leaders = [...ads].filter(a => a[result] > 0).sort((a,b) => b[result]-a[result] || a.name.localeCompare(b.name,'pt-BR')).slice(0,10);
  const bars = leaders.map(a => {
    const bar = h('span', {class:'rank-bar'});
    bar.style.width = (100*a[result]/leaders[0][result])+'%';
    return h('button',{type:'button',class:'rank-row',title:a.name,onClick:e=>select('ad',a.id,e.ctrlKey||e.metaKey)},
      h('span',{class:'rank-name'},a.name),h('span',{class:'rank-track'},bar),h('b',null,fmtInt(a[result])));
  });
  const columns = [
    {key:'name',label:'Anúncio',sortValue:a=>a.name,cell:a=>a.name},
    ...[['spend','Gasto',fmtBRL],[result,unit,fmtInt],[cost,cost.toUpperCase(),fmtBRL]].map(([key,label,format])=>({
      key,label,num:true,sortValue:a=>a[key],cell:a=>format(a[key])
    }))
  ];
  const table = h('div');
  const draw = sort => {
    table.replaceChildren(sortableTable({caption:'Compilado dos Anúncios',columns,items:ads,sort,onSort:draw,
      rowAttrs:a=>({title:a.name})}));
  };
  draw({key:cost,dir:'asc'});
  return h('div',{class:'ad-rankings'},
    h('section', {class:'rank-card'},h('h3',null,unit+' por anúncio'),h('p',null,'Top 10 anúncios'),bars.length?bars:h('p',null,'Sem resultados no período.')),
    h('section', {class:'rank-card'},h('h3',null,'Compilado dos Anúncios'),h('p',null,'Menor '+cost.toUpperCase()+' no topo'),table));
}
