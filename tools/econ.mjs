// Экономика призового фонда: во что обходится одна раздача клубу и партнёрам.
// Считает аналитически по весам (без Монте-Карло — веса и так заданы явно),
// и отдельно прогоняет симуляцию как проверку движка.
//
// Запуск:  node tools/econ.mjs [число раздач в месяц]

import { PRIZES, WEIGHT_TIERS, PAYOUT_TABLE, prizeForCombo, CONFIG } from '../api/_lib/prizes.js';
import { COMBO_NAMES } from '../api/_lib/cards.js';
import { dealHand } from '../api/_lib/deal.js';

const MONTHLY_DEALS = Number(process.argv[2]) || 2000;
const rub = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const pct = (n) => `${n.toFixed(2)}%`;

console.log('═'.repeat(78));
console.log('ЭКОНОМИКА АКЦИИ «РУКА ВОЛКА»');
console.log('═'.repeat(78));

// ─── Таблица выплат ──────────────────────────────────────────────────────────
console.log('\nТАБЛИЦА ВЫПЛАТ И ВЕРОЯТНОСТИ ПО ТИРАМ\n');
console.log(
  'Комбинация'.padEnd(22) + 'Приз'.padEnd(30) +
  'база'.padStart(8) + 'маршрут'.padStart(9) + 'волк'.padStart(8),
);
console.log('─'.repeat(78));

for (const { combo } of PAYOUT_TABLE) {
  const prizeId = prizeForCombo(combo);
  const prize = prizeId ? PRIZES[prizeId] : null;
  console.log(
    COMBO_NAMES[combo].padEnd(22) +
    (prize ? prize.name : '— сертификат партнёра').slice(0, 29).padEnd(30) +
    pct(WEIGHT_TIERS.base[combo]).padStart(8) +
    pct(WEIGHT_TIERS.boosted[combo]).padStart(9) +
    pct(WEIGHT_TIERS.wolf[combo]).padStart(8),
  );
}

// ─── Стоимость раздачи по тирам ──────────────────────────────────────────────
// Доля клубного сертификата в ротации не задана константой — она следует из логики
// pickPartnerCert, поэтому измеряем её симуляцией, а не «прикидываем на глаз».
function measureClubCertShare(samples = 20000) {
  let club = 0;
  for (let i = 0; i < samples; i++) {
    const r = dealHand({ tier: 'base', sourcePartnerId: null, collectedPartnerIds: [] });
    if (r.certPrizeId === 'cert_optimist') club++;
  }
  return club / samples;
}
const CLUB_CERT_SHARE = measureClubCertShare();

function tierEconomics(tier) {
  const w = WEIGHT_TIERS[tier];
  let clubCogs = 0;
  let winRate = 0;
  let taxableRate = 0;

  for (const combo of Object.keys(w)) {
    const p = w[combo] / 100;
    const prizeId = prizeForCombo(combo);
    if (!prizeId) continue;
    const prize = PRIZES[prizeId];
    winRate += p;
    clubCogs += p * (prize.cogs || 0);
    if (prize.taxable) taxableRate += p;
  }
  clubCogs += CLUB_CERT_SHARE * (PRIZES.cert_optimist.cogs || 0);

  return { clubCogs, winRate, taxableRate };
}

console.log('\n\nСТОИМОСТЬ ОДНОЙ РАЗДАЧИ ДЛЯ КЛУБА\n');
console.log('Тир'.padEnd(26) + 'выигрыш'.padStart(10) + 'клубу'.padStart(11) + 'НДФЛ-призы'.padStart(13));
console.log('─'.repeat(78));

const tiers = [
  ['base', 'База (1–2 карты)'],
  ['boosted', 'Маршрут (3–4 карты)'],
  ['wolf', 'Рука волка (все 4)'],
];
const econ = {};
for (const [tier, label] of tiers) {
  const e = tierEconomics(tier);
  econ[tier] = e;
  console.log(
    label.padEnd(26) +
    pct(e.winRate * 100).padStart(10) +
    rub(e.clubCogs).padStart(11) +
    pct(e.taxableRate * 100).padStart(13),
  );
}
console.log(`\nКлубный сертификат выпадает в ${pct(CLUB_CERT_SHARE * 100)} раздач — остальные ведут к партнёрам.`);

// ─── Месячный прогноз ────────────────────────────────────────────────────────
// Большинство играет на базовом тире, полный маршрут проходят единицы.
const MIX = { base: 0.75, boosted: 0.22, wolf: 0.03 };

let monthClub = 0;
let monthWins = 0;
for (const [tier, share] of Object.entries(MIX)) {
  const deals = MONTHLY_DEALS * share;
  monthClub += deals * econ[tier].clubCogs;
  monthWins += deals * econ[tier].winRate;
}

// Партнёрский фонд ограничен ТИРАЖОМ: сколько призов реально положили, столько
// и разыграется. Считаем и ожидание по весам, и упор в остаток.
console.log('\n\nПАРТНЁРСКИЙ ФОНД: СПРОС ПРОТИВ ТИРАЖА\n');
console.log('Приз'.padEnd(34) + 'тираж'.padStart(7) + 'ожидание'.padStart(10) + 'хватит на'.padStart(12) + 'розница'.padStart(12));
console.log('─'.repeat(78));

let partnerRetailCapped = 0;
let soonestDays = Infinity;
for (const { combo } of PAYOUT_TABLE) {
  const prizeId = prizeForCombo(combo);
  const prize = prizeId ? PRIZES[prizeId] : null;
  if (!prize || !Number.isFinite(prize.stock)) continue;

  let expected = 0;
  for (const [tier, share] of Object.entries(MIX)) {
    expected += MONTHLY_DEALS * share * (WEIGHT_TIERS[tier][combo] / 100);
  }
  const issued = Math.min(expected, prize.stock);
  partnerRetailCapped += issued * (prize.retail || 0);

  const days = expected > 0 ? (prize.stock / expected) * 30 : Infinity;
  soonestDays = Math.min(soonestDays, days);

  console.log(
    prize.name.slice(0, 33).padEnd(34) +
    String(prize.stock).padStart(7) +
    expected.toFixed(1).padStart(10) +
    (days >= 30 ? 'месяц+' : `${Math.round(days)} дн.`).padStart(12) +
    rub(issued * (prize.retail || 0)).padStart(12),
  );
}

console.log('\n\nПРОГНОЗ НА МЕСЯЦ\n');
console.log(`Раздач в месяц:                 ${MONTHLY_DEALS.toLocaleString('ru-RU')}`);
console.log(`Распределение по тирам:         база ${MIX.base * 100}% · маршрут ${MIX.boosted * 100}% · волк ${MIX.wolf * 100}%`);
console.log(`Раздач с материальным призом:   ${Math.round(monthWins).toLocaleString('ru-RU')} (${pct(monthWins / MONTHLY_DEALS * 100)})`);
console.log(`Прямые затраты КЛУБА:           ${rub(monthClub)}  (${rub(monthClub / MONTHLY_DEALS)} на раздачу)`);
console.log(`Розница фонда ПАРТНЁРОВ:        ${rub(partnerRetailCapped)} (ограничено тиражом)`);
console.log(`Сертификатов выдано:            ${MONTHLY_DEALS.toLocaleString('ru-RU')} — по одному на каждую раздачу`);
if (soonestDays < 30) {
  console.log(`\n⚠ Первый приз закончится примерно через ${Math.round(soonestDays)} дн. — после этого`);
  console.log('  его комбинация автоматически выпадает из розыгрыша (stock-guard).');
  console.log('  Либо пополнить фонд, либо снизить вес этого исхода в prizes.js.');
}

// ─── Проверка движка симуляцией ──────────────────────────────────────────────
const N = 60000;
console.log(`\n\nПРОВЕРКА ДВИЖКА: ${N.toLocaleString('ru-RU')} раздач на базовом тире\n`);
const counts = {};
for (let i = 0; i < N; i++) {
  const r = dealHand({ tier: 'base', sourcePartnerId: 'helloapple', collectedPartnerIds: ['helloapple'] });
  counts[r.combo] = (counts[r.combo] || 0) + 1;
}
console.log('Комбинация'.padEnd(22) + 'ожидание'.padStart(10) + 'факт'.padStart(10) + 'отклонение'.padStart(12));
console.log('─'.repeat(78));
let maxDrift = 0;
for (const { combo } of PAYOUT_TABLE) {
  const expected = WEIGHT_TIERS.base[combo];
  const actual = (counts[combo] || 0) / N * 100;
  const drift = actual - expected;
  maxDrift = Math.max(maxDrift, Math.abs(drift) / Math.max(expected, 0.05));
  console.log(
    COMBO_NAMES[combo].padEnd(22) +
    pct(expected).padStart(10) +
    pct(actual).padStart(10) +
    `${drift >= 0 ? '+' : ''}${drift.toFixed(2)}`.padStart(12),
  );
}
console.log('─'.repeat(78));
console.log(maxDrift < 0.35
  ? '✓ Распределение соответствует весам (в пределах статистической погрешности)'
  : `⚠ Отклонение ${(maxDrift * 100).toFixed(0)}% — проверьте движок раздачи`);
console.log('═'.repeat(78));
