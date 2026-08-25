// POST /api/activate-invite
// Сотрудник клуба подтверждает визит гостя по коду ПР-ХХХХ-ХХХ.
// Это точка, где партнёрский лид превращается в гостя клуба: засчитывается визит,
// выдаётся бесплатный стартовый стек и открывается право на раздачу.
//
// Доступ: роли staff / manager / marketing (вход на /admin/).

import { randomBytes } from 'node:crypto';
import { kv, KEY } from './_lib/kv.js';
import { applyCors, sendJson, sendError, readBody, requireRole, ROLES } from './_lib/auth.js';
import { staffLimiter, clientIp } from './_lib/ratelimit.js';
import { normalizeCode, CODE_KIND } from './_lib/codes.js';
import { CONFIG, PARTNERS } from './_lib/prizes.js';
import { getGuest, upsertGuest, publicRoute, routeState } from './_lib/guests.js';

const TODAY = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const staff = requireRole(req, [ROLES.STAFF, ROLES.MANAGER, ROLES.MARKETING]);

    const { success } = await staffLimiter().limit(`activate:${clientIp(req)}`);
    if (!success) return sendJson(res, 429, { error: 'RATE_LIMITED' });

    const body = await readBody(req);
    const code = normalizeCode(body.code, CODE_KIND.INVITE);
    if (!code) return sendJson(res, 400, { error: 'BAD_CODE', message: 'код вида ПР-ХХХХ-ХХХ' });

    const invite = await kv.get(KEY.invite(code));
    if (!invite) return sendJson(res, 404, { error: 'INVITE_NOT_FOUND', message: 'код не найден или истёк' });
    if (invite.usedAt) {
      return sendJson(res, 409, {
        error: 'ALREADY_USED',
        message: `приглашение уже активировано ${new Date(invite.usedAt).toLocaleString('ru-RU')}`,
      });
    }

    const guest = await getGuest(invite.phone);
    if (!guest) return sendJson(res, 404, { error: 'GUEST_NOT_FOUND' });

    // Тир вероятностей фиксируем в момент активации — по собранным картам маршрута.
    const route = routeState(guest);

    const now = Date.now();
    const sessionId = randomBytes(18).toString('base64url');
    const ttlSec = CONFIG.SESSION_TTL_HOURS * 3600;

    const session = {
      v: 1,
      id: sessionId,
      createdAt: now,
      staffId: String(staff.name || 'unknown').slice(0, 80),
      entryType: 'partner',
      sourcePartnerId: invite.partnerId,
      inviteCode: code,
      phone: invite.phone,
      guestName: guest.name || invite.name || '',
      // Согласия уже получены на точке партнёра — повторная регистрация не нужна.
      registered: true,
      device: invite.deviceHash ? { tokenHash: invite.deviceHash, boundAt: now } : null,
      tier: route.tier,
      wolfHand: route.wolfAvailable,
      dealsUsed: 0,
      maxDeals: CONFIG.DEALS_PER_QR,
      finalized: false,
      code: null,
    };
    await kv.set(KEY.session(sessionId), session, { ex: ttlSec });

    invite.usedAt = now;
    invite.sessionId = sessionId;
    invite.activatedBy = session.staffId;
    await kv.set(KEY.invite(code), invite, { ex: CONFIG.INVITE_TTL_DAYS * 24 * 3600 });

    await upsertGuest(invite.phone, {
      visits: (guest.visits || 0) + 1,
      lastVisitAt: now,
      activeInvite: null,
    });

    try {
      const date = TODAY();
      await kv.hincrby(KEY.partnerDay(date, invite.partnerId), 'visits', 1);
      await kv.hincrby(KEY.daily(date), 'partnerVisits', 1);
    } catch (e) {
      console.warn('activate stats failed', e.message);
    }

    return sendJson(res, 200, {
      ok: true,
      sessionId,
      guest: { name: guest.name, phone: invite.phone, visits: (guest.visits || 0) + 1 },
      partner: { id: invite.partnerId, name: PARTNERS[invite.partnerId]?.name || invite.partnerId },
      route: publicRoute(guest),
      tier: route.tier,
      wolfHand: route.wolfAvailable,
      // Что сотрудник обязан выдать по механике акции
      grant: 'Бесплатный стартовый стек фишек',
    });
  } catch (err) {
    return sendError(res, err);
  }
}
