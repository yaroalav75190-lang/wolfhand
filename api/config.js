// GET /api/config
// Публичная витрина акции для лендинга: партнёры, таблица выплат, условия участия.
// Никаких весов и себестоимости — только то, что и так написано в правилах.

import { applyCors, sendJson, sendError } from './_lib/auth.js';
import { CONFIG, PARTNERS, ROUTE_PARTNER_IDS, publicPayoutTable, PRIZES, publicPrize } from './_lib/prizes.js';
import { COMBO_NAMES } from './_lib/cards.js';
import { stockReport } from './_lib/stock.js';

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    // Остатки главных призов показываем гостю: убывающий фонд — честно и подстёгивает.
    const stock = await stockReport();

    return sendJson(res, 200, {
      minCheck: CONFIG.MIN_CHECK_KITCHEN,
      adultAge: CONFIG.ADULT_AGE_THRESHOLD,
      codeTtlDays: CONFIG.CODE_TTL_DAYS,
      inviteTtlDays: CONFIG.INVITE_TTL_DAYS,
      comboNames: COMBO_NAMES,
      payouts: publicPayoutTable(),
      partners: Object.values(PARTNERS).map((p) => ({
        id: p.id, name: p.name, short: p.short, kind: p.kind, color: p.color, card: p.card,
      })),
      routePartnerIds: ROUTE_PARTNER_IDS,
      jackpot: publicPrize('apple_watch'),
      stock: stock.map((s) => ({ id: s.id, name: s.name, left: s.left, stock: s.stock })),
      prizes: Object.keys(PRIZES).map((id) => publicPrize(id)),
    });
  } catch (err) {
    return sendError(res, err);
  }
}
