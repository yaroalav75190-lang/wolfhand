// POST /api/scan
// Лендинг сообщает, что его открыли по QR партнёра. Это верхняя ступень воронки:
// без неё «конверсия из скана в регистрацию» посчитать нечем, а именно её партнёр
// спрашивает первой.
//
// Дедупликация — по анонимному идентификатору, который лендинг сам генерирует и хранит
// в localStorage. Это не персональные данные: случайная строка без привязки к человеку,
// живёт только в его браузере. По IP считать нельзя — в торговом центре весь Wi-Fi
// выходит через один адрес, и сканы схлопывались бы в единицы.

import { createHash } from 'node:crypto';
import { kv, KEY } from './_lib/kv.js';
import { applyCors, sendJson, sendError, readBody } from './_lib/auth.js';
import { clientIp } from './_lib/ratelimit.js';
import { ROUTE_PARTNER_IDS } from './_lib/prizes.js';

const TODAY = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const body = await readBody(req).catch(() => ({}));
    const partnerId = String(body.partnerId || '').trim();
    if (!ROUTE_PARTNER_IDS.includes(partnerId)) return sendJson(res, 204, {});

    const date = TODAY();
    // anonId от клиента, IP — резерв на случай отключённого localStorage.
    const anon = String(body.anonId || '').slice(0, 64) || `ip:${clientIp(req)}`;
    const fingerprint = createHash('sha256').update(`${anon}|${partnerId}|${date}`).digest('hex').slice(0, 24);
    const dedupeKey = KEY.rate(`scan:${fingerprint}`);

    const isNew = await kv.setNX(dedupeKey, 1, { ex: 12 * 3600 });
    if (isNew) {
      await kv.hincrby(KEY.partnerDay(date, partnerId), 'scans', 1);
      await kv.hincrby(KEY.daily(date), 'scans', 1);
    }

    return sendJson(res, 204, {});
  } catch (err) {
    return sendError(res, err);
  }
}
