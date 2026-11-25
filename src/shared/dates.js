// Datas de calendário (AAAA-MM-DD) no fuso da conta (America/Sao_Paulo).
// Módulo compartilhado entre Node (coletor/testes) e navegador (dashboard).
// Toda aritmética usa UTC sobre datas de calendário puras para não sofrer com horário de verão.

export const DEFAULT_TZ = 'America/Sao_Paulo';
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

export function isIsoDate(s) {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function assertIsoDate(s, label = 'data') {
  if (!isIsoDate(s)) throw new Error(`${label} inválida (esperado AAAA-MM-DD): ${String(s).slice(0, 20)}`);
  return s;
}

function toUtcMs(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(s, n) {
  return fromUtcMs(toUtcMs(s) + n * DAY_MS);
}

/** Número de dias de `a` até `b` (b - a). */
export function diffDays(a, b) {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

export function minDate(a, b) {
  return a <= b ? a : b;
}

export function maxDate(a, b) {
  return a >= b ? a : b;
}

/** Lista inclusiva de dias [since, until]. */
export function eachDay(since, until) {
  const out = [];
  if (!since || !until || since > until) return out;
  for (let d = since; d <= until; d = addDays(d, 1)) out.push(d);
  return out;
}

export function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch {
    throw new Error(`Fuso horário inválido: ${timeZone}`);
  }
  return timeZone;
}

/** Data de calendário (AAAA-MM-DD) de um instante no fuso informado. */
export function dateInTimeZone(instant, timeZone = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function startOfMonth(s) {
  return `${s.slice(0, 8)}01`;
}

export function endOfMonth(s) {
  const [y, m] = s.split('-').map(Number);
  return fromUtcMs(Date.UTC(y, m, 0));
}

export const PRESETS = [
  { id: 'today', label: 'Hoje' },
  { id: 'yesterday', label: 'Ontem' },
  ...[3, 7, 14, 30].map(days => ({ id: 'rolling_' + days, label: days + ' dias' })),
  { id: 'this_month', label: 'Este mês' },
  { id: 'all', label: 'Todo período' },
  { id: 'last_7_complete', label: 'Últimos 7 dias completos' },
  { id: 'month_to_yesterday', label: 'Mês até ontem' },
  { id: 'previous_month', label: 'Mês anterior' },
  { id: 'custom', label: 'Personalizado' },
];

export const PRESET_IDS = new Set(PRESETS.map((p) => p.id));

/**
 * Intervalo inclusivo para um preset. `today` é a data atual no fuso da conta.
 * Os atalhos correntes incluem hoje; os recortes de dias completos terminam ontem,
 * e nesse caso `includesToday` sinaliza que o último dia é parcial.
 */
export function presetRange(preset, today, custom = {}) {
  assertIsoDate(today, 'hoje');
  switch (preset) {
    case 'today':
    case 'rolling_3':
    case 'rolling_7':
    case 'rolling_14':
    case 'rolling_30':
    case 'this_month':
    case 'all': {
      let since = today;
      if (preset.startsWith('rolling_')) since = addDays(today, 1 - Number(preset.slice(8)));
      if (preset === 'this_month') since = startOfMonth(today);
      if (preset === 'all' && isIsoDate(custom.dataStart)) since = minDate(custom.dataStart, today);
      return { since, until: today, empty: false, includesToday: true };
    }
    case 'yesterday': {
      const y = addDays(today, -1);
      return { since: y, until: y, empty: false, includesToday: false };
    }
    case 'last_7_complete':
      return { since: addDays(today, -7), until: addDays(today, -1), empty: false, includesToday: false };
    case 'month_to_yesterday': {
      const since = startOfMonth(today);
      const until = addDays(today, -1);
      if (until < since) {
        // Dia 1: ainda não existe dia completo no mês corrente.
        return { since, until: since, empty: true, includesToday: false, reason: 'primeiro_dia_do_mes' };
      }
      return { since, until, empty: false, includesToday: false };
    }
    case 'previous_month': {
      const lastPrev = addDays(startOfMonth(today), -1);
      return { since: startOfMonth(lastPrev), until: lastPrev, empty: false, includesToday: false };
    }
    case 'custom': {
      let { since, until } = custom;
      if (!isIsoDate(since) || !isIsoDate(until)) {
        return { since: today, until: today, empty: true, includesToday: false, reason: 'datas_invalidas' };
      }
      if (since > until) [since, until] = [until, since];
      if (since > today) {
        return { since, until, empty: true, includesToday: false, reason: 'periodo_futuro' };
      }
      // Não existem dados futuros: o limite superior é hoje (parcial).
      const clampedUntil = minDate(until, today);
      return {
        since,
        until: clampedUntil,
        empty: false,
        includesToday: clampedUntil === today,
        clampedFuture: clampedUntil !== until,
      };
    }
    default:
      throw new Error(`Preset desconhecido: ${preset}`);
  }
}

/** Divide [since, until] em janelas de até `windowDays` dias. */
export function splitWindows(since, until, windowDays) {
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error('windowDays deve ser inteiro >= 1');
  const out = [];
  let start = since;
  while (start <= until) {
    const end = minDate(addDays(start, windowDays - 1), until);
    out.push({ since: start, until: end });
    start = addDays(end, 1);
  }
  return out;
}

/** DD/MM/AAAA */
export function formatDateBR(s) {
  if (!isIsoDate(s)) return '';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

/** DD/MM */
export function formatDayMonthBR(s) {
  if (!isIsoDate(s)) return '';
  const [, m, d] = s.split('-');
  return `${d}/${m}`;
}

/** DD/MM/AAAA HH:MM no fuso informado (padrão: America/Sao_Paulo). */
export function formatDateTimeBR(isoInstant, timeZone = DEFAULT_TZ) {
  const dt = new Date(isoInstant);
  if (Number.isNaN(dt.getTime())) return '';
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(dt);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

const WEEKDAYS_PT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export function weekdayBR(s) {
  return WEEKDAYS_PT[new Date(toUtcMs(s)).getUTCDay()];
}
