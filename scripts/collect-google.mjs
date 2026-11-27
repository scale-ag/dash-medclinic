import { writeFile, rename } from 'node:fs/promises';

const accounts = [
  { id: '4273230248', name: 'MedClinic' },
  { id: '7372443244', name: 'Taísa Santana' },
];
const [since, until, output] = process.argv.slice(2);
const dateOk = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) === date;
if (!dateOk(since) || !dateOk(until) || since > until || !output) {
  throw Error('Informe início, fim (AAAA-MM-DD) e arquivo de saída.');
}
let { GOOGLE_ADS_ACCESS_TOKEN: access,
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: manager, GOOGLE_ADS_API_VERSION: version } = process.env;
if (!access && process.env.GOOGLE_ADS_OAUTH) {
  const {client_id, client_secret, refresh_token} = JSON.parse(process.env.GOOGLE_ADS_OAUTH);
  const response = await fetch('https://oauth2.googleapis.com/token', {method: 'POST',
    body: new URLSearchParams({client_id, client_secret, refresh_token, grant_type:'refresh_token'})});
  if (!response.ok) throw Error('Falha ao renovar autorização Google Ads: HTTP ' + response.status);
  access = (await response.json()).access_token;
}
if (!access || !/^v\d+$/.test(version || '')) {
  throw Error('A coleta requer OAuth do projeto com acesso de produção e versão ativa da API.');
}
const headers = { Authorization: 'Bearer ' + access,
  'Content-Type': 'application/json' };
if (manager) headers['login-customer-id'] = manager.replaceAll('-', '');
async function query(account, gaql) {
  const rows = [];
  let pageToken;
  do {
    const response = await fetch('https://googleads.googleapis.com/' + version +
      '/customers/' + account + '/googleAds:search', {
      method: 'POST', headers, body: JSON.stringify({ query: gaql, pageToken }),
    });
    if (!response.ok) throw Error('Google Ads ' + response.status + ' na conta ' + account +
      ', referência ' + (response.headers.get('request-id') || 'indisponível'));
    const data = await response.json();
    rows.push(...(data.results || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return rows;
}
const range = " FROM campaign WHERE segments.date BETWEEN '" + since + "' AND '" + until + "'";
const snapshot = { since, until, collectedAt: new Date().toISOString(), accounts: [] };
for (const account of accounts) {
  const daily = await query(account.id,
    'SELECT segments.date, campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions' + range);
  const byAction = await query(account.id,
    'SELECT segments.date, campaign.id, segments.conversion_action, segments.conversion_action_name, metrics.conversions' + range);
  snapshot.accounts.push({ ...account, daily, byAction });
}
const sheetUrl = new URL('https://docs.google.com/spreadsheets/d/'+encodeURIComponent(process.env.GOOGLE_LEADS_SHEET_ID)+'/gviz/tq');
sheetUrl.search = new URLSearchParams({ gid:'0', headers:'1', tqx:'out:json', tq:'select D,E,F,J,K' });
const response = await fetch(sheetUrl, {signal: AbortSignal.timeout(30000)});
if (!response.ok) throw Error('Planilha de contatos indisponível: HTTP '+response.status);
const body = await response.text();
const payload = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
const columns = ['Pagina','Utm_source','Utm_medium','Url','dia/horario'];
if (payload.status !== 'ok' || payload.table?.cols.map(c=>c.label).join('|') !== columns.join('|'))
  throw Error('Formato inesperado na planilha de contatos.');
const dayBR = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'});
const counted = new Set();
snapshot.sheetLeads = [];
const counts = new Map();
for (const row of payload.table.rows) {
  const [page, source, medium, rawUrl, time] = row.c.map(c=>String(c?.v ?? '').trim());
  const url = new URL(rawUrl || 'about:blank');
  const src = (source || url.searchParams.get('utm_source') || '').toLowerCase();
  const med = (medium || url.searchParams.get('utm_medium') || '').toLowerCase();
  const clickId = ['gclid','gbraid','wbraid'].some(k=>url.searchParams.get(k));
  if (!(src === 'google-ads' || src === 'google_ads' || (src === 'google' && /^(cpc|ppc|paidsearch)$/.test(med)) || ((!src || src === 'google') && clickId))) continue;
  const host = url.hostname.replace(/^www\./,'');
  let doctor;
  if (host === 'ailtoncardoso.com.br' || host.endsWith('.ailtoncardoso.com.br')) doctor = 'Dr. Ailton';
  else if (host === 'taisasantana.com.br' || host.endsWith('.taisasantana.com.br')) doctor = 'Dra. Taísa';
  else if (['site-ailton-home-v1','lp-acompanhamento-online-v1'].includes(page)) doctor = 'Dr. Ailton';
  else if (['lp-tricologia-v1','lp-tricologia-v4-black'].includes(page)) doctor = 'Dra. Taísa';
  else throw Error('Contato pago com página sem médico cadastrado.');
  if (!time || !Number.isFinite(Date.parse(time))) throw Error('Contato pago sem data válida.');
  const day = dayBR.format(new Date(time));
  if (day < since || day > until) continue;
  const key = [time,doctor,page,rawUrl].join('|');
  if (counted.has(key)) continue;
  counted.add(key);
  const group = day+'|'+doctor;
  counts.set(group,(counts.get(group) || 0)+1);
}
snapshot.sheetLeads = Array.from(counts, ([key,count])=>{
  const [date,doctor] = key.split('|');
  return {date,doctor,count};
});
await writeFile(output + '.tmp', JSON.stringify(snapshot));
await rename(output + '.tmp', output);
