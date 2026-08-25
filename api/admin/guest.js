// GET  /api/admin/guest?phone=+7...   — карточка участника
// POST /api/admin/guest {phone, action}
//        action: 'revoke_partners' — отозвать согласие на передачу контакта партнёрам
//        action: 'delete'          — удалить персональные данные
//
// Это исполнение прав субъекта ПДн (ст. 14 и 21 ФЗ-152): участник вправе потребовать
// прекратить обработку, и у маркетолога должна быть кнопка, а не переписка с разработчиком.
//
// При удалении профиль стирается, но обезличенные счётчики акции (сколько было раздач,
// какие комбинации выпали) остаются — они не содержат персональных данных.

import { kv, KEY } from '../_lib/kv.js';
import { applyCors, sendJson, sendError, readBody, requireRole, ROLES } from '../_lib/auth.js';
import { PARTNERS } from '../_lib/prizes.js';
import { normalizePhone, getGuest, upsertGuest, routeState } from '../_lib/guests.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  try {
    const session = requireRole(req, [ROLES.MANAGER, ROLES.MARKETING]);

    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const phone = normalizePhone(url.searchParams.get('phone'));
      if (!phone) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'некорректный номер' });

      const guest = await getGuest(phone);
      if (!guest) return sendJson(res, 404, { error: 'NOT_FOUND' });

      const state = routeState(guest);
      return sendJson(res, 200, {
        phone: guest.phone,
        name: guest.name,
        createdAt: guest.createdAt ? new Date(guest.createdAt).toISOString() : null,
        source: guest.sourcePartnerId ? PARTNERS[guest.sourcePartnerId]?.name : 'Клуб',
        visits: guest.visits || 0,
        deals: guest.deals || 0,
        route: state.collected.map((id) => PARTNERS[id]?.name || id),
        routeComplete: state.complete,
        wolfHandUsedAt: guest.wolfHandUsedAt ? new Date(guest.wolfHandUsedAt).toISOString() : null,
        consent: guest.consent || null,
      });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

    const body = await readBody(req);
    const phone = normalizePhone(body.phone);
    if (!phone) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'некорректный номер' });

    const guest = await getGuest(phone);
    if (!guest) return sendJson(res, 404, { error: 'NOT_FOUND' });

    const action = String(body.action || '');
    const who = String(session.name || 'unknown').slice(0, 80);

    if (action === 'revoke_partners') {
      await upsertGuest(phone, {
        consent: { ...(guest.consent || {}), consentPartners: false, revokedAt: new Date().toISOString(), revokedBy: who },
      });
      return sendJson(res, 200, { ok: true, action, message: 'контакт больше не передаётся партнёрам' });
    }

    if (action === 'revoke_marketing') {
      await upsertGuest(phone, {
        consent: { ...(guest.consent || {}), consentMarketing: false, revokedAt: new Date().toISOString(), revokedBy: who },
      });
      return sendJson(res, 200, { ok: true, action, message: 'рассылка отключена' });
    }

    if (action === 'delete') {
      if (guest.activeInvite) await kv.del(KEY.invite(guest.activeInvite));
      await kv.del(KEY.guest(phone));
      console.log(`[pd] профиль ${phone.slice(0, 4)}***${phone.slice(-2)} удалён (${who})`);
      return sendJson(res, 200, { ok: true, action, message: 'персональные данные удалены' });
    }

    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'неизвестное действие' });
  } catch (err) {
    return sendError(res, err);
  }
}
