// Classificação explícita: campaign_id -> médico -> funil, conferida por conjunto (destination_type).
// Nunca deduz médico pela conta nem pelo prefixo do nome (ENGJ/TRAF/DTS/DAT).

export const CATEGORY = Object.freeze({
  WHATSAPP: 'whatsapp',
  SEGUIDORES: 'seguidores',
  EXCLUIDO: 'excluido',
  NAO_CONCILIADO: 'nao_conciliado',
  NAO_CLASSIFICADO: 'nao_classificado',
});

export const CATEGORY_LABELS = Object.freeze({
  whatsapp: 'WhatsApp (conciliado)',
  seguidores: 'Seguidores (conciliado)',
  excluido: 'Fora da captação',
  nao_conciliado: 'Mapeado, destino não conciliado',
  nao_classificado: 'Não classificado (fora do mapa)',
});

/** Destinos que misturam canais: conversas não são atribuíveis só ao WhatsApp. */
export const MIXED_DESTINATIONS = new Set([
  'MESSAGING_MESSENGER_WHATSAPP',
  'MESSAGING_INSTAGRAM_DIRECT_MESSENGER',
  'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP',
  'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP',
  'INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE',
]);

const FUNNELS_WITH_RESULT = new Set(['whatsapp', 'seguidores']);
const ID_RE = /^\d{5,25}$/;

/** Valida a estrutura do mapa. Lança erro descritivo em caso de problema. */
export function validateCampaignMap(map, { allowedAccountIds } = {}) {
  const errors = [];
  if (!map || typeof map !== 'object') throw new Error('Mapa de campanhas ausente');
  const doctors = map.doctors || {};
  const funnels = map.funnels || {};
  for (const f of ['whatsapp', 'seguidores', 'excluido']) {
    if (!funnels[f]) errors.push(`funil obrigatório ausente: ${f}`);
  }
  for (const f of FUNNELS_WITH_RESULT) {
    const exp = funnels[f]?.expected_destination_types;
    if (!Array.isArray(exp) || exp.length === 0) errors.push(`funil ${f} sem expected_destination_types`);
  }
  for (const [id, e] of Object.entries(map.campaigns || {})) {
    if (id.startsWith('$')) continue;
    if (!ID_RE.test(id)) errors.push(`campaign_id inválido: ${id}`);
    if (!e || typeof e !== 'object') {
      errors.push(`entrada inválida para ${id}`);
      continue;
    }
    if (!doctors[e.doctor]) errors.push(`${id}: médico desconhecido (${e.doctor})`);
    if (!funnels[e.funnel]) errors.push(`${id}: funil desconhecido (${e.funnel})`);
    if (!e.account_id || !ID_RE.test(e.account_id)) errors.push(`${id}: account_id obrigatório`);
    if (allowedAccountIds && e.account_id && !allowedAccountIds.includes(e.account_id)) {
      errors.push(`${id}: conta ${e.account_id} fora da allowlist`);
    }
    if (e.funnel === 'excluido' && !e.exclusion_reason) errors.push(`${id}: exclusion_reason obrigatório`);
  }
  for (const [id, o] of Object.entries(map.adset_overrides || {})) {
    if (id.startsWith('$')) continue;
    if (!ID_RE.test(id)) errors.push(`adset override inválido: ${id}`);
    if (!doctors[o?.doctor]) errors.push(`override ${id}: médico desconhecido`);
    if (!FUNNELS_WITH_RESULT.has(o?.funnel)) errors.push(`override ${id}: funil deve ser whatsapp ou seguidores`);
    if (!o?.accept_destination_type) errors.push(`override ${id}: accept_destination_type obrigatório`);
    if (!o?.note) errors.push(`override ${id}: note obrigatório (registro da conferência)`);
  }
  if (errors.length) throw new Error(`Mapa de campanhas inválido:\n- ${errors.join('\n- ')}`);
  return true;
}

/** Sugestão (apenas informativa, nunca aplicada) a partir do destino do conjunto. */
export function suggestFromDestination(destinationType) {
  if (!destinationType) return 'destino desconhecido';
  if (destinationType === 'WHATSAPP') return 'possível WhatsApp';
  if (destinationType === 'INSTAGRAM_PROFILE') return 'possível Seguidores';
  if (MIXED_DESTINATIONS.has(destinationType)) return 'destino misto';
  return 'fora da captação';
}

/**
 * Classifica um conjunto (ou uma linha) a partir do mapa explícito.
 * @param {object} p
 * @param {string} p.campaignId
 * @param {string} p.accountId conta onde a campanha foi observada
 * @param {object|undefined} p.adset metadados do conjunto ({ id, destination_type })
 */
export function classify({ campaignId, accountId, adset }, map) {
  const entry = map.campaigns?.[campaignId];
  const dest = adset?.destination_type || null;
  if (!entry) {
    return {
      category: CATEGORY.NAO_CLASSIFICADO,
      doctor: null,
      funnel: null,
      destination_type: dest,
      reason: 'Campanha fora do mapa explícito',
      suggestion: suggestFromDestination(dest),
    };
  }
  const base = { doctor: entry.doctor, funnel: entry.funnel, destination_type: dest, validation: entry.validation || null };
  if (entry.account_id && accountId && entry.account_id !== accountId) {
    return {
      ...base,
      category: CATEGORY.NAO_CONCILIADO,
      reason: `Campanha mapeada para a conta ${entry.account_id}, observada na conta ${accountId}`,
    };
  }
  if (entry.funnel === 'excluido') {
    return { ...base, category: CATEGORY.EXCLUIDO, reason: `Excluída da captação: ${entry.exclusion_reason}` };
  }
  const override = adset?.id ? map.adset_overrides?.[adset.id] : undefined;
  if (override) {
    if (dest && override.accept_destination_type === dest) {
      return {
        ...base,
        doctor: override.doctor,
        funnel: override.funnel,
        category: override.funnel,
        reason: `Conciliação manual do conjunto: ${override.note}`,
        manual_override: true,
      };
    }
    return {
      ...base,
      category: CATEGORY.NAO_CONCILIADO,
      reason: `Override manual exige destino ${override.accept_destination_type}, conjunto está com ${dest || 'destino desconhecido'}`,
    };
  }
  if (!adset) {
    return { ...base, category: CATEGORY.NAO_CONCILIADO, reason: 'Metadados do conjunto ausentes (destino não verificado)' };
  }
  const expected = map.funnels?.[entry.funnel]?.expected_destination_types || [];
  if (!dest) {
    return { ...base, category: CATEGORY.NAO_CONCILIADO, reason: 'Conjunto sem destination_type informado' };
  }
  if (expected.includes(dest)) {
    return { ...base, category: entry.funnel, reason: `Destino ${dest} confere com o funil` };
  }
  if (MIXED_DESTINATIONS.has(dest)) {
    return { ...base, category: CATEGORY.NAO_CONCILIADO, reason: `Destino misto ${dest}: não é possível isolar o WhatsApp` };
  }
  return {
    ...base,
    category: CATEGORY.NAO_CONCILIADO,
    reason: `Destino ${dest} diverge do funil ${entry.funnel} (esperado ${expected.join('/')})`,
  };
}
