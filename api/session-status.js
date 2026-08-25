// GET /api/session-status
// Восстановление состояния после перезагрузки страницы: гость не должен потерять
// свою руку и код приза, если браузер закрылся.
//
// Доступ: X-Session-Id + X-Device-Token (после регистрации).

import { kv, KEY } from './_lib/kv.js';
import { applyCors, sendJson, sendError } from './_lib/auth.js';
import { deviceAllowed } from './_lib/device.js';
import { publicHand, winningIndexes, COMBO_NAMES } from './_lib/cards.js';
import { publicPrize, PARTNERS } from './_lib/prizes.js';
import { codeQrDataUrl } from './_lib/codes.js';
import { getGuest, publicRoute } from './_lib/guests.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const sessionId = req.headers['x-session-id'] || new URL(req.url, `http://${req.headers.host}`).searchParams.get('s');
    if (!sessionId) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'нужен X-Session-Id' });

    const session = await kv.get(KEY.session(String(sessionId)));
    if (!session) return sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });

    // До регистрации сессия ещё не привязана к устройству — отдаём только анкету.
    if (!session.registered) {
      return sendJson(res, 200, {
        registered: false,
        entryType: session.entryType,
        sourcePartner: session.sourcePartnerId
          ? { id: session.sourcePartnerId, name: PARTNERS[session.sourcePartnerId]?.name }
          : null,
        dealsLeft: session.maxDeals,
      });
    }

    if (!deviceAllowed(req, session)) {
      return sendJson(res, 403, { error: 'SESSION_LOCKED', message: 'раздача открыта на другом устройстве' });
    }

    const guest = session.phone ? await getGuest(session.phone) : null;
    const base = {
      registered: true,
      entryType: session.entryType,
      guestName: session.guestName,
      tier: session.tier,
      wolfHand: !!session.wolfHand,
      dealsLeft: Math.max(0, session.maxDeals - session.dealsUsed),
      route: guest ? publicRoute(guest) : null,
      sourcePartner: session.sourcePartnerId
        ? { id: session.sourcePartnerId, name: PARTNERS[session.sourcePartnerId]?.name }
        : null,
    };

    if (!session.finalized || !session.code) return sendJson(res, 200, base);

    // Раздача уже состоялась — возвращаем ту же руку и тот же код.
    const record = await kv.get(KEY.code(session.code));
    if (!record) return sendJson(res, 200, { ...base, finalized: true, code: session.code });

    return sendJson(res, 200, {
      ...base,
      finalized: true,
      code: record.code,
      codeQr: await codeQrDataUrl(record.code),
      combo: record.combo,
      comboName: record.comboName || COMBO_NAMES[record.combo],
      cards: publicHand(record.cards || []),
      highlight: record.cards ? winningIndexes(record.cards, record.combo) : [],
      prize: record.prizeId ? publicPrize(record.prizeId) : null,
      cert: record.certPrizeId ? publicPrize(record.certPrizeId) : null,
      prizeRedeemed: !!record.prizeRedeemed,
      certRedeemed: !!record.certRedeemed,
      expiresAt: new Date(record.expiresAt).toISOString(),
    });
  } catch (err) {
    return sendError(res, err);
  }
}
