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
export const VALIDATION_STATES = Object.freeze(['pendente', 'destino_conferido', 'conferido']);

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
  const adsetOwner = new Map();
  for (const [id, e] of Object.entries(map.campaigns || {})) {
    if (id.startsWith('$')) continue;
    if (!ID_RE.test(id)) errors.push(`campaign_id inválido: ${id}`);
    if (!e || typeof e !== 'object') {
      errors.push(`entrada inválida para ${id}`);
      continue;
    }
    const byAdset = e.doctor_scope === 'adset';
    if (byAdset) {
      // Campanha mista por médico: o médico vem SEMPRE do conjunto; a campanha não tem médico.
      if (e.doctor !== null) errors.push(`${id}: campanha com doctor_scope "adset" deve ter doctor null`);
      if (!e.adsets || Object.keys(e.adsets).filter((k) => !k.startsWith('$')).length === 0) errors.push(`${id}: doctor_scope "adset" exige o mapa adsets`);
    } else if (e.doctor_scope !== undefined) {
      errors.push(`${id}: doctor_scope inválido (${e.doctor_scope})`);
    } else if (!doctors[e.doctor]) errors.push(`${id}: médico desconhecido (${e.doctor})`);
    if (!funnels[e.funnel]) errors.push(`${id}: funil desconhecido (${e.funnel})`);
    if (!e.account_id || !ID_RE.test(e.account_id)) errors.push(`${id}: account_id obrigatório`);
    if (allowedAccountIds && e.account_id && !allowedAccountIds.includes(e.account_id)) {
      errors.push(`${id}: conta ${e.account_id} fora da allowlist`);
    }
    if (e.funnel === 'excluido' && !e.exclusion_reason) errors.push(`${id}: exclusion_reason obrigatório`);
    if (e.validation !== undefined && !VALIDATION_STATES.includes(e.validation)) errors.push(`${id}: validation deve ser ${VALIDATION_STATES.join('/')}`);
    for (const [sid, a] of Object.entries(e.adsets || {})) {
      if (sid.startsWith('$')) continue;
      if (!ID_RE.test(sid)) errors.push(`${id}: adset_id inválido ${sid}`);
      if (adsetOwner.has(sid)) errors.push(`conjunto ${sid} aparece em duas campanhas do mapa`);
      adsetOwner.set(sid, id);
      if (!a || typeof a !== 'object') {
        errors.push(`${id}/${sid}: entrada inválida`);
        continue;
      }
      if (!a.note) errors.push(`${id}/${sid}: note obrigatório (registro da conferência)`);
      if ('doctor' in a && a.doctor !== null && !doctors[a.doctor]) errors.push(`${id}/${sid}: médico desconhecido (${a.doctor})`);
      if (byAdset && !('doctor' in a)) errors.push(`${id}/${sid}: campanha mista por médico exige doctor (ou null = a confirmar)`);
      if (a.accept_destination_type !== undefined && (typeof a.accept_destination_type !== 'string' || !a.accept_destination_type)) {
        errors.push(`${id}/${sid}: accept_destination_type inválido`);
      }
    }
  }
  const legacy = Object.keys(map.adset_overrides || {}).filter((k) => !k.startsWith('$'));
  if (legacy.length) errors.push('adset_overrides não é mais suportado: use campaigns[<id>].adsets[<adset_id>]');
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

/** Médico efetivo de um conjunto: o do conjunto (se declarado no mapa) ou o da campanha. */
export function doctorForAdset(entry, adsetId) {
  const a = adsetId ? entry?.adsets?.[adsetId] : undefined;
  if (a && 'doctor' in a) return a.doctor;
  if (entry?.doctor_scope === 'adset') return null;
  return entry?.doctor ?? null;
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
  const adsetEntry = adset?.id ? entry.adsets?.[adset.id] : undefined;
  const doctor = doctorForAdset(entry, adset?.id);
  const base = { doctor, funnel: entry.funnel, destination_type: dest, validation: entry.validation || 'pendente' };
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
  if (!doctor) {
    return {
      ...base,
      category: CATEGORY.NAO_CONCILIADO,
      doctor_pending: true,
      reason: adsetEntry
        ? `Campanha mista por médico: médico deste conjunto ainda não confirmado (${adsetEntry.note})`
        : 'Campanha mista por médico: conjunto sem médico atribuído no mapa',
    };
  }
  if (!adset) {
    return { ...base, category: CATEGORY.NAO_CONCILIADO, reason: 'Metadados do conjunto ausentes (destino não verificado)' };
  }
  if (!dest) {
    return { ...base, category: CATEGORY.NAO_CONCILIADO, reason: 'Conjunto sem destination_type informado' };
  }
  const expected = map.funnels?.[entry.funnel]?.expected_destination_types || [];
  if (expected.includes(dest)) {
    return { ...base, category: entry.funnel, reason: `Destino ${dest} confere com o funil` };
  }
  if (adsetEntry?.accept_destination_type) {
    if (adsetEntry.accept_destination_type === dest) {
      return { ...base, category: entry.funnel, manual_override: true, reason: `Conciliação manual do conjunto (destino ${dest}): ${adsetEntry.note}` };
    }
    return {
      ...base,
      category: CATEGORY.NAO_CONCILIADO,
      reason: `Conciliação manual exige destino ${adsetEntry.accept_destination_type}, conjunto está com ${dest}`,
    };
  }
  if (MIXED_DESTINATIONS.has(dest)) {
    return { ...base, category: CATEGORY.NAO_CONCILIADO, reason: `Destino misto ${dest}: não é possível isolar o canal do funil` };
  }
  return {
    ...base,
    category: CATEGORY.NAO_CONCILIADO,
    reason: `Destino ${dest} diverge do funil ${entry.funnel} (esperado ${expected.join('/')})`,
  };
}
