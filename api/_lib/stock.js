// Контроль тиража призов и защит фонда.
//
// Зачем отдельно от бюджет-гарда: партнёрские призы клубу ничего не стоят (cogs = 0),
// поэтому денежный потолок их не удержит — Apple Watch физически один, и после выдачи
// исход «флеш-рояль» обязан исчезнуть из розыгрыша.

import { kv, KEY } from './kv.js';
import { PRIZES, PRIZE_BUDGET, JACKPOT_LIMIT } from './prizes.js';

const TODAY = () => new Date().toISOString().slice(0, 10);

/** Сколько штук каждого приза выдано за всю акцию. */
export async function issuedTotals() {
  return (await kv.hgetall(KEY.issuedTotal)) || {};
}

/** Призы, чей тираж исчерпан. Такие исходы исключаются из розыгрыша. */
export async function soldOutPrizeIds() {
  const totals = await issuedTotals();
  return Object.values(PRIZES)
    .filter((p) => Number.isFinite(p.stock) && (Number(totals[p.id]) || 0) >= p.stock)
    .map((p) => p.id);
}

/** Остатки по призам с ограниченным тиражом — для витрины маркетолога. */
export async function stockReport() {
  const totals = await issuedTotals();
  return Object.values(PRIZES)
    .filter((p) => Number.isFinite(p.stock))
    .map((p) => {
      const issued = Number(totals[p.id]) || 0;
      return { id: p.id, name: p.name, stock: p.stock, issued, left: Math.max(0, p.stock - issued) };
    });
}

/** Исчерпан ли дневной бюджет клуба на призы. */
export async function isBudgetCapped() {
  if (PRIZE_BUDGET.DAILY_COGS_CAP <= 0) return false;
  try {
    const daily = (await kv.hgetall(KEY.daily(TODAY()))) || {};
    return (Number(daily.payoutsCogs) || 0) >= PRIZE_BUDGET.DAILY_COGS_CAP;
  } catch {
    return false; // сбой чтения статистики не должен останавливать акцию
  }
}

/** Находится ли джекпот в «окне тишины» после предыдущего выпадения. */
export async function isJackpotCapped() {
  if (JACKPOT_LIMIT.MIN_INTERVAL_DAYS <= 0) return false;
  try {
    const lastAt = await kv.get(KEY.jackpot);
    const last = lastAt ? Date.parse(lastAt) : NaN;
    if (!Number.isFinite(last)) return false;
    return (Date.now() - last) < JACKPOT_LIMIT.MIN_INTERVAL_DAYS * 86400000;
  } catch {
    return false;
  }
}

/** Собрать все ограничители одним вызовом — используется перед раздачей. */
export async function guards() {
  const [soldOut, budget, jackpot] = await Promise.all([
    soldOutPrizeIds(), isBudgetCapped(), isJackpotCapped(),
  ]);
  return { soldOutPrizeIds: soldOut, suppressExpensive: budget, suppressJackpot: jackpot };
}

/** Учесть выданный приз: дневной расход, дневной и общий тираж. Best-effort. */
export async function registerIssued(prizeId, { date = TODAY() } = {}) {
  if (!prizeId || !PRIZES[prizeId]) return;
  const cogs = PRIZES[prizeId].cogs || 0;
  await kv.hincrby(KEY.issuedDay(date), prizeId, 1);
  await kv.hincrby(KEY.issuedTotal, prizeId, 1);
  if (cogs > 0) await kv.hincrby(KEY.daily(date), 'payoutsCogs', cogs);
}
