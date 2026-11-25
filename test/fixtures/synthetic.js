// GERADOR DE DADOS SINTÉTICOS — USO EXCLUSIVO EM TESTES E PREVIEW LOCAL.
// O snapshot gerado tem kind="synthetic-test" e source="synthetic"; build/validação de produção o rejeitam
// e o dashboard exibe uma faixa "DADOS SINTÉTICOS" sempre que carregá-lo.
// Usa os IDs do mapa explícito para exercitar a classificação; todos os nomes começam com "[SINTÉTICO]".
import { addDays, eachDay } from '../../src/shared/dates.js';

const CA01 = '203811442663021';
const CA02 = '1530307658790959';

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// [campaign_id, account, nome, objetivo, status, [[adset_id, destino, [ad_ids], optimization_goal?]], perfil]
// Estrutura alinhada ao que foi conferido via API em 25/11/2026 (destinos/otimização); NÚMEROS são inventados.
const CAMPAIGNS = [
  ['120242361567150317', CA01, '[SINTÉTICO] [WhatsApp][Taísa]', 'OUTCOME_ENGAGEMENT', 'PAUSED', [['910000000000000101', 'WHATSAPP', ['920000000000001011', '920000000000001012']]], { conv: 1 / 14, pauseAfter: 14 }],
  ['120243388359980317', CA01, '[SINTÉTICO] [WhatsApp][Ailton]', 'OUTCOME_ENGAGEMENT', 'ACTIVE', [['910000000000000201', 'WHATSAPP', ['920000000000002011', '920000000000002012']]], { conv: 1 / 18 }],
  ['120248339618150317', CA01, '[SINTÉTICO] DTS Ads tricologia', 'OUTCOME_ENGAGEMENT', 'ACTIVE', [
    ['910000000000000301', 'WHATSAPP', ['920000000000003011']],
    ['910000000000000302', 'WHATSAPP', ['920000000000003021']],
  ], { conv: 1 / 12 }],
  ['120248374076630317', CA01, '[SINTÉTICO] DAT WPP Top Ads', 'OUTCOME_ENGAGEMENT', 'ACTIVE', [['910000000000000401', 'WHATSAPP', ['920000000000004011', '920000000000004012']]], { conv: 1 / 16 }],
  ['120248471528140317', CA01, '[SINTÉTICO] DAT WPP Teste de Ads', 'OUTCOME_ENGAGEMENT', 'ACTIVE', [['910000000000000501', 'WHATSAPP', ['920000000000005011']]], { conv: 1 / 20 }],
  ['120246982288180317', CA01, '[SINTÉTICO] VideoView Taísa', 'OUTCOME_AWARENESS', 'PAUSED', [['910000000000000601', 'ON_VIDEO', ['920000000000006011'], 'THRUPLAY']], { conv: 0, cheap: true }],
  ['120246982670850317', CA01, '[SINTÉTICO] VideoView Ailton', 'OUTCOME_AWARENESS', 'PAUSED', [['910000000000000701', 'ON_VIDEO', ['920000000000007011'], 'THRUPLAY']], { conv: 0, cheap: true }],
  ['120248258608230317', CA01, '[SINTÉTICO] DTS LPV4', 'OUTCOME_TRAFFIC', 'ACTIVE', [['910000000000000801', 'WEBSITE', ['920000000000008011'], 'LANDING_PAGE_VIEWS']], { conv: 0 }],
  ['120248334203780317', CA01, '[SINTÉTICO] DTS LPV6', 'OUTCOME_TRAFFIC', 'ACTIVE', [['910000000000000901', 'WEBSITE', ['920000000000009011'], 'LANDING_PAGE_VIEWS']], { conv: 0 }],
  // Seguidores: campanhas históricas pausadas, SEM veiculação no período.
  ['120242435400470317', CA01, '[SINTÉTICO] [Tráfego][Taísa] Seguidores Instagram', 'OUTCOME_TRAFFIC', 'PAUSED', [
    ['120243833203900317', 'INSTAGRAM_PROFILE', [], 'VISIT_INSTAGRAM_PROFILE'],
    ['120242435400480317', 'INSTAGRAM_PROFILE', [], 'VISIT_INSTAGRAM_PROFILE'],
  ], { noDelivery: true }],
  ['120236975999600317', CA01, '[SINTÉTICO] ENGAJAMENTO|NOVOS SEGUIDORES|DRS', 'OUTCOME_ENGAGEMENT', 'PAUSED', [
    ['120236995354460317', 'INSTAGRAM_PROFILE', [], 'VISIT_INSTAGRAM_PROFILE'],
    ['120236975999730317', 'INSTAGRAM_PROFILE', [], 'VISIT_INSTAGRAM_PROFILE'],
  ], { noDelivery: true }],
  ['120251418554480262', CA02, '[SINTÉTICO] DTS ENGJ ABO Teste de Ads', 'OUTCOME_ENGAGEMENT', 'ACTIVE', [['910000000000001001', 'WHATSAPP', ['920000000000010011', '920000000000010012']]], { conv: 1 / 15 }],
  ['120251528556640262', CA02, '[SINTÉTICO] DTS TRAF 25/11 A', 'OUTCOME_TRAFFIC', 'ACTIVE', [['910000000000001101', 'WHATSAPP', ['920000000000011011']]], { conv: 1 / 17, startOffset: -3 }],
  ['120251521306570262', CA02, '[SINTÉTICO] DTS TRAF 25/11 B', 'OUTCOME_TRAFFIC', 'ACTIVE', [['910000000000001201', 'WHATSAPP', ['920000000000012011'], 'LINK_CLICKS']], { conv: 1 / 40, startOffset: -3 }],
  ['120251418123510262', CA02, '[SINTÉTICO] DTS ENGJ ABO', 'OUTCOME_ENGAGEMENT', 'ACTIVE', [['910000000000001301', 'WHATSAPP', ['920000000000013011']]], { conv: 1 / 16 }],
  // Fictícias, FORA do mapa, para exercitar "não classificado" (IDs 9000…).
  ['900000000000000001', CA02, '[SINTÉTICO] campanha fora do mapa', 'OUTCOME_ENGAGEMENT', 'ACTIVE', [['910000000000009001', 'WHATSAPP', ['920000000000090011']]], { conv: 1 / 17, startOffset: -6 }],
  ['900000000000000002', CA02, '[SINTÉTICO] campanha fora do mapa (destino misto)', 'OUTCOME_ENGAGEMENT', 'ACTIVE', [['910000000000009002', 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP', ['920000000000090021']]], { conv: 1 / 15, startOffset: -6 }],
  ['900000000000000003', CA01, '[SINTÉTICO] antiga perfil Instagram sem médico', 'OUTCOME_TRAFFIC', 'PAUSED', [['910000000000009003', 'INSTAGRAM_PROFILE', [], 'VISIT_INSTAGRAM_PROFILE']], { noDelivery: true }],
];

export const SYNTHETIC_ACCOUNTS = [
  { id: CA01, label: 'CA01', name: '[SINTÉTICO] CA01' },
  { id: CA02, label: 'CA02', name: '[SINTÉTICO] CA02' },
];

/**
 * @param {object} p
 * @param {string} p.today data "hoje" (America/Sao_Paulo); o dia é parcial
 * @param {string} p.dataStart início do histórico
 * @param {string} p.generatedAt instante ISO da "coleta"
 */
export function makeSyntheticSnapshot({ today = '2026-11-25', dataStart = '2026-11-01', generatedAt = '2026-11-25T13:00:00.000Z', seed = 42 } = {}) {
  const rnd = prng(seed);
  const days = eachDay(dataStart, today);
  const zeroDayCA02 = addDays(dataStart, 3); // dia com zero confirmado na CA02
  const campaigns = {};
  const adsets = {};
  const ads = {};
  const rows = [];
  for (const [cid, acc, name, objective, status, sets, prof] of CAMPAIGNS) {
    campaigns[cid] = { account_id: acc, name, objective, status, effective_status: status, buying_type: 'AUCTION' };
    for (const [sid, dest, adIds, goal] of sets) {
      adsets[sid] = {
        account_id: acc,
        campaign_id: cid,
        name: `[SINTÉTICO] Conjunto ${dest}`,
        destination_type: dest,
        optimization_goal: goal || (dest === 'WHATSAPP' ? 'CONVERSATIONS' : 'LINK_CLICKS'),
        billing_event: 'IMPRESSIONS',
        attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
        status,
        effective_status: status,
      };
      for (const [i, adId] of adIds.entries()) {
        ads[adId] = { account_id: acc, campaign_id: cid, adset_id: sid, name: `[SINTÉTICO] Anúncio ${i + 1}` };
        for (const [di, date] of days.entries()) {
          if (prof.noDelivery) continue;
          if (prof.pauseAfter && di >= prof.pauseAfter) continue;
          if (prof.startOffset && date < addDays(today, prof.startOffset)) continue;
          if (acc === CA02 && date === zeroDayCA02) continue;
          if (rnd() < 0.08) continue; // dias sem entrega
          const partialFactor = date === today ? 0.45 : 1;
          const spend = Math.round((prof.cheap ? 600 + rnd() * 900 : 1800 + rnd() * 6200) * partialFactor);
          const impressions = Math.round(spend * (0.45 + rnd() * 0.5));
          const linkClicks = Math.round(impressions * (0.006 + rnd() * 0.018));
          const conversations = prof.conv ? Math.max(0, Math.round((spend / 100) * prof.conv * (0.6 + rnd() * 0.8))) : 0;
          const follows = prof.follow ? Math.round((spend / 100) * prof.follow * (0.5 + rnd())) : rnd() < 0.2 ? 1 : 0;
          rows.push({ account_id: acc, date, campaign_id: cid, adset_id: sid, ad_id: adId, spend_cents: spend, impressions, link_clicks: linkClicks, conversations, follows });
        }
      }
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ad_id.localeCompare(b.ad_id)));
  const accounts = SYNTHETIC_ACCOUNTS.map((a) => {
    const d = {};
    for (const date of days) {
      const adSpend = rows.filter((r) => r.account_id === a.id && r.date === date).reduce((s, r) => s + r.spend_cents, 0);
      const adImpr = rows.filter((r) => r.account_id === a.id && r.date === date).reduce((s, r) => s + r.impressions, 0);
      // Pequena diferença em um dia da CA01 para demonstrar a conciliação (dentro da tolerância).
      const extra = a.id === CA01 && date === addDays(dataStart, 5) ? 37 : 0;
      d[date] = { fetched_at: generatedAt, account_spend_cents: adSpend + extra, account_impressions: adImpr };
    }
    return {
      id: a.id,
      label: a.label,
      name: a.name,
      currency: 'BRL',
      timezone_name: 'America/Sao_Paulo',
      account_status: 1,
      business_id: '437935417525828',
      warnings: [],
      last_success_at: generatedAt,
      coverage: { since: dataStart, until: today },
      recollected_range: { since: dataStart, until: today, mode: 'full' },
      days: d,
    };
  });
  return {
    schema_version: 1,
    kind: 'synthetic-test',
    source: 'synthetic',
    generated_at: generatedAt,
    timezone: 'America/Sao_Paulo',
    currency: 'BRL',
    data_start: dataStart,
    today,
    today_is_partial: true,
    api: {
      requested_version: 'v25.0',
      effective_versions: ['v27.0'],
      app_id_verified: null,
      use_unified_attribution_setting: true,
      action_report_time: null,
      attribution_rule: '[SINTÉTICO] use_unified_attribution_setting=true',
      conversation_action_type: 'onsite_conversion.messaging_conversation_started_7d',
      follow_field: 'instagram_profile_follow',
      ad_effective_status_filter: null,
      level: 'ad',
      time_increment: 1,
    },
    collection: { mode: 'full', base_reason: 'sintético', reprocess_days: 28, window_days: 7, started_at: generatedAt, finished_at: generatedAt },
    accounts,
    campaigns,
    adsets,
    ads,
    rows,
  };
}
