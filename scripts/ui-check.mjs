#!/usr/bin/env node
// Inspeção de UI LOCAL com dados SINTÉTICOS (requer Playwright instalado na máquina; não roda no CI).
// Abre as 5 visões em desktop e mobile, claro e escuro; registra erros de console, overflow horizontal
// e tira screenshots em .work/screenshots/.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const { values } = parseArgs({ options: { dir: { type: 'string', default: '.work/dist-synthetic' }, port: { type: 'string', default: '8791' }, out: { type: 'string', default: '.work/screenshots' } } });
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    ({ chromium } = createRequire(import.meta.url)('playwright')); // instalação global (NODE_PATH)
  } catch {
    chromium = null;
  }
}
if (!chromium) {
  console.error('Playwright não disponível. Instale localmente (fora do repositório) para rodar esta inspeção.');
  process.exit(2);
}

const server = spawn(process.execPath, ['scripts/serve.mjs', '--dir', values.dir, '--port', values.port], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.once('data', r));
await mkdir(values.out, { recursive: true });
const base = `http://localhost:${values.port}/dash-medclinic/`;
const views = ['geral', 'whatsapp-taisa', 'whatsapp-ailton', 'seguidores-ailton', 'seguidores-taisa'];
const problems = [];
const browser = await chromium.launch();
try {
  for (const [device, viewport] of [['desktop', { width: 1366, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 1, timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') problems.push(`${device}/${scheme}: console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`${device}/${scheme}: pageerror: ${e.message}`));
      for (const v of views) {
        await page.goto(`${base}#v=${v}&p=month_to_yesterday`, { waitUntil: 'networkidle' });
        await page.waitForSelector('.view-head h1');
        await page.waitForTimeout(150);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) problems.push(`${device}/${scheme}/${v}: overflow horizontal de ${overflow}px`);
        await page.screenshot({ path: `${values.out}/${device}-${scheme}-${v}.png`, fullPage: true });
      }
      await ctx.close();
    }
  }
  // Interações (desktop, claro).
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true, timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`interação: pageerror: ${e.message}`));
  const check = (cond, msg) => {
    if (!cond) problems.push(`interação: ${msg}`);
  };
  await page.goto(`${base}#v=whatsapp-taisa`, { waitUntil: 'networkidle' });
  const campaignSelect = page.locator('.filters label:has-text("Campanha") select');
  const firstCampaign = await campaignSelect.locator('option').nth(1).getAttribute('value');
  await campaignSelect.selectOption(firstCampaign);
  check(page.url().includes(`c=${firstCampaign}`), 'filtro de campanha não foi para a URL');
  await page.getByRole('link', { name: 'WhatsApp Ailton' }).click();
  check(page.url().includes(`c=${firstCampaign}`), 'filtro não é compartilhado entre abas');
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  check(!page.url().includes('c='), 'limpar filtros não removeu a campanha');
  await page.locator('.filters label:has-text("Período") select').selectOption('custom');
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()));
  await page.locator('.filters input[type=date]').nth(1).fill(today);
  await page.locator('.filters input[type=date]').nth(1).dispatchEvent('change');
  check(await page.locator('.range-text .badge', { hasText: 'parcial' }).count() === 1, 'período com hoje não foi marcado como parcial');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar CSV' }).click()]);
  const csv = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
  check(csv.startsWith('\uFEFFdata;conta;medico;'), 'CSV sem BOM/cabeçalho esperado');
  check(download.suggestedFilename().includes('SINTETICO'), 'CSV sintético sem marcação no nome');
  const before = await page.locator('table.tree tbody tr').count();
  await page.locator('table.tree .tree-toggle').first().click();
  check((await page.locator('table.tree tbody tr').count()) > before, 'drill-down não expandiu');
  await page.locator('table.tree thead button', { hasText: 'Impressões' }).click();
  check((await page.locator('table.tree thead th[aria-sort="descending"]').count()) === 1, 'ordenação não aplicada');
  const heroBefore = await page.locator('.kpi-hero .kpi-value').first().textContent();
  await page.locator('.switch input').uncheck();
  const heroAfter = await page.locator('.kpi-hero .kpi-value').first().textContent();
  check(heroBefore !== heroAfter && page.url().includes('imp=0'), 'toggle de imposto não alterou o investimento');
  await page.getByRole('button', { name: 'Recarregar dados' }).click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Snapshot recarregado'), null, { timeout: 5000 }).catch(() => {});
  check((await page.locator('#toast').textContent()).includes('não dispara coleta'), 'recarregar não explicou que não coleta');
  await page.locator('.chart-svg').first().focus();
  await page.keyboard.press('ArrowRight');
  check(await page.locator('.chart-tip:not([hidden])').count() === 1, 'tooltip por teclado não apareceu');
  await page.screenshot({ path: `${values.out}/interacao-desktop.png`, fullPage: false });
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}
if (problems.length) {
  console.error(`Problemas:\n- ${problems.join('\n- ')}`);
  process.exitCode = 1;
} else console.log(`UI ok: screenshots em ${values.out}`);
