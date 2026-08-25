// Серверный движок раздачи. Только crypto.randomInt — никакого Math.random.
//
// Порядок (важен для честности и для экономики фонда):
//   1. выбираем ИСХОД (комбинацию) по весам своего тира, с учётом ограничителей;
//   2. собираем 5 карт, которые дают ровно этот исход (cards.js);
//   3. подбираем сертификат партнёра — довесок, который получают все без исключения.
// Клиент получает готовые карты и не может повлиять на результат.

import { randomInt } from 'node:crypto';
import { buildHandFor, evaluateHand, winningIndexes, publicHand, COMBOS, COMBO_NAMES } from './cards.js';
import {
  PRIZES, PARTNERS, ROUTE_PARTNER_IDS, WEIGHT_TIERS, prizeForCombo,
  PRIZE_BUDGET, publicPrize,
} from './prizes.js';

/** Взвешенный выбор по объекту {ключ: вес}. Веса умножаются на 10 000 для целочисленной выборки. */
function pickWeighted(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (!entries.length) throw new Error('pickWeighted: пустой пул исходов');
  const SCALE = 10000;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let pick = randomInt(0, Math.round(total * SCALE));
  for (const [key, w] of entries) {
    pick -= Math.round(w * SCALE);
    if (pick < 0) return key;
  }
  return entries[entries.length - 1][0];
}

/**
 * Разыграть комбинацию с учётом ограничителей фонда.
 * Вес отключённого исхода не пропадает и не «дарится» джекпоту — pickWeighted
 * ренормализует сумму по оставшимся исходам.
 *
 * @param {object} opts
 * @param {'base'|'boosted'|'wolf'} opts.tier            тир вероятностей (по маршруту)
 * @param {boolean} opts.suppressExpensive               дневной бюджет клуба исчерпан
 * @param {boolean} opts.suppressJackpot                 джекпот в «окне тишины»
 * @param {string[]} opts.soldOutPrizeIds                призы, чей тираж кончился
 * @param {string|null} opts.forceCombo                  только при DEV_MODE=1
 */
export function pickCombo({
  tier = 'base',
  suppressExpensive = false,
  suppressJackpot = false,
  soldOutPrizeIds = [],
  forceCombo = null,
} = {}) {
  if (forceCombo && process.env.DEV_MODE === '1' && WEIGHT_TIERS[tier][forceCombo] !== undefined) {
    return forceCombo;
  }
  const weights = { ...WEIGHT_TIERS[tier] };

  for (const combo of Object.keys(weights)) {
    const prizeId = prizeForCombo(combo);
    if (!prizeId) continue; // исходы «только сертификат» не ограничиваем никогда

    // Тираж приза исчерпан — исход недоступен до пополнения фонда
    if (soldOutPrizeIds.includes(prizeId)) { weights[combo] = 0; continue; }

    if (suppressJackpot && prizeId === 'apple_watch') { weights[combo] = 0; continue; }

    if (suppressExpensive) {
      const cogs = PRIZES[prizeId]?.cogs || 0;
      if (cogs >= PRIZE_BUDGET.EXPENSIVE_COGS_THRESHOLD) weights[combo] = 0;
    }
  }

  // Страховка: если ограничители обнулили всё — остаются «сертификатные» исходы.
  if (Object.values(weights).every((w) => w <= 0)) {
    weights[COMBOS.HIGH_CARD] = 1;
  }
  return pickWeighted(weights);
}

/**
 * Какой сертификат партнёра выдать в довесок.
 *
 * Правило заказчика: покупатель партнёра, выигравший ЧУЖОЙ приз, обязательно
 * получает скидку в магазин «своего» партнёра. Во всех остальных случаях
 * работаем на кросс-трафик: сначала предлагаем партнёров, чьи карты маршрута
 * гость ещё не собрал, — так сертификат ведёт его к следующей точке цепочки.
 *
 * @param {object} opts
 * @param {string|null} opts.wonPrizeId         выигранный приз (может быть null)
 * @param {string|null} opts.sourcePartnerId    партнёр, по QR которого пришёл гость
 * @param {string[]} opts.collectedPartnerIds   уже собранные карты маршрута
 */
export function pickPartnerCert({ wonPrizeId = null, sourcePartnerId = null, collectedPartnerIds = [] } = {}) {
  const wonProvider = wonPrizeId ? PRIZES[wonPrizeId]?.provider : null;

  // 1. Пришёл от партнёра и выиграл не его приз → сертификат «своего» магазина.
  if (sourcePartnerId && PARTNERS[sourcePartnerId]?.kind === 'partner' && wonProvider !== sourcePartnerId) {
    return PARTNERS[sourcePartnerId].certPrizeId;
  }

  // 2. Иначе — тянем к недостающим точкам маршрута.
  const notCollected = ROUTE_PARTNER_IDS.filter(
    (id) => !collectedPartnerIds.includes(id) && id !== wonProvider,
  );
  const pool = notCollected.length
    ? notCollected
    : ROUTE_PARTNER_IDS.filter((id) => id !== wonProvider);

  if (!pool.length) return PARTNERS.optimist.certPrizeId;
  return PARTNERS[pool[randomInt(0, pool.length)]].certPrizeId;
}

/**
 * Полная раздача.
 * @returns {{
 *   combo: string, comboName: string, cards: object[], highlight: number[],
 *   prizeId: string|null, certPrizeId: string, tier: string, isJackpot: boolean
 * }}
 */
export function dealHand(opts = {}) {
  const tier = opts.tier || 'base';
  const combo = pickCombo(opts);
  const { cards } = buildHandFor(combo);

  // Контрольная проверка: карты обязаны соответствовать разыгранному исходу.
  const check = evaluateHand(cards);
  if (check.combo !== combo) {
    throw new Error(`dealHand: рука не соответствует исходу (${combo} ≠ ${check.combo})`);
  }

  const prizeId = prizeForCombo(combo);
  const certPrizeId = pickPartnerCert({
    wonPrizeId: prizeId,
    sourcePartnerId: opts.sourcePartnerId,
    collectedPartnerIds: opts.collectedPartnerIds,
  });

  return {
    combo,
    comboName: COMBO_NAMES[combo],
    cards,
    highlight: winningIndexes(cards, combo),
    prizeId,
    certPrizeId,
    tier,
    isJackpot: prizeId === 'apple_watch',
  };
}

/** Ответ клиенту: карты + названия, без весов и себестоимости. */
export function publicDeal(result) {
  return {
    combo: result.combo,
    comboName: result.comboName,
    cards: publicHand(result.cards),
    highlight: result.highlight,
    prize: result.prizeId ? publicPrize(result.prizeId) : null,
    cert: publicPrize(result.certPrizeId),
    tier: result.tier,
    isJackpot: result.isJackpot,
  };
}
