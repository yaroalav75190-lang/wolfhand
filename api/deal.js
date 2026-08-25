// POST /api/deal
// Раздача. Главное событие акции: сервер разыгрывает комбинацию, собирает под неё
// пять карт и сразу выпускает код приза — отдельного «забрать выигрыш» не требуется,
// рука в покере одна.
//
// Доступ: X-Session-Id + X-Device-Token (устройство, на котором шла регистрация).

import { kv, KEY } from './_lib/kv.js';
import { applyCors, sendJson, sendError, readBody } from './_lib/auth.js';
import { spinLimiter, clientIp } from './_lib/ratelimit.js';
import { deviceAllowed } from './_lib/device.js';
import { dealHand, publicDeal } from './_lib/deal.js';
import { generateCode, codeQrDataUrl, CODE_KIND } from './_lib/codes.js';
import { guards, registerIssued } from './_lib/stock.js';
import { recordIssue } from './_lib/audit.js';
import { CONFIG, PRIZES, PARTNERS } from './_lib/prizes.js';
import { getGuest, routeState, consumeWolfHand, recordDeal, publicRoute } from './_lib/guests.js';

const TODAY = () => new Date().toISOString().slice(0, 10);

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  try {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 64) {
      return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'нужен заголовок X-Session-Id' });
    }

    const { success } = await spinLimiter().limit(`deal:${clientIp(req)}`);
    if (!success) return sendJson(res, 429, { error: 'RATE_LIMITED' });

    const body = await readBody(req).catch(() => ({}));
    const forceCombo = process.env.DEV_MODE === '1' ? (body.forceCombo || null) : null;

    const session = await kv.get(KEY.session(sessionId));
    if (!session) return sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });
    if (!session.registered) return sendJson(res, 412, { error: 'REGISTRATION_REQUIRED' });
    // Проверка устройства идёт ДО проверки finalized: иначе чужое устройство
    // вытянуло бы готовый код приза из ответа 409.
    if (!deviceAllowed(req, session)) {
      return sendJson(res, 403, { error: 'SESSION_LOCKED', message: 'раздача открыта на другом устройстве' });
    }
    if (session.finalized) return sendJson(res, 409, { error: 'ALREADY_DEALT', code: session.code });
    if (session.dealsUsed >= session.maxDeals) return sendJson(res, 409, { error: 'NO_DEALS_LEFT' });

    // Маршрут гостя читаем в момент раздачи: карту могли добавить между регистрацией и игрой.
    const guest = session.phone ? await getGuest(session.phone) : null;
    const route = guest ? routeState(guest) : { tier: 'base', collected: [], wolfAvailable: false };
    const tier = route.tier;

    const g = await guards();
    const result = dealHand({
      tier,
      sourcePartnerId: session.sourcePartnerId,
      collectedPartnerIds: route.collected,
      forceCombo,
      ...g,
    });

    const now = Date.now();
    const ttlSec = CONFIG.CODE_TTL_DAYS * 24 * 3600;

    // Код приза. setNX защищает от коллизии; 5 попыток — запас на порядки.
    let code = null;
    let codeRecord = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateCode(CODE_KIND.PRIZE);
      codeRecord = {
        v: 1,
        code: candidate,
        sessionId,
        createdAt: now,
        expiresAt: now + ttlSec * 1000,
        combo: result.combo,
        comboName: result.comboName,
        cards: result.cards,
        tier,
        entryType: session.entryType,
        sourcePartnerId: session.sourcePartnerId,
        staffId: session.staffId,
        guest: { name: session.guestName, phone: session.phone },
        // Приз клуба/партнёра — гасит сотрудник клуба
        prizeId: result.prizeId,
        prizeRedeemed: false,
        prizeRedeemedAt: null,
        prizeRedeemedBy: null,
        // Сертификат партнёра — гасит сам партнёр в своём кабинете
        certPrizeId: result.certPrizeId,
        certRedeemed: false,
        certRedeemedAt: null,
        certRedeemedBy: null,
      };
      const ok = await kv.setNX(KEY.code(candidate), codeRecord, { ex: ttlSec });
      if (ok) { code = candidate; break; }
    }
    if (!code) {
      const err = new Error('не удалось выпустить код приза');
      err.status = 500; err.code = 'CODE_GENERATION_FAILED';
      throw err;
    }

    session.dealsUsed += 1;
    session.finalized = true;
    session.code = code;
    session.combo = result.combo;
    session.dealtAt = now;
    await kv.set(KEY.session(sessionId), session, { ex: CONFIG.SESSION_TTL_HOURS * 3600 });

    // «Рука волка» одноразовая — списываем сразу после использования.
    if (session.phone && tier === 'wolf') await consumeWolfHand(session.phone);
    if (session.phone) await recordDeal(session.phone);

    // Статистика и фонд — best-effort, гость не должен ждать.
    try {
      const date = TODAY();
      await kv.hincrby(KEY.daily(date), 'deals', 1);
      await kv.incr(KEY.combo(date, result.combo));
      if (result.prizeId) await kv.hincrby(KEY.daily(date), 'wins', 1);
      if (result.isJackpot) {
        await kv.hincrby(KEY.daily(date), 'jackpots', 1);
        await kv.set(KEY.jackpot, new Date(now).toISOString()); // закрывает окно сразу
      }
      if (g.suppressExpensive) await kv.hincrby(KEY.daily(date), 'budgetCappedDeals', 1);
      if (g.suppressJackpot) await kv.hincrby(KEY.daily(date), 'jackpotCappedDeals', 1);

      if (result.prizeId) await registerIssued(result.prizeId, { date });
      await registerIssued(result.certPrizeId, { date });

      // Атрибуция: раздача засчитывается партнёру, который привёл гостя,
      // а выданный сертификат — партнёру, в чей магазин он ведёт.
      if (session.sourcePartnerId) {
        await kv.hincrby(KEY.partnerDay(date, session.sourcePartnerId), 'deals', 1);
      }
      const certProvider = PRIZES[result.certPrizeId]?.provider;
      if (certProvider && PARTNERS[certProvider]) {
        await kv.hincrby(KEY.partnerDay(date, certProvider), 'certsIssued', 1);
      }
      const prizeProvider = result.prizeId ? PRIZES[result.prizeId]?.provider : null;
      if (prizeProvider && PARTNERS[prizeProvider]) {
        await kv.hincrby(KEY.partnerDay(date, prizeProvider), 'prizesWon', 1);
      }
    } catch (e) {
      console.warn('deal stats failed', e.message);
    }

    // Очередь ручной выдачи — только для призов, которые нельзя отдать со стойки сразу.
    try {
      const prize = result.prizeId ? PRIZES[result.prizeId] : null;
      if (prize?.deferredFulfillment) {
        await kv.set(KEY.fulfill(code, result.prizeId), {
          v: 1, code, prizeId: result.prizeId, prizeName: prize.name,
          kind: prize.deferredFulfillment,
          guest: { name: session.guestName, phone: session.phone },
          createdAt: now, done: false, doneAt: null, doneBy: null,
          taxable: !!prize.taxable,
        });
      }
    } catch (e) {
      console.warn('fulfillment queue failed', e.message);
    }

    try { await recordIssue(codeRecord); } catch (e) { console.warn('audit failed', e.message); }

    const pub = publicDeal(result);
    return sendJson(res, 200, {
      ...pub,
      code,
      codeQr: await codeQrDataUrl(code),
      expiresAt: new Date(now + ttlSec * 1000).toISOString(),
      route: guest ? publicRoute(await getGuest(session.phone)) : null,
      // Памятка по НДФЛ показывается только когда приз реально облагается
      tax: pub.prize?.taxable
        ? { amount: pub.prize.taxHint, note: 'Приз дороже 4 000 ₽ — НДФЛ 35 % с превышения. Нужны паспорт и ИНН.' }
        : null,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
