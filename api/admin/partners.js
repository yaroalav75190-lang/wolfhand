// GET /api/admin/partners?from=&to=
// Партнёрская аналитика — то, ради чего партнёр кладёт приз в фонд.
//
// Маркетолог и управляющий видят всю цепочку и могут сравнивать точки между собой.
// Партнёр видит только свою строку: чужие обороты — не его дело.

import { kv, KEY } from '../_lib/kv.js';
import { applyCors, sendJson, sendError, requireRole, ROLES } from '../_lib/auth.js';
import { PARTNERS, PARTNER_IDS } from '../_lib/prizes.js';

const DAY_MS = 86400000;
const fmt = (d) => new Date(d).toISOString().slice(0, 10);

const FIELDS = [
  'scans',        // открытий лендинга по QR партнёра
  'signups',      // новых участников (первое касание)
  'returns',      // повторных заходов уже зарегистрированного гостя
  'cardsGiven',   // выданных карт маршрута
  'leadsShared',  // согласий на передачу контакта партнёрам
  'visits',       // подтверждённых визитов в клуб
  'deals',        // раздач гостей, приведённых партнёром
  'prizesWon',    // выигранных призов, которые предоставил этот партнёр
  'certsIssued',  // выданных сертификатов в его магазин
  'certsRedeemed',// погашённых сертификатов — деньги на его кассе
];

function dateRange(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if ((end - start) / DAY_MS > 400) return null;
  const out = [];
  for (let t = start; t <= end; t += DAY_MS) out.push(fmt(t));
  return out;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const session = requireRole(req, [ROLES.MANAGER, ROLES.MARKETING, ROLES.PARTNER]);

    const url = new URL(req.url, `http://${req.headers.host}`);
    const today = fmt(Date.now());
    const from = url.searchParams.get('from') || today;
    const to = url.searchParams.get('to') || today;
    const dates = dateRange(from, to);
    if (!dates) return sendJson(res, 400, { error: 'BAD_RANGE', message: 'некорректный период' });

    const ids = session.role === ROLES.PARTNER ? [session.partnerId] : PARTNER_IDS;

    const rows = [];
    for (const id of ids) {
      if (!PARTNERS[id]) continue;
      const totals = Object.fromEntries(FIELDS.map((f) => [f, 0]));
      const byDay = [];

      for (const date of dates) {
        const day = (await kv.hgetall(KEY.partnerDay(date, id))) || {};
        const row = { date };
        for (const f of FIELDS) {
          const v = Number(day[f]) || 0;
          row[f] = v;
          totals[f] += v;
        }
        byDay.push(row);
      }

      rows.push({
        id,
        name: PARTNERS[id].name,
        short: PARTNERS[id].short,
        kind: PARTNERS[id].kind,
        color: PARTNERS[id].color,
        card: PARTNERS[id].card,
        totals: {
          ...totals,
          scanToSignupPct: totals.scans ? +(totals.signups / totals.scans * 100).toFixed(1) : null,
          signupToVisitPct: totals.signups ? +(totals.visits / totals.signups * 100).toFixed(1) : null,
          certRedeemPct: totals.certsIssued ? +(totals.certsRedeemed / totals.certsIssued * 100).toFixed(1) : null,
        },
        byDay,
      });
    }

    return sendJson(res, 200, {
      range: { from, to, days: dates.length },
      scope: session.role === ROLES.PARTNER ? 'self' : 'all',
      partners: rows,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
