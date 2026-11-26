// Mapeia apenas impulsionamentos de perfis verificados nas contas habilitadas.
// O mapa manual tem precedência. Um conjunto com perfis mistos fica pendente.
export function withProfileCampaigns(snapshot, manualMap, accounts) {
  const map = structuredClone(manualMap);
  const profiles = new Map(accounts.filter(a => a.instagram_profiles).map(a => [a.id, a.instagram_profiles]));
  const groups = new Map();
  for (const ad of Object.values(snapshot.ads)) {
    if (!profiles.has(ad.account_id) || manualMap.campaigns[ad.campaign_id]) continue;
    const members = groups.get(ad.adset_id) || [];
    members.push(ad);
    groups.set(ad.adset_id, members);
  }
  for (const [id, members] of groups) {
    const set = snapshot.adsets[id];
    if (!set) continue;
    const roster = profiles.get(set.account_id);
    if (!roster || !members.every(a => a.account_id === set.account_id && a.campaign_id === set.campaign_id)) continue;
    const doctors = new Set(members.map(a => roster[a.instagram_user_id]));
    if (doctors.size !== 1 || doctors.has(undefined)) continue;
    const legacy = set.destination_type === 'UNDEFINED';
    const confirmedLegacy = legacy && (set.optimization_goal === 'VISIT_INSTAGRAM_PROFILE' || members.every(a => a.profile_cta === true));
    if (set.destination_type !== 'INSTAGRAM_PROFILE' && !confirmedLegacy) continue;
    const entry = map.campaigns[set.campaign_id] ||= {
      account_id: set.account_id, doctor: null, doctor_scope: 'adset', funnel: 'seguidores',
      name_observed: snapshot.campaigns[set.campaign_id]?.name, validation: 'destino_conferido', adsets: {},
    };
    entry.adsets[id] = {
      doctor: [...doctors][0],
      note: 'Perfil Instagram do criativo confirmado. Destino, otimização ou botão direciona ao perfil.',
      ...(legacy ? { accept_destination_type: 'UNDEFINED' } : {}),
    };
  }
  return map;
}
