// Профиль гостя. Ключ — нормализованный телефон, поэтому «покерный маршрут»
// продолжается между визитами и между точками партнёров, даже если гость
// сканирует QR с разных устройств.
//
// Хранится без TTL: маршрут и согласия должны переживать 14-дневные коды.
// Удаление по запросу субъекта ПДн — через админку маркетолога (см. api/admin/guest.js).

import { kv, KEY } from './kv.js';
import { ROUTE_PARTNER_IDS, PARTNERS, tierForRoute } from './prizes.js';

const PHONE_RE = /^\+7\d{10}$/;

/** Привести телефон к виду +7XXXXXXXXXX. Возвращает null, если это не российский номер. */
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  let out = null;
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) out = '+7' + digits.slice(1);
  else if (digits.length === 10) out = '+7' + digits;
  return out && PHONE_RE.test(out) ? out : null;
}

export async function getGuest(phone) {
  if (!phone) return null;
  return await kv.get(KEY.guest(phone));
}

function emptyGuest(phone) {
  return {
    v: 1,
    phone,
    name: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    consent: null,          // {consentPd, consentMarketing, consentPartners, at, ip, ua}
    route: [],              // [{partnerId, at}] — собранные карты маршрута
    wolfHandUsedAt: null,   // «Рука волка» одноразовая: отметка о списании
    visits: 0,              // подтверждённых визитов в клуб
    deals: 0,               // сыгранных раздач
    lastDealAt: null,
    sourcePartnerId: null,  // партнёр первого касания — для атрибуции лида
  };
}

/** Создать или обновить профиль. patch мержится поверх существующего. */
export async function upsertGuest(phone, patch = {}) {
  const existing = (await getGuest(phone)) || emptyGuest(phone);
  const next = { ...existing, ...patch, phone, updatedAt: Date.now() };
  await kv.set(KEY.guest(phone), next); // без TTL
  return next;
}

/**
 * Добавить карту партнёра в маршрут. Повторный визит к тому же партнёру
 * карту не дублирует — цепочка проходится один раз.
 * @returns {{guest: object, added: boolean}}
 */
export async function addRouteCard(phone, partnerId) {
  if (!ROUTE_PARTNER_IDS.includes(partnerId)) return { guest: await getGuest(phone), added: false };
  const guest = (await getGuest(phone)) || emptyGuest(phone);
  const already = guest.route.some((c) => c.partnerId === partnerId);
  if (already) return { guest, added: false };
  guest.route = [...guest.route, { partnerId, at: Date.now() }];
  const saved = await upsertGuest(phone, { route: guest.route });
  return { guest: saved, added: true };
}

/** Состояние маршрута: собранные карты, тир вероятностей, доступна ли «Рука волка». */
export function routeState(guest) {
  const collected = (guest?.route || []).map((c) => c.partnerId);
  const complete = ROUTE_PARTNER_IDS.every((id) => collected.includes(id));
  const wolfAvailable = complete && !guest?.wolfHandUsedAt;
  return {
    collected,
    missing: ROUTE_PARTNER_IDS.filter((id) => !collected.includes(id)),
    total: ROUTE_PARTNER_IDS.length,
    complete,
    wolfAvailable,
    // «Рука волка» разыгрывается один раз: после списания тир падает до boosted
    tier: wolfAvailable ? 'wolf' : (complete ? 'boosted' : tierForRoute(collected.length)),
  };
}

/** Публичное представление маршрута для клиента (с названиями и картами партнёров). */
export function publicRoute(guest) {
  const state = routeState(guest);
  return {
    total: state.total,
    collectedCount: state.collected.length,
    complete: state.complete,
    wolfAvailable: state.wolfAvailable,
    tier: state.tier,
    cards: ROUTE_PARTNER_IDS.map((id) => ({
      partnerId: id,
      name: PARTNERS[id].name,
      short: PARTNERS[id].short,
      color: PARTNERS[id].color,
      card: PARTNERS[id].card,
      collected: state.collected.includes(id),
    })),
  };
}

/** Списать «Руку волка» (одноразовое усиление). */
export async function consumeWolfHand(phone) {
  return await upsertGuest(phone, { wolfHandUsedAt: Date.now() });
}

/** Зафиксировать сыгранную раздачу в профиле. */
export async function recordDeal(phone) {
  const guest = (await getGuest(phone)) || emptyGuest(phone);
  return await upsertGuest(phone, { deals: (guest.deals || 0) + 1, lastDealAt: Date.now() });
}
