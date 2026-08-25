// POST /api/entry
// Партнёрский контур: покупатель отсканировал QR на точке партнёра.
//
// Что происходит:
//   1. фиксируем согласия (в т.ч. отдельное — на передачу контакта партнёрам);
//   2. кладём карту партнёра в «покерный маршрут» гостя (привязка по телефону);
//   3. выдаём пригласительный код ПР-ХХХХ-ХХХ — его гость показывает на входе в клуб.
//
// Раздача здесь НЕ происходит: сыграть можно только в клубе, после подтверждения
// визита сотрудником. Это ключевое условие механики — партнёр приводит трафик,
// а розыгрыш остаётся событием на площадке.

import { kv, KEY } from './_lib/kv.js';
import { applyCors, sendJson, sendError, readBody } from './_lib/auth.js';
import { spinLimiter, clientIp } from './_lib/ratelimit.js';
import { generateCode, codeQrDataUrl, CODE_KIND } from './_lib/codes.js';
import { issueDeviceToken, hashToken } from './_lib/device.js';
import { CONFIG, PARTNERS, ROUTE_PARTNER_IDS } from './_lib/prizes.js';
import { normalizePhone, getGuest, upsertGuest, addRouteCard, publicRoute } from './_lib/guests.js';

const TODAY = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const { success } = await spinLimiter().limit(`entry:${clientIp(req)}`);
    if (!success) return sendJson(res, 429, { error: 'RATE_LIMITED' });

    const body = await readBody(req);

    const partnerId = String(body.partnerId || '').trim();
    if (!ROUTE_PARTNER_IDS.includes(partnerId)) {
      return sendJson(res, 400, { error: 'UNKNOWN_PARTNER', message: 'неизвестный партнёр в ссылке' });
    }

    const name = String(body.name || '').trim().slice(0, 80);
    const phone = normalizePhone(body.phone);
    if (name.length < 2) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'укажите имя' });
    if (!phone) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'некорректный номер телефона' });

    // Согласия. Передача контакта партнёрам — ОТДЕЛЬНОЕ согласие: без него участие
    // возможно, но контакт в базы партнёров не уходит (ст. 9 ФЗ-152).
    if (body.consentPd !== true) {
      return sendJson(res, 422, { error: 'CONSENT_REQUIRED', message: 'нужно согласие на обработку персональных данных' });
    }
    if (body.consentAge !== true) {
      return sendJson(res, 422, { error: 'AGE_CONSENT_REQUIRED', message: `участие с ${CONFIG.ADULT_AGE_THRESHOLD} лет` });
    }

    const now = Date.now();
    const existing = await getGuest(phone);

    const consent = {
      consentPd: true,
      consentAge: true,
      consentPartners: body.consentPartners === true, // передача контакта партнёрам цепочки
      consentMarketing: body.consentMarketing === true,
      at: new Date(now).toISOString(),
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] || '').slice(0, 256),
    };

    await upsertGuest(phone, {
      name: name || existing?.name || '',
      consent,
      sourcePartnerId: existing?.sourcePartnerId || partnerId, // первое касание не перезаписываем
    });

    const { guest, added } = await addRouteCard(phone, partnerId);

    // Пригласительный код. Один активный на гостя: повторный скан у другого партнёра
    // добавляет карту в маршрут, но не плодит приглашения.
    const ttlSec = CONFIG.INVITE_TTL_DAYS * 24 * 3600;
    let inviteCode = guest.activeInvite || null;
    let invite = inviteCode ? await kv.get(KEY.invite(inviteCode)) : null;

    if (!invite || invite.usedAt) {
      inviteCode = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateCode(CODE_KIND.INVITE);
        const record = {
          v: 1,
          code: candidate,
          phone,
          name,
          partnerId,                 // партнёр, приведший гостя (атрибуция лида)
          createdAt: now,
          expiresAt: now + ttlSec * 1000,
          usedAt: null,
          sessionId: null,
        };
        const ok = await kv.setNX(KEY.invite(candidate), record, { ex: ttlSec });
        if (ok) { inviteCode = candidate; invite = record; break; }
      }
      if (!inviteCode) {
        const err = new Error('не удалось выдать пригласительный код');
        err.status = 500; err.code = 'CODE_GENERATION_FAILED';
        throw err;
      }
      await upsertGuest(phone, { activeInvite: inviteCode });
    }

    // Токен устройства: дальше только это устройство сможет играть по приглашению.
    // Если гость уже сканировал QR другого партнёра с этого же телефона и предъявил
    // действующий токен — оставляем прежний. Иначе поход по цепочке партнёров
    // обнулял бы привязку на каждом шаге и ломал доступ к собственному приглашению.
    const presented = req.headers['x-device-token'];
    let deviceToken;
    if (presented && invite.deviceHash && hashToken(String(presented)) === invite.deviceHash) {
      deviceToken = String(presented);
    } else {
      const issued = issueDeviceToken();
      deviceToken = issued.token;
      invite.deviceHash = issued.tokenHash;
    }
    await kv.set(KEY.invite(inviteCode), invite, { ex: ttlSec });

    // Статистика партнёра — best-effort.
    // Регистрацией считаем ТОЛЬКО первое касание: иначе гость, обошедший четыре точки,
    // выглядит как четыре новых лида, и конверсия «скан → регистрация» уходит за 100%.
    try {
      const date = TODAY();
      const isNewGuest = !existing;
      if (isNewGuest) {
        await kv.hincrby(KEY.partnerDay(date, partnerId), 'signups', 1);
        await kv.hincrby(KEY.daily(date), 'signups', 1);
      } else {
        await kv.hincrby(KEY.partnerDay(date, partnerId), 'returns', 1);
      }
      if (added) await kv.hincrby(KEY.partnerDay(date, partnerId), 'cardsGiven', 1);
      if (isNewGuest && consent.consentPartners) {
        await kv.hincrby(KEY.partnerDay(date, partnerId), 'leadsShared', 1);
      }
    } catch (e) {
      console.warn('entry stats failed', e.message);
    }

    const freshGuest = await getGuest(phone);

    return sendJson(res, 201, {
      inviteCode,
      inviteQr: await codeQrDataUrl(inviteCode),
      deviceToken,
      cardAdded: added,
      partner: {
        id: partnerId,
        name: PARTNERS[partnerId].name,
        color: PARTNERS[partnerId].color,
        card: PARTNERS[partnerId].card,
      },
      route: publicRoute(freshGuest),
      expiresAt: new Date(now + ttlSec * 1000).toISOString(),
    });
  } catch (err) {
    return sendError(res, err);
  }
}
