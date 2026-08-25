// Rate-limiting.
//
// В рабочей конфигурации ограничение висит на nginx (`limit_req zone=api_rl`,
// см. deploy-scripts/nginx-wolfhand.conf): там оно дешевле — запрос отсекается
// до того, как дойдёт до Node. В коде остаётся no-op стаб.
//
// Опционально (KV_DRIVER=redis + UPSTASH_REDIS_REST_URL) включается лимитер
// на @upstash/ratelimit — на случай, если приложение переедет за чужой прокси.

import { redis as _redis } from './redis.js';

const useUpstash = process.env.KV_DRIVER === 'redis'
  && !!process.env.UPSTASH_REDIS_REST_URL;

const noopLimiter = { limit: async () => ({ success: true }) };

let _spinLimiter = null;
let _staffLimiter = null;
let _adminLimiter = null;

async function buildUpstashLimiter(limit, prefix) {
  // Динамический импорт — чтобы пакет не подгружался когда не нужен.
  const { Ratelimit } = await import('@upstash/ratelimit');
  return new Ratelimit({
    redis: await _redis(),
    limiter: Ratelimit.fixedWindow(limit, '60 s'),
    prefix,
  });
}

export function spinLimiter() {
  if (_spinLimiter) return _spinLimiter;
  if (!useUpstash) { _spinLimiter = noopLimiter; return _spinLimiter; }
  _spinLimiter = { limit: async (k) => (await buildUpstashLimiter(10, 'rl:spin')).limit(k) };
  return _spinLimiter;
}

/** Лимитер служебных операций стойки: выдача QR, подтверждение приглашений. */
export function staffLimiter() {
  if (_staffLimiter) return _staffLimiter;
  if (!useUpstash) { _staffLimiter = noopLimiter; return _staffLimiter; }
  _staffLimiter = { limit: async (k) => (await buildUpstashLimiter(60, 'rl:staff')).limit(k) };
  return _staffLimiter;
}

export function adminLimiter() {
  if (_adminLimiter) return _adminLimiter;
  if (!useUpstash) { _adminLimiter = noopLimiter; return _adminLimiter; }
  _adminLimiter = { limit: async (k) => (await buildUpstashLimiter(30, 'rl:admin')).limit(k) };
  return _adminLimiter;
}

export function clientIp(req) {
  const xfwd = req.headers?.['x-forwarded-for'];
  if (typeof xfwd === 'string' && xfwd.length) return xfwd.split(',')[0].trim();
  const real = req.headers?.['x-real-ip'];
  if (typeof real === 'string' && real.length) return real;
  return req.socket?.remoteAddress || 'unknown';
}
