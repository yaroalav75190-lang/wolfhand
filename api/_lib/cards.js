// Колода, оценка покерной руки и КОНСТРУИРОВАНИЕ руки под заданную комбинацию.
//
// Принцип честности:
//   сервер сначала разыгрывает ИСХОД по весам (crypto.randomInt, см. deal.js),
//   и только потом собирает 5 карт, которые дают ровно этот исход.
//   Клиент получает готовые карты и лишь проигрывает анимацию — подменить нечего.
//
// Почему не «честная колода»: реальные вероятности покера не совпадают с призовой
// экономикой (флеш-рояль ~1/650 000 на 5 карт, пара ~42%). Нам нужен управляемый
// призовой фонд, поэтому распределение задаётся весами в prizes.js, а cards.js
// отвечает только за то, чтобы выданные карты честно соответствовали объявленной руке.

import { randomInt } from 'node:crypto';

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['s', 'h', 'd', 'c']; // spades, hearts, diamonds, clubs

/** Числовое значение ранга: 2..14 (туз старший). */
export const rankValue = (r) => RANKS.indexOf(r) + 2;

/** Карта — {r, s}. Публичный код для клиента — 'As', 'Td', '7c'. */
export const cardCode = (c) => `${c.r}${c.s}`;

// ─── Комбинации ──────────────────────────────────────────────────────────────
// Порядок важен: используется для сравнения «что старше».
export const COMBOS = {
  ROYAL_FLUSH:     'royal_flush',
  STRAIGHT_FLUSH:  'straight_flush',
  FOUR_OF_A_KIND:  'four_of_a_kind',
  FULL_HOUSE:      'full_house',
  FLUSH:           'flush',
  STRAIGHT:        'straight',
  THREE_OF_A_KIND: 'three_of_a_kind',
  TWO_PAIR:        'two_pair',
  PAIR_HIGH:       'pair_high',  // пара валетов и старше (J/Q/K/A) — «Jacks or Better»
  PAIR_LOW:        'pair_low',   // пара двоек…десяток
  BAD_BEAT:        'bad_beat',   // 7-2 разномастные — «худшая рука в покере», у нас призовая
  HIGH_CARD:       'high_card',  // ничего
};

/** Ранг силы комбинации (больше = сильнее). BAD_BEAT приравнен к мусору по силе. */
export const COMBO_STRENGTH = {
  [COMBOS.ROYAL_FLUSH]: 10,
  [COMBOS.STRAIGHT_FLUSH]: 9,
  [COMBOS.FOUR_OF_A_KIND]: 8,
  [COMBOS.FULL_HOUSE]: 7,
  [COMBOS.FLUSH]: 6,
  [COMBOS.STRAIGHT]: 5,
  [COMBOS.THREE_OF_A_KIND]: 4,
  [COMBOS.TWO_PAIR]: 3,
  [COMBOS.PAIR_HIGH]: 2,
  [COMBOS.PAIR_LOW]: 1,
  [COMBOS.BAD_BEAT]: 0,
  [COMBOS.HIGH_CARD]: 0,
};

/** Человеческие названия — используются в UI и в коде приза для сотрудника. */
export const COMBO_NAMES = {
  [COMBOS.ROYAL_FLUSH]: 'Флеш-рояль',
  [COMBOS.STRAIGHT_FLUSH]: 'Стрит-флеш',
  [COMBOS.FOUR_OF_A_KIND]: 'Каре',
  [COMBOS.FULL_HOUSE]: 'Фулл-хаус',
  [COMBOS.FLUSH]: 'Флеш',
  [COMBOS.STRAIGHT]: 'Стрит',
  [COMBOS.THREE_OF_A_KIND]: 'Сет',
  [COMBOS.TWO_PAIR]: 'Две пары',
  [COMBOS.PAIR_HIGH]: 'Пара валетов и выше',
  [COMBOS.PAIR_LOW]: 'Пара',
  [COMBOS.BAD_BEAT]: 'Бэд-бит 7-2',
  [COMBOS.HIGH_CARD]: 'Старшая карта',
};

// ─── Случайность ─────────────────────────────────────────────────────────────

export function pickRandom(arr) {
  return arr[randomInt(0, arr.length)];
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Полная колода из 52 карт. */
export function fullDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push({ r, s });
  return deck;
}

// ─── Оценка руки ─────────────────────────────────────────────────────────────

function rankCounts(cards) {
  const counts = new Map();
  for (const c of cards) counts.set(c.r, (counts.get(c.r) || 0) + 1);
  return counts;
}

function isFlush(cards) {
  return cards.every((c) => c.s === cards[0].s);
}

/**
 * Стрит: 5 подряд идущих рангов. Учитывается «колесо» A-2-3-4-5.
 * @returns {number|null} старшая карта стрита (для колеса — 5), либо null.
 */
function straightHigh(cards) {
  const vals = [...new Set(cards.map((c) => rankValue(c.r)))].sort((a, b) => a - b);
  if (vals.length !== 5) return null;
  if (vals[4] - vals[0] === 4) return vals[4];
  // «Колесо»: A,2,3,4,5 → значения 2,3,4,5,14
  if (vals.join(',') === '2,3,4,5,14') return 5;
  return null;
}

/** Есть ли 7 и 2 разных мастей (сигнатура бэд-бита). */
function hasSevenDeuceOffsuit(cards) {
  const sevens = cards.filter((c) => c.r === '7');
  const deuces = cards.filter((c) => c.r === '2');
  if (!sevens.length || !deuces.length) return false;
  return sevens.some((a) => deuces.some((b) => a.s !== b.s));
}

/**
 * Определить комбинацию из ровно 5 карт.
 * @returns {{combo: string, name: string, strength: number, keyRanks: string[]}}
 */
export function evaluateHand(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) {
    throw new Error('evaluateHand: нужно ровно 5 карт');
  }
  const flush = isFlush(cards);
  const sHigh = straightHigh(cards);
  const counts = rankCounts(cards);
  // Ранги по убыванию: сначала по количеству, затем по старшинству.
  const byCount = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (rankValue(b[0]) - rankValue(a[0])));
  const shape = byCount.map(([, n]) => n).join('');

  let combo;
  if (flush && sHigh === 14) combo = COMBOS.ROYAL_FLUSH;
  else if (flush && sHigh) combo = COMBOS.STRAIGHT_FLUSH;
  else if (shape === '41') combo = COMBOS.FOUR_OF_A_KIND;
  else if (shape === '32') combo = COMBOS.FULL_HOUSE;
  else if (flush) combo = COMBOS.FLUSH;
  else if (sHigh) combo = COMBOS.STRAIGHT;
  else if (shape === '311') combo = COMBOS.THREE_OF_A_KIND;
  else if (shape === '221') combo = COMBOS.TWO_PAIR;
  else if (shape === '2111') {
    combo = rankValue(byCount[0][0]) >= 11 ? COMBOS.PAIR_HIGH : COMBOS.PAIR_LOW;
  } else {
    combo = hasSevenDeuceOffsuit(cards) ? COMBOS.BAD_BEAT : COMBOS.HIGH_CARD;
  }

  return {
    combo,
    name: COMBO_NAMES[combo],
    strength: COMBO_STRENGTH[combo],
    keyRanks: byCount.filter(([, n]) => n > 1).map(([r]) => r),
  };
}

/**
 * Индексы карт, которые образуют комбинацию (для подсветки в UI).
 * Для флеша/стрита/рояля — все пять.
 */
export function winningIndexes(cards, combo) {
  const all = [0, 1, 2, 3, 4];
  if ([COMBOS.ROYAL_FLUSH, COMBOS.STRAIGHT_FLUSH, COMBOS.FLUSH, COMBOS.STRAIGHT, COMBOS.FULL_HOUSE].includes(combo)) {
    return all;
  }
  if (combo === COMBOS.BAD_BEAT) {
    const seven = cards.findIndex((c) => c.r === '7');
    const deuce = cards.findIndex((c) => c.r === '2');
    return [seven, deuce].filter((i) => i >= 0);
  }
  const counts = rankCounts(cards);
  const paired = [...counts.entries()].filter(([, n]) => n > 1).map(([r]) => r);
  if (!paired.length) return [];
  return all.filter((i) => paired.includes(cards[i].r));
}

// ─── Конструирование руки под заданную комбинацию ────────────────────────────

const STRAIGHT_HIGHS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 5 = «колесо» A2345

function valueToRank(v) {
  return RANKS[v - 2];
}

/** Ранги стрита по старшей карте (5 → A,2,3,4,5). */
function straightRanks(high) {
  if (high === 5) return ['A', '2', '3', '4', '5'];
  const out = [];
  for (let v = high - 4; v <= high; v++) out.push(valueToRank(v));
  return out;
}

/** n различных случайных рангов, исключая exclude. */
function distinctRanks(n, exclude = []) {
  const pool = RANKS.filter((r) => !exclude.includes(r));
  return shuffle(pool).slice(0, n);
}

/** Собрать «сырой» набор карт под комбинацию. Результат проверяется вызывающим. */
function draft(combo) {
  switch (combo) {
    case COMBOS.ROYAL_FLUSH: {
      const s = pickRandom(SUITS);
      return ['T', 'J', 'Q', 'K', 'A'].map((r) => ({ r, s }));
    }
    case COMBOS.STRAIGHT_FLUSH: {
      const s = pickRandom(SUITS);
      // Исключаем 14 (это уже флеш-рояль)
      const high = pickRandom(STRAIGHT_HIGHS.filter((h) => h !== 14));
      return straightRanks(high).map((r) => ({ r, s }));
    }
    case COMBOS.FOUR_OF_A_KIND: {
      const [quad, kicker] = distinctRanks(2);
      return [...SUITS.map((s) => ({ r: quad, s })), { r: kicker, s: pickRandom(SUITS) }];
    }
    case COMBOS.FULL_HOUSE: {
      const [trips, pair] = distinctRanks(2);
      const tSuits = shuffle(SUITS).slice(0, 3);
      const pSuits = shuffle(SUITS).slice(0, 2);
      return [...tSuits.map((s) => ({ r: trips, s })), ...pSuits.map((s) => ({ r: pair, s }))];
    }
    case COMBOS.FLUSH: {
      const s = pickRandom(SUITS);
      return distinctRanks(5).map((r) => ({ r, s })); // проверка отсеет случайный стрит-флеш
    }
    case COMBOS.STRAIGHT: {
      const high = pickRandom(STRAIGHT_HIGHS);
      // Раздаём масти так, чтобы гарантированно не собрался флеш
      const ranks = straightRanks(high);
      const suits = shuffle(SUITS);
      return ranks.map((r, i) => ({ r, s: suits[i % 3] })); // максимум 3 масти → флеша не будет
    }
    case COMBOS.THREE_OF_A_KIND: {
      const [trips, k1, k2] = distinctRanks(3);
      const tSuits = shuffle(SUITS).slice(0, 3);
      return [
        ...tSuits.map((s) => ({ r: trips, s })),
        { r: k1, s: pickRandom(SUITS) },
        { r: k2, s: pickRandom(SUITS) },
      ];
    }
    case COMBOS.TWO_PAIR: {
      const [p1, p2, kicker] = distinctRanks(3);
      return [
        ...shuffle(SUITS).slice(0, 2).map((s) => ({ r: p1, s })),
        ...shuffle(SUITS).slice(0, 2).map((s) => ({ r: p2, s })),
        { r: kicker, s: pickRandom(SUITS) },
      ];
    }
    case COMBOS.PAIR_HIGH:
    case COMBOS.PAIR_LOW: {
      const highRanks = ['J', 'Q', 'K', 'A'];
      const lowRanks = RANKS.filter((r) => !highRanks.includes(r));
      const pairRank = pickRandom(combo === COMBOS.PAIR_HIGH ? highRanks : lowRanks);
      const kickers = distinctRanks(3, [pairRank]);
      return [
        ...shuffle(SUITS).slice(0, 2).map((s) => ({ r: pairRank, s })),
        ...kickers.map((r) => ({ r, s: pickRandom(SUITS) })),
      ];
    }
    case COMBOS.BAD_BEAT: {
      // 7 и 2 разных мастей + три «пустых» кикера без пар
      const suits = shuffle(SUITS);
      const kickers = distinctRanks(3, ['7', '2']);
      return [
        { r: '7', s: suits[0] },
        { r: '2', s: suits[1] },
        ...kickers.map((r) => ({ r, s: pickRandom(SUITS) })),
      ];
    }
    case COMBOS.HIGH_CARD:
    default: {
      return distinctRanks(5).map((r) => ({ r, s: pickRandom(SUITS) }));
    }
  }
}

/** Нет ли одинаковых карт (одна колода — дубли недопустимы). */
function isValidSet(cards) {
  return new Set(cards.map(cardCode)).size === 5;
}

/**
 * Собрать 5 карт, дающих РОВНО указанную комбинацию.
 * Rejection sampling: черновик → проверка evaluateHand → повтор при несовпадении.
 * Это защищает от «случайно получился стрит-флеш вместо флеша» — рука никогда
 * не окажется сильнее (или слабее) объявленного исхода.
 *
 * @param {string} combo одна из COMBOS
 * @returns {{cards: Array<{r:string,s:string}>, combo: string}}
 */
export function buildHandFor(combo) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const cards = draft(combo);
    if (!isValidSet(cards)) continue;
    if (evaluateHand(cards).combo === combo) return { cards: shuffle(cards), combo };
  }
  // Практически недостижимо: конструкторы детерминированы по форме.
  // Не выдаём «что получилось» — это исказило бы призовую статистику.
  throw new Error(`buildHandFor: не удалось собрать руку «${combo}» за 400 попыток`);
}

/** Публичное представление руки для клиента. */
export function publicHand(cards) {
  return cards.map((c) => ({ r: c.r, s: c.s, code: cardCode(c) }));
}
