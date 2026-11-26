import {h, clear} from './dom.js';
import {fmtBRL, fmtInt, fmtDec} from './shared/format.js';
import {formatDateTimeBR} from './shared/dates.js';

const doctors = new Map([
  ['20706809674','Dr. Ailton'],
  ['22653305722','Dr. Ailton'], ['24453230280','Dra. Taísa'],
  ['24202481670','Dra. Taísa'], ['24465669551','Dra. Taísa'],
]);
function totals(rows) {
  return rows.reduce((t,{metrics:m}) => ({
    spend:t.spend+Number(m.costMicros || 0)/1e6, clicks:t.clicks+Number(m.clicks || 0),
    conversions:t.conversions+Number(m.conversions || 0)
  }),{spend:0,clicks:0,conversions:0});
}
function table(labels, rows) {
  return h('div',{class:'table-wrap'},h('table',null,
    h('thead',null,h('tr',null,labels.map(v=>h('th',null,v)))),
    h('tbody',null,rows.map(values=>h('tr',null,values.map(v=>h('td',null,v)))))));
}
export function renderGoogle(main, data, range, step) {
  clear(main);
  if (!data) {
    main.append(h('p', {class:'notice'}, 'Coleta Google Ads indisponível.'));
    return;
  }
  if (range.empty || range.since < data.since || range.until > data.until) {
    main.append(h('p', {class:'notice'}, 'Selecione um período dentro da cobertura de '+data.since+' a '+data.until+'.'));
    return;
  }
  const rows = data.accounts.flatMap(account => account.daily)
    .filter(row => row.segments.date >= range.since && row.segments.date <= range.until);
  const grid = h('div', {class:'grid google-doctors'});
  for (const name of ['Dr. Ailton', 'Dra. Taísa']) {
    const metrics = totals(rows.filter(row => doctors.get(row.campaign.id) === name));
    const {spend, clicks, conversions} = metrics;
    const costPerConversion = fmtBRL(conversions ? spend / conversions : null);
    const cpc = fmtBRL(clicks ? spend / clicks : null);
    grid.append(h('section', {class:'card', 'aria-label':name},
      h('h2', {class:'sec-title'}, name),
      h('div', {class:'funnel'},
        step({label:'Valor gasto', value:fmtBRL(spend), tone:'hl-gasto'}),
        step({label:'Conversões', value:Number.isInteger(conversions) ? fmtInt(conversions) : fmtDec(conversions),
          tone:'hl-conv', secs:[['Custo por conversão', costPerConversion]]}),
        step({label:'Cliques', value:fmtInt(clicks), secs:[['CPC', cpc]]}))));
  }
  main.append(grid, h('p', {class:'note'}, 'Última coleta do Google Ads em '+formatDateTimeBR(data.collectedAt)+'.'));
  if (rows.some(row => !doctors.has(row.campaign.id))) {
    main.append(h('p',{class:'note'},'Há campanhas sem médico identificado fora destes cartões.'));
  }
}

export function combinedSpend(data,range,metaRows,metaSpend) {
  if (!data || range.empty || range.since<data.since || range.until>data.until) return null;
  const googleRows=data.accounts.flatMap(a=>a.daily).filter(r=>r.segments.date>=range.since && r.segments.date<=range.until);
  const groups=[['ailton','Dr. Ailton'],['taisa','Dra. Taísa'],[null,'Sem classificação']];
  const body=groups.map(([key,label])=>{
    const meta=metaSpend(metaRows.filter(r=>key?r.doctor===key:!['ailton','taisa'].includes(r.doctor)).reduce((sum,r)=>sum+r.spend_cents,0));
    const google=totals(googleRows.filter(r=>(doctors.get(r.campaign.id)||'Sem classificação')===label)).spend;
    return [label,fmtBRL(meta),fmtBRL(google),fmtBRL(meta+google)];
  });
  const meta=metaSpend(metaRows.reduce((sum,r)=>sum+r.spend_cents,0));
  const google=totals(googleRows).spend;
  body.push(['Total',fmtBRL(meta),fmtBRL(google),fmtBRL(meta+google)]);
  return h('section',{class:'card'},h('h2',null,'Investimento por médico e canal'),
    table(['Médico','Meta Ads','Google Ads','Total'],body));
}
