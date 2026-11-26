// Formatação pt-BR. Valores null => "—" (não calculável), com o motivo exposto pela UI.

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const int = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const dec2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

export const DASH = '—';

export function fmtBRL(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : brl.format(v);
}

export function fmtInt(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : int.format(v);
}

export function fmtPct(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : `${dec2.format(v)}%`;
}

export function fmtDec(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}

export function fmtCompact(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : compact.format(v);
}

/** Valor curto para eixos: R$ 1,2 mil etc. */
export function fmtAxisBRL(v) {
  if (!Number.isFinite(v)) return '';
  if (Math.abs(v) >= 1000) return `R$ ${compact.format(v)}`;
  return Number.isInteger(v) ? `R$ ${int.format(v)}` : fmtBRL(v);
}

export function fmtMinutesAgo(minutes) {
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'agora há pouco';
  if (minutes < 60) return `há ${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h < 48) return m ? `há ${h} h ${m} min` : `há ${h} h`;
  return `há ${Math.floor(h / 24)} dias`;
}
