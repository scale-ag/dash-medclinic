import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dateInTimeZone, eachDay, formatDateBR, formatDateTimeBR, isIsoDate, presetRange, splitWindows } from '../src/shared/dates.js';

test('fuso America/Sao_Paulo: virada do dia acontece às 03:00 UTC', () => {
  assert.equal(dateInTimeZone(new Date('2026-11-26T02:59:59Z'), 'America/Sao_Paulo'), '2026-11-25');
  assert.equal(dateInTimeZone(new Date('2026-11-26T03:00:00Z'), 'America/Sao_Paulo'), '2026-11-26');
  // Sem horário de verão desde 2019: mesma regra em janeiro.
  assert.equal(dateInTimeZone(new Date('2027-01-15T02:30:00Z'), 'America/Sao_Paulo'), '2027-01-14');
});

test('presets com hoje = 25/11/2026 (nunca incluem hoje)', () => {
  const t = '2026-11-25';
  assert.deepEqual(presetRange('yesterday', t), { since: '2026-11-24', until: '2026-11-24', empty: false, includesToday: false });
  assert.deepEqual(presetRange('last_7_complete', t), { since: '2026-11-18', until: '2026-11-24', empty: false, includesToday: false });
  assert.deepEqual(presetRange('month_to_yesterday', t), { since: '2026-11-01', until: '2026-11-24', empty: false, includesToday: false });
  assert.deepEqual(presetRange('previous_month', t), { since: '2026-10-01', until: '2026-10-31', empty: false, includesToday: false });
  assert.equal(eachDay('2026-11-18', '2026-11-24').length, 7);
});

test('limites de mês/ano e ano bissexto', () => {
  const dec1 = presetRange('month_to_yesterday', '2026-12-01');
  assert.equal(dec1.empty, true, 'dia 1: mês até ontem não tem dias completos');
  assert.equal(dec1.reason, 'primeiro_dia_do_mes');
  assert.deepEqual(presetRange('previous_month', '2026-12-01'), { since: '2026-11-01', until: '2026-11-30', empty: false, includesToday: false });
  assert.deepEqual(presetRange('previous_month', '2027-01-01'), { since: '2026-12-01', until: '2026-12-31', empty: false, includesToday: false });
  assert.deepEqual(presetRange('last_7_complete', '2027-01-03'), { since: '2026-12-27', until: '2027-01-02', empty: false, includesToday: false });
  assert.deepEqual(presetRange('previous_month', '2028-03-10'), { since: '2028-02-01', until: '2028-02-29', empty: false, includesToday: false });
});

test('personalizado: inverte datas, limita futuro a hoje e marca hoje como parcial', () => {
  const r = presetRange('custom', '2026-11-25', { since: '2026-11-30', until: '2026-11-20' });
  assert.equal(r.since, '2026-11-20');
  assert.equal(r.until, '2026-11-25');
  assert.equal(r.includesToday, true);
  assert.equal(r.clampedFuture, true);
  const past = presetRange('custom', '2026-11-25', { since: '2026-11-01', until: '2026-11-10' });
  assert.equal(past.includesToday, false);
  assert.equal(presetRange('custom', '2026-11-25', { since: 'x', until: '2026-11-10' }).empty, true);
  assert.equal(presetRange('custom', '2026-11-25', { since: '2026-12-01', until: '2026-12-02' }).empty, true);
});

test('janelas controladas cobrem o intervalo sem buracos nem sobreposição', () => {
  const w = splitWindows('2026-11-01', '2026-11-25', 7);
  assert.deepEqual(w.map((x) => `${x.since}..${x.until}`), ['2026-11-01..2026-11-07', '2026-11-08..2026-11-14', '2026-11-15..2026-11-21', '2026-11-22..2026-11-25']);
  const days = w.flatMap((x) => eachDay(x.since, x.until));
  assert.deepEqual(days, eachDay('2026-11-01', '2026-11-25'));
  assert.throws(() => splitWindows('2026-11-01', '2026-11-02', 0));
});

test('formatação DD/MM/AAAA e validação de datas', () => {
  assert.equal(formatDateBR('2026-11-05'), '05/11/2026');
  assert.equal(formatDateTimeBR('2026-11-26T02:30:00Z'), '25/11/2026 23:30');
  assert.equal(isIsoDate('2026-02-29'), false);
  assert.equal(isIsoDate('2028-02-29'), true);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
