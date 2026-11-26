import {h, clear} from './dom.js';
import {fmtBRL, fmtInt, fmtDec} from './shared/format.js';
import {formatDateTimeBR} from './shared/dates.js';

const doctors = new Map([
  ['20706809674','Dr. Ailton'],
  ['22653305722','Dr. Ailton'], ['24453230280','Dra. Taísa'],
  ['24202481670','Dra. Taísa'], ['24465669551','Dra. Taísa'],
]);
let selection = '';
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
export function renderGoogle(main,data,range) {
  clear(main);
  if (!data) {main.append(h('p',{class:'notice'},'Coleta Google Ads indisponível.'));return;}
  main.append(h('p',{class:'note'},'Última coleta Google Ads: '+formatDateTimeBR(data.collectedAt)+'. O dia da coleta é parcial.'));
  if (range.empty || range.since < data.since || range.until > data.until) {
    main.append(h('p',{class:'notice'},'Selecione um período dentro da cobertura de '+data.since+' a '+data.until+'.'));return;
  }
  const select = h('select',{'aria-label':'Médico',onChange(e){selection=e.target.value;renderGoogle(main,data,range);}},
    ['', 'Dr. Ailton','Dra. Taísa','Sem classificação'].map(v=>h('option',{value:v,selected:selection===v},v||'Todos os médicos')));
  main.append(h('label',null,'Médico ',select));
  const doctor = r=>doctors.get(r.campaign.id)||'Sem classificação';
  const match = r=> r.segments.date>=range.since && r.segments.date<=range.until && (!selection || doctor(r)===selection);
  const rows=data.accounts.flatMap(a=>a.daily).filter(match);
  const t=totals(rows);
  const moneyRatio=(a,b)=>fmtBRL(b?a/b:null);
  main.append(h('section',{class:'card'},table(['Investimento','Conversões','Custo por conversão','Cliques','CPC'],
    [[fmtBRL(t.spend),fmtDec(t.conversions),moneyRatio(t.spend,t.conversions),fmtInt(t.clicks),moneyRatio(t.spend,t.clicks)]])));
  const campaigns=Map.groupBy(rows,r=>r.campaign.id);
  main.append(h('section',{class:'card'},h('h2',null,'Campanhas'),table(['Campanha','Médico','Investimento','Cliques','Conversões','Custo por conversão'],
    Array.from(campaigns.values(),group=>{const m=totals(group);return [group[0].campaign.name,doctor(group[0]),
      fmtBRL(m.spend),fmtInt(m.clicks),fmtDec(m.conversions),moneyRatio(m.spend,m.conversions)];}))));
  const actions=Map.groupBy(data.accounts.flatMap(a=>a.byAction).filter(match),r=>r.segments.conversionAction);
  main.append(h('section',{class:'card'},h('h2',null,'Ações de conversão'),table(['Ação registrada pelo Google','Conversões'],
    Array.from(actions.values(),group=>[group[0].segments.conversionActionName,fmtDec(totals(group).conversions)]))),
    h('p',{class:'note'},'Conversões correspondem às ações configuradas no Google Ads. A confirmação de atendimento ou consulta depende do acompanhamento da clínica.'));
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
