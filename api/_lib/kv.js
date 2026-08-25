// Унифицированный KV-интерфейс. Драйвер выбирается через env KV_DRIVER:
//   "sqlite" — по умолчанию (VPS, файл data/wolfhand.sqlite)
//   "memory" — для локальной разработки и тестов
//
// API: get / set / setNX / del / incr / hgetall / hincrby / listKeys / listValues / count

const driverName = (process.env.KV_DRIVER || 'sqlite').toLowerCase();

const driver = await (async () => {
  if (driverName === 'memory') return await import('./memory.js');
  return await import('./sqlite.js');
})();

const P = (v) => Promise.resolve(v);
export const kv = {
  get:        (key)                   => P(driver.get(key)),
  set:        (key, value, opts)      => P(driver.set(key, value, opts)),
  setNX:      (key, value, opts)      => P(driver.setNX(key, value, opts)),
  del:        (key)                   => P(driver.del(key)),
  incr:       (key)                   => P(driver.incr(key)),
  hgetall:    (key)                   => P(driver.hgetall(key)),
  hincrby:    (key, field, n)         => P(driver.hincrby(key, field, n)),
  listKeys:   (prefix, limit, offset) => P(driver.listKeys?.(prefix, limit, offset) ?? []),
  listValues: (prefix, limit, offset) => P(driver.listValues?.(prefix, limit, offset) ?? []),
  count:      (prefix)                => P(driver.count?.(prefix) ?? 0),
};

export const KEY = {
  // ── Игровой контур ─────────────────────────────────────────────────────────
  session:     (id) => `session:${id}`,
  batch:       (id) => `batch:${id}`,            // пачка QR, выданная сотрудником по одному чеку
  code:        (code) => `code:${code}`,         // код приза, который гость показывает сотруднику

  // ── Партнёрский контур ─────────────────────────────────────────────────────
  invite:      (code) => `invite:${code}`,       // пригласительный от партнёра (до визита в клуб)
  guest:       (phone) => `guest:${phone}`,      // профиль гостя: маршрут, визиты, история. Без TTL

  // ── Статистика ─────────────────────────────────────────────────────────────
  daily:       (date) => `stats:daily:${date}`,               // hash: deals, wins, jackpots, payoutsCogs…
  combo:       (date, combo) => `stats:combo:${date}:${combo}`, // счётчик выпавших комбинаций
  partnerDay:  (date, partnerId) => `stats:partner:${date}:${partnerId}`, // hash: scans, signups, visits, deals, certs
  issuedDay:   (date) => `stats:issued:${date}`,              // hash {prizeId: шт} — выдано в кодах
  redeemedDay: (date) => `stats:redeemed:${date}`,            // hash {prizeId: шт} — погашено сотрудником
  issuedTotal: 'stats:issued:total',                          // hash {prizeId: шт} за всю акцию — контроль тиража

  // ── Служебное ──────────────────────────────────────────────────────────────
  fulfill:     (code, prizeId) => `fulfill:${code}:${prizeId}`, // очередь ручной выдачи (сертификаты), без TTL
  audit:       (createdAt, code) => `audit:${String(createdAt).padStart(13, '0')}:${code}`,
  jackpot:     'meta:jackpot:last',
  rate:        (key) => `rate:${key}`,
};

export const PREFIX = {
  session: 'session:',
  code:    'code:',
  invite:  'invite:',
  guest:   'guest:',
  audit:   'audit:',
  fulfill: 'fulfill:',
};
