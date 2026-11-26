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
await writeFile(output + '.tmp', JSON.stringify(snapshot));
await rename(output + '.tmp', output);
