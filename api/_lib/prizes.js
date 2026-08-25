// SSOT: призовой фонд, таблица выплат и вероятности. Используется ТОЛЬКО на сервере.
// Клиент никогда не получает веса и себестоимость — только результат своей раздачи.
//
// Структура акции «Рука волка»:
//   комбинация из 5 карт → приз по таблице выплат (одинаковой для всех),
//   плюс СЕРТИФИКАТ ПАРТНЁРА в довесок к любому исходу (условие заказчика:
//   «если выигрывает не ваш приз — вместе с чужим призом получает сертификат
//   со скидкой в ваш магазин»). Пустых рук не бывает.
//
// Что меняет «покерный маршрут»: не таблицу выплат, а ВЕРОЯТНОСТИ (тиры весов).
// Гость видит одну и ту же таблицу призов — растут только его шансы.

import { COMBOS } from './cards.js';

// ─── Конфиг акции ────────────────────────────────────────────────────────────
export const CONFIG = {
  /** Минимальный чек на кухню для гостя клуба (₽, после скидок). */
  MIN_CHECK_KITCHEN: 2500,
  /** Раздач на один QR. В покере рука одна — не размываем событие. */
  DEALS_PER_QR: 1,
  /** Сколько живёт игровая сессия. */
  SESSION_TTL_HOURS: 24,
  /** Сколько действует код приза до погашения у сотрудника. */
  CODE_TTL_DAYS: 14,
  /** Сколько живёт «пригласительный» партнёрский лид до визита в клуб. */
  INVITE_TTL_DAYS: 30,
  /** Возрастной порог участия. */
  ADULT_AGE_THRESHOLD: 18,
  /** Порог НДФЛ по п. 28 ст. 217 НК РФ: подарки дороже — облагаются 35%. */
  TAX_FREE_LIMIT: 4000,
};

// ─── Партнёры цепочки ────────────────────────────────────────────────────────
// slug используется в QR-ссылках: https://<домен>/?p=<slug>
// card — карта «покерного маршрута», которую партнёр выдаёт своим покупателям.
export const PARTNERS = {
  optimist: {
    id: 'optimist',
    name: 'Optimist Poker',
    short: 'Оптимист',
    kind: 'club',
    card: { r: 'A', s: 's' }, // туз пик — сам клуб
    color: '#CBBB6D',
    certPrizeId: 'cert_optimist',
  },
  helloapple: {
    id: 'helloapple',
    name: 'HELLO APPLE',
    short: 'Hello Apple',
    kind: 'partner',
    card: { r: 'K', s: 'h' },
    color: '#8FB8DE',
    certPrizeId: 'cert_helloapple',
  },
  levvel: {
    id: 'levvel',
    name: 'LEVVEL men',
    short: 'LEVVEL',
    kind: 'partner',
    card: { r: 'Q', s: 'd' },
    color: '#C08457',
    certPrizeId: 'cert_levvel',
  },
  chapaev: {
    id: 'chapaev',
    name: 'Чапаевские / Три богатыря',
    short: 'Чапаевские',
    kind: 'partner',
    card: { r: 'J', s: 'c' },
    color: '#A8904C',
    certPrizeId: 'cert_chapaev',
  },
  kontora: {
    id: 'kontora',
    name: 'Контора / Кузьма',
    short: 'Контора',
    kind: 'partner',
    card: { r: 'T', s: 's' },
    color: '#9E8FB2',
    certPrizeId: 'cert_kontora',
  },
};

export const PARTNER_IDS = Object.keys(PARTNERS);
/** Партнёры, чьи карты собираются в маршруте (клуб не считается — он и так конечная точка). */
export const ROUTE_PARTNER_IDS = PARTNER_IDS.filter((id) => PARTNERS[id].kind === 'partner');

// ─── Каталог призов ──────────────────────────────────────────────────────────
// retail — розничная стоимость (витрина + расчёт НДФЛ).
// cogs   — во сколько приз обходится КЛУБУ. Партнёрские призы = 0: их оплачивает партнёр,
//          но они всё равно участвуют в контроле остатков (stock).
// stock  — сколько штук в фонде на всю акцию. null = без ограничения.
// ⚠️ Значения ниже — рабочая заготовка. Финальный состав фонда согласуется с партнёрами
//    и юристом; правится только здесь, остальной код читает отсюда.
export const PRIZES = {
  // ── Джекпот ────────────────────────────────────────────────────────────────
  apple_watch: {
    id: 'apple_watch',
    name: 'Apple Watch',
    desc: 'Главный приз лототрона от HELLO APPLE',
    icon: '⌚',
    tier: 'jackpot',
    provider: 'helloapple',
    retail: 40000,
    cogs: 0,
    stock: 1,
    taxable: true,          // > 4 000 ₽ → НДФЛ 35% с превышения (п. 2 ст. 224 НК РФ)
    requiresPassport: true, // нужны паспорт и ИНН для справки о доходе
    deferredFulfillment: 'handover', // выдаётся отдельно, с актом
  },

  // ── Топ-призы ──────────────────────────────────────────────────────────────
  levvel_suit: {
    id: 'levvel_suit',
    name: 'Сертификат LEVVEL men — 15 000 ₽',
    desc: 'На костюм или образ целиком',
    icon: '🤵',
    tier: 'top',
    provider: 'levvel',
    retail: 15000,
    cogs: 0,
    stock: 2,
    taxable: true,
    requiresPassport: true,
    deferredFulfillment: 'certificate',
  },
  partner_big: {
    id: 'partner_big',
    name: 'Крупный приз партнёра',
    desc: 'Один из призов лототрона номиналом до 10 000 ₽',
    icon: '🎁',
    tier: 'top',
    provider: 'rotating',   // конкретный партнёр определяется при выдаче
    retail: 10000,
    cogs: 0,
    stock: 5,
    taxable: true,
    requiresPassport: true,
    deferredFulfillment: 'handover',
  },

  // ── Средние призы ──────────────────────────────────────────────────────────
  partner_mid: {
    id: 'partner_mid',
    name: 'Приз партнёра',
    desc: 'Товар или сертификат партнёра до 4 000 ₽',
    icon: '🎀',
    tier: 'big',
    provider: 'rotating',
    retail: 4000,
    cogs: 0,
    stock: 20,
    taxable: false,         // ровно на границе — НДФЛ не возникает
    deferredFulfillment: 'handover',
  },
  tournament_ticket: {
    id: 'tournament_ticket',
    name: 'Билет на Main Event',
    desc: 'Участие в турнире выходного дня',
    icon: '🎫',
    tier: 'big',
    provider: 'optimist',
    retail: 3000,
    cogs: 300,        // не 3 000: живых денег стоит только недополученный взнос
    stock: null,
    taxable: false,
  },
  club_cap: {
    id: 'club_cap',
    name: 'Фирменная кепка СРПЕ',
    desc: 'Та самая кепка клуба',
    icon: '🧢',
    tier: 'big',
    provider: 'optimist',
    retail: 2500,
    cogs: 700,
    stock: null,
    taxable: false,
  },

  // ── Малые призы ────────────────────────────────────────────────────────────
  chips_big: {
    id: 'chips_big',
    name: 'Двойной стек фишек',
    desc: 'Стартовый стек ×2 на ближайший турнир',
    icon: '🪙',
    tier: 'medium',
    provider: 'optimist',
    retail: 1500,
    cogs: 0,          // фишки — игровая валюта, себестоимости у неё нет
    stock: null,
    taxable: false,
  },
  bar_set: {
    id: 'bar_set',
    name: 'Комплимент от бара',
    desc: 'Сет напитков на стол',
    icon: '🥃',
    tier: 'medium',
    provider: 'optimist',
    retail: 1200,
    cogs: 320,
    stock: null,
    taxable: false,
    requires18plus: true,
  },
  chips_small: {
    id: 'chips_small',
    name: 'Дополнительные фишки',
    desc: '+50% к стартовому стеку',
    icon: '♠️',
    tier: 'small',
    provider: 'optimist',
    retail: 700,
    cogs: 0,          // то же самое: ценность для гостя есть, расхода у клуба нет
    stock: null,
    taxable: false,
  },

  // ── Сертификаты партнёров (довесок к любому исходу) ────────────────────────
  // Отдельный приз на каждого партнёра: гость должен понимать, куда идти.
  cert_helloapple: {
    id: 'cert_helloapple', name: 'Скидка в HELLO APPLE', desc: 'Персональный сертификат для гостей Optimist Poker',
    icon: '🍏', tier: 'cert', provider: 'helloapple', retail: 1000, cogs: 0, stock: null, taxable: false,
  },
  cert_levvel: {
    id: 'cert_levvel', name: 'Скидка в LEVVEL men', desc: 'Персональный сертификат для гостей Optimist Poker',
    icon: '👔', tier: 'cert', provider: 'levvel', retail: 1000, cogs: 0, stock: null, taxable: false,
  },
  cert_chapaev: {
    id: 'cert_chapaev', name: 'Скидка в «Чапаевских»', desc: 'Персональный сертификат для гостей Optimist Poker',
    icon: '🍺', tier: 'cert', provider: 'chapaev', retail: 1000, cogs: 0, stock: null, taxable: false,
  },
  cert_kontora: {
    id: 'cert_kontora', name: 'Скидка в «Конторе»', desc: 'Персональный сертификат для гостей Optimist Poker',
    icon: '🥩', tier: 'cert', provider: 'kontora', retail: 1000, cogs: 0, stock: null, taxable: false,
  },
  cert_optimist: {
    id: 'cert_optimist', name: 'Скидка в Optimist Poker', desc: 'Сертификат на кухню клуба',
    icon: '♣️', tier: 'cert', provider: 'optimist', retail: 1000, cogs: 350, stock: null, taxable: false,
  },
};

// ─── Таблица выплат: комбинация → приз ───────────────────────────────────────
// Одна для всех тиров. Гость видит её целиком до раздачи — это и есть «правила игры».
export const PAYOUT_TABLE = [
  { combo: COMBOS.ROYAL_FLUSH,     prizeId: 'apple_watch' },
  { combo: COMBOS.STRAIGHT_FLUSH,  prizeId: 'levvel_suit' },
  { combo: COMBOS.FOUR_OF_A_KIND,  prizeId: 'partner_big' },
  { combo: COMBOS.FULL_HOUSE,      prizeId: 'partner_mid' },
  { combo: COMBOS.FLUSH,           prizeId: 'tournament_ticket' },
  { combo: COMBOS.STRAIGHT,        prizeId: 'club_cap' },
  { combo: COMBOS.THREE_OF_A_KIND, prizeId: 'chips_big' },
  { combo: COMBOS.TWO_PAIR,        prizeId: 'bar_set' },
  { combo: COMBOS.PAIR_HIGH,       prizeId: 'chips_small' },
  { combo: COMBOS.BAD_BEAT,        prizeId: 'chips_small' }, // «худшая рука» тоже платит
  { combo: COMBOS.PAIR_LOW,        prizeId: null },          // только сертификат партнёра
  { combo: COMBOS.HIGH_CARD,       prizeId: null },          // только сертификат партнёра
];

export const prizeForCombo = (combo) =>
  PAYOUT_TABLE.find((row) => row.combo === combo)?.prizeId ?? null;

// ─── Вероятности: три тира «покерного маршрута» ──────────────────────────────
// Сумма весов в каждом тире = 100.
//   base    — обычная раздача (гость клуба по чеку либо 1–2 карты маршрута)
//   boosted — собрано 3–4 карты партнёров
//   wolf    — собраны все карты партнёров («Рука волка», разовая)
export const WEIGHT_TIERS = {
  base: {
    // Веса материальных призов партнёров выведены из ТИРАЖА фонда на ~2 500 раздач
    // в месяц: 1 Apple Watch, 2 сертификата LEVVEL, 5 крупных и 20 средних призов.
    // Поэтому 0.04% — это ровно один флеш-рояль за месяц, а не «красивое число».
    [COMBOS.ROYAL_FLUSH]: 0.04,
    [COMBOS.STRAIGHT_FLUSH]: 0.08,
    [COMBOS.FOUR_OF_A_KIND]: 0.20,
    [COMBOS.FULL_HOUSE]: 0.80,
    [COMBOS.FLUSH]: 1.80,
    [COMBOS.STRAIGHT]: 1.20,
    [COMBOS.THREE_OF_A_KIND]: 8.00,
    [COMBOS.TWO_PAIR]: 8.00,
    [COMBOS.PAIR_HIGH]: 16.00,
    [COMBOS.BAD_BEAT]: 3.00,
    [COMBOS.PAIR_LOW]: 20.00,
    [COMBOS.HIGH_CARD]: 40.88,
  },
  boosted: {
    [COMBOS.ROYAL_FLUSH]: 0.06,
    [COMBOS.STRAIGHT_FLUSH]: 0.12,
    [COMBOS.FOUR_OF_A_KIND]: 0.30,
    [COMBOS.FULL_HOUSE]: 1.20,
    [COMBOS.FLUSH]: 3.00,
    [COMBOS.STRAIGHT]: 2.00,
    [COMBOS.THREE_OF_A_KIND]: 12.00,
    [COMBOS.TWO_PAIR]: 11.00,
    [COMBOS.PAIR_HIGH]: 19.00,
    [COMBOS.BAD_BEAT]: 3.50,
    [COMBOS.PAIR_LOW]: 20.00,
    [COMBOS.HIGH_CARD]: 27.82,
  },
  wolf: {
    // Полный маршрут проходят единицы, поэтому здесь можно быть щедрым:
    // почти каждая рука что-то платит, а дорогие исходы всё равно упираются в тираж.
    [COMBOS.ROYAL_FLUSH]: 0.15,
    [COMBOS.STRAIGHT_FLUSH]: 0.35,
    [COMBOS.FOUR_OF_A_KIND]: 0.80,
    [COMBOS.FULL_HOUSE]: 2.50,
    [COMBOS.FLUSH]: 6.00,
    [COMBOS.STRAIGHT]: 4.00,
    [COMBOS.THREE_OF_A_KIND]: 18.00,
    [COMBOS.TWO_PAIR]: 16.00,
    [COMBOS.PAIR_HIGH]: 22.00,
    [COMBOS.BAD_BEAT]: 4.00,
    [COMBOS.PAIR_LOW]: 16.00,
    [COMBOS.HIGH_CARD]: 10.20,
  },
};

/** Тир по числу собранных карт партнёров. */
export function tierForRoute(routeCardsCount = 0) {
  const total = ROUTE_PARTNER_IDS.length;
  if (routeCardsCount >= total) return 'wolf';
  if (routeCardsCount >= 3) return 'boosted';
  return 'base';
}

// ─── Защита призового фонда ──────────────────────────────────────────────────

/** Джекпот не может выпасть чаще, чем раз в N суток (0 — выключить). */
export const JACKPOT_LIMIT = {
  MIN_INTERVAL_DAYS: Number.parseInt(process.env.JACKPOT_MIN_INTERVAL_DAYS ?? '30', 10) || 0,
};

/**
 * Мягкий бюджет-гард по затратам КЛУБА (₽/день). При достижении потолка дорогие
 * исходы временно исключаются: акция продолжает работать, но на дешёвых призах.
 * Партнёрские призы (cogs = 0) сюда не попадают — их ограничивает stock.
 */
export const PRIZE_BUDGET = {
  DAILY_COGS_CAP: Number.parseInt(process.env.PRIZE_BUDGET_DAILY_COGS ?? '5000', 10) || 0,
  EXPENSIVE_COGS_THRESHOLD: 300,
};

/** Призы с ограниченным тиражом — их выдачи считаются за всю акцию. */
export const LIMITED_PRIZE_IDS = Object.values(PRIZES)
  .filter((p) => Number.isFinite(p.stock))
  .map((p) => p.id);

/** Облагается ли приз НДФЛ (retail выше необлагаемого лимита). */
export function isTaxable(prizeId) {
  const p = PRIZES[prizeId];
  if (!p) return false;
  return p.taxable === true || (p.retail || 0) > CONFIG.TAX_FREE_LIMIT;
}

/** Сумма НДФЛ 35% с превышения над необлагаемым лимитом (для памятки победителю). */
export function taxAmount(prizeId) {
  const p = PRIZES[prizeId];
  if (!p || !isTaxable(prizeId)) return 0;
  return Math.round(((p.retail || 0) - CONFIG.TAX_FREE_LIMIT) * 0.35);
}

/** Публичная карточка приза — без себестоимости и остатков (коммерческая тайна). */
export function publicPrize(prizeId) {
  const p = PRIZES[prizeId];
  if (!p) return null;
  const { cogs, stock, ...pub } = p; // eslint-disable-line no-unused-vars
  pub.taxable = isTaxable(prizeId);
  if (pub.taxable) pub.taxHint = taxAmount(prizeId);
  return pub;
}

/** Публичная таблица выплат для лендинга (гость видит, что за что дают). */
export function publicPayoutTable() {
  return PAYOUT_TABLE.map(({ combo, prizeId }) => ({
    combo,
    prize: prizeId ? publicPrize(prizeId) : null,
  }));
}

// ─── Чек на кухню → право на раздачу ─────────────────────────────────────────

/** Сколько QR (раздач) полагается за чек: каждые MIN_CHECK_KITCHEN ₽ — одна. */
export function computeQRCount(check) {
  const c = Number(check) || 0;
  if (c < CONFIG.MIN_CHECK_KITCHEN) return 0;
  return Math.floor(c / CONFIG.MIN_CHECK_KITCHEN);
}
