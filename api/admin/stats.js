// GET /api/admin/stats?from=YYYY-MM-DD&to=YYYY-MM-DD
// Сводка акции: воронка, раздачи, распределение комбинаций, расход фонда, остатки призов.
// Доступ: manager / marketing. Партнёр сюда не ходит — у него /api/admin/partners.

import { kv, KEY } from '../_lib/kv.js';
import { applyCors, sendJson, sendError, requireRole, ROLES } from '../_lib/auth.js';
import { PRIZES, PARTNERS, WEIGHT_TIERS, ROUTE_PARTNER_IDS } from '../_lib/prizes.js';
import { COMBO_NAMES } from '../_lib/cards.js';
import { stockReport } from '../_lib/stock.js';

const DAY_MS = 86400000;
const fmt = (d) => new Date(d).toISOString().slice(0, 10);

function dateRange(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if ((end - start) / DAY_MS > 400) return null; // защита от запроса на годы
  const out = [];
  for (let t = start; t <= end; t += DAY_MS) out.push(fmt(t));
  return out;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    requireRole(req, [ROLES.MANAGER, ROLES.MARKETING]);

    const url = new URL(req.url, `http://${req.headers.host}`);
    const today = fmt(Date.now());
    const from = url.searchParams.get('from') || today;
    const to = url.searchParams.get('to') || today;

    const dates = dateRange(from, to);
    if (!dates) return sendJson(res, 400, { error: 'BAD_RANGE', message: 'некорректный период' });

    const byDay = [];
    const totals = {
      scans: 0, signups: 0, partnerVisits: 0, checks: 0, qrIssued: 0, checkSum: 0,
      deals: 0, wins: 0, jackpots: 0, payoutsCogs: 0, prizesRedeemed: 0,
      budgetCappedDeals: 0, jackpotCappedDeals: 0,
    };
    const combos = {};
    const issued = {};
    const redeemed = {};

    for (const date of dates) {
      const daily = (await kv.hgetall(KEY.daily(date))) || {};
      const row = { date };
      for (const key of Object.keys(totals)) {
        const v = Number(daily[key]) || 0;
        row[key] = v;
        totals[key] += v;
      }
      byDay.push(row);

      for (const combo of Object.keys(COMBO_NAMES)) {
        const n = Number(await kv.get(KEY.combo(date, combo))) || 0;
        if (n) combos[combo] = (combos[combo] || 0) + n;
      }
      const iss = (await kv.hgetall(KEY.issuedDay(date))) || {};
      for (const [prizeId, n] of Object.entries(iss)) issued[prizeId] = (issued[prizeId] || 0) + Number(n || 0);
      const red = (await kv.hgetall(KEY.redeemedDay(date))) || {};
      for (const [prizeId, n] of Object.entries(red)) redeemed[prizeId] = (redeemed[prizeId] || 0) + Number(n || 0);
    }

    // Фактическое распределение комбинаций против заложенного в весах —
    // главный индикатор того, что движок раздачи ведёт себя как задумано.
    const comboReport = Object.keys(COMBO_NAMES).map((combo) => {
      const count = combos[combo] || 0;
      return {
        combo,
        name: COMBO_NAMES[combo],
        count,
        sharePct: totals.deals ? +(count / totals.deals * 100).toFixed(2) : 0,
        expectedPct: WEIGHT_TIERS.base[combo] ?? 0,
      };
    });

    // Розничная стоимость выданного — то, чем партнёры отчитываются перед собой.
    let retailIssued = 0;
    const prizeReport = Object.entries(issued).map(([prizeId, count]) => {
      const p = PRIZES[prizeId];
      retailIssued += (p?.retail || 0) * count;
      return {
        prizeId,
        name: p?.name || prizeId,
        provider: p?.provider || null,
        providerName: PARTNERS[p?.provider]?.name || null,
        issued: count,
        redeemed: redeemed[prizeId] || 0,
        retail: p?.retail || 0,
        clubCogs: (p?.cogs || 0) * count,
      };
    }).sort((a, b) => b.issued - a.issued);

    // Воронка описывает ТОЛЬКО партнёрский трафик, поэтому последняя ступень —
    // раздачи гостей, приведённых партнёрами, а не все раздачи акции. Иначе гости,
    // пришедшие в клуб по чеку, задирают конверсию выше 100%.
    let partnerDeals = 0;
    for (const date of dates) {
      for (const pid of ROUTE_PARTNER_IDS) {
        const row = (await kv.hgetall(KEY.partnerDay(date, pid))) || {};
        partnerDeals += Number(row.deals) || 0;
      }
    }

    const funnel = {
      scans: totals.scans,
      signups: totals.signups,
      visits: totals.partnerVisits,
      deals: partnerDeals,
      clubDeals: totals.deals - partnerDeals,
      // Конверсии считаем только когда есть от чего считать — иначе вводит в заблуждение.
      scanToSignup: totals.scans ? +(totals.signups / totals.scans * 100).toFixed(1) : null,
      signupToVisit: totals.signups ? +(totals.partnerVisits / totals.signups * 100).toFixed(1) : null,
      visitToDeal: totals.partnerVisits ? +(partnerDeals / totals.partnerVisits * 100).toFixed(1) : null,
    };

    return sendJson(res, 200, {
      range: { from, to, days: dates.length },
      totals: {
        ...totals,
        avgCheck: totals.checks ? Math.round(totals.checkSum / totals.checks) : 0,
        winRatePct: totals.deals ? +(totals.wins / totals.deals * 100).toFixed(1) : 0,
        retailIssued,
      },
      funnel,
      byDay,
      combos: comboReport,
      prizes: prizeReport,
      stock: await stockReport(),
    });
  } catch (err) {
    return sendError(res, err);
  }
}
