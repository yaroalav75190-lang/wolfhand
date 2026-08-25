// Upstash Redis client (HTTP-based, serverless-friendly).
// Env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//
// Импорт `@upstash/redis` — ЛЕНИВЫЙ (внутри функции). Без KV_DRIVER=redis пакет
// не загружается, поэтому он может отсутствовать в node_modules (optionalDependencies).

let _redis = null;

export async function redis() {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Redis env vars not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)');
  }
  const { Redis } = await import('@upstash/redis');
  _redis = new Redis({ url, token });
  return _redis;
}

// Префиксы ключей — для удобной очистки и инспекции
export const KEY = {
  session: (id) => `session:${id}`,
  code:    (code) => `code:${code}`,
  daily:   (date) => `stats:daily:${date}`, // hash: spins, wins, jackpots, payouts
  prize:   (date, prizeId) => `stats:prize:${date}:${prizeId}`, // counter
  rate:    (key) => `rate:${key}`, // для rate-limiting
  jackpot: 'meta:jackpot:last', // ISO timestamp последнего джекпота
};
