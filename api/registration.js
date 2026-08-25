// POST /api/registration
// Регистрация гостя клубного контура (вход по чеку). Партнёрский контур сюда не заходит —
// там согласия уже собраны на точке партнёра.
//
// Побочный эффект, ради которого всё и затевалось: телефон связывает эту сессию
// с «покерным маршрутом» гостя. Если он уже брал карты у партнёров — тир вероятностей
// поднимается прямо здесь.

import { kv, KEY } from './_lib/kv.js';
import { applyCors, sendJson, sendError, readBody } from './_lib/auth.js';
import { spinLimiter, clientIp } from './_lib/ratelimit.js';
import { issueDeviceToken } from './_lib/device.js';
import { CONFIG } from './_lib/prizes.js';
import { normalizePhone, getGuest, upsertGuest, routeState, publicRoute } from './_lib/guests.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 64) {
      return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'нужен заголовок X-Session-Id' });
    }

    const { success } = await spinLimiter().limit(`reg:${clientIp(req)}`);
    if (!success) return sendJson(res, 429, { error: 'RATE_LIMITED' });

    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 80);
    const phone = normalizePhone(body.phone);

    if (name.length < 2) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'укажите имя' });
    if (!phone) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'некорректный номер телефона' });
    if (body.consentPd !== true) {
      return sendJson(res, 422, { error: 'CONSENT_REQUIRED', message: 'нужно согласие на обработку персональных данных' });
    }
    if (body.consentAge !== true) {
      return sendJson(res, 422, { error: 'AGE_CONSENT_REQUIRED', message: `участие с ${CONFIG.ADULT_AGE_THRESHOLD} лет` });
    }

    const session = await kv.get(KEY.session(sessionId));
    if (!session) return sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });
    if (session.finalized) return sendJson(res, 409, { error: 'ALREADY_FINALIZED', code: session.code });
    if (session.registered) return sendJson(res, 409, { error: 'ALREADY_REGISTERED' });

    const now = Date.now();
    const existing = await getGuest(phone);

    await upsertGuest(phone, {
      name: name || existing?.name || '',
      consent: {
        consentPd: true,
        consentAge: true,
        consentPartners: body.consentPartners === true,
        consentMarketing: body.consentMarketing === true,
        at: new Date(now).toISOString(),
        ip: clientIp(req),
        ua: String(req.headers['user-agent'] || '').slice(0, 256),
      },
      // Гость пришёл сам — источником считается клуб, но первое касание не перетираем.
      sourcePartnerId: existing?.sourcePartnerId || null,
    });

    const guest = await getGuest(phone);
    const route = routeState(guest);

    const { token: deviceToken, tokenHash } = issueDeviceToken();
    session.registered = true;
    session.phone = phone;
    session.guestName = name;
    session.device = { tokenHash, boundAt: now };
    session.tier = route.tier;         // маршрут поднимает шансы и в клубном контуре
    session.wolfHand = route.wolfAvailable;

    await kv.set(KEY.session(sessionId), session, { ex: CONFIG.SESSION_TTL_HOURS * 3600 });

    return sendJson(res, 200, {
      ok: true,
      deviceToken,
      dealsLeft: Math.max(0, session.maxDeals - session.dealsUsed),
      tier: session.tier,
      wolfHand: session.wolfHand,
      route: publicRoute(guest),
    });
  } catch (err) {
    return sendError(res, err);
  }
}
