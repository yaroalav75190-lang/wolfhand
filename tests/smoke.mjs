// Сквозной тест обоих контуров акции. Поднимает сервер на memory-драйвере
// и проходит путь гостя целиком — от скана QR у партнёра до погашения сертификата.
//
// Запуск:  node tests/smoke.mjs

process.env.KV_DRIVER = 'memory';
process.env.DEV_MODE = '1';
process.env.PORT = process.env.PORT || '3311';
process.env.HOST = '127.0.0.1';
process.env.PUBLIC_ORIGIN = `http://127.0.0.1:${process.env.PORT}`;
process.env.WOLF_SESSION_SECRET = 'smoke-test-secret-key-0123456789';
process.env.MANAGER_PASSWORD = 'mgr-pass';
process.env.MARKETING_PASSWORD = 'mkt-pass';
process.env.PARTNER_PASSWORD_HELLOAPPLE = 'apple-pass';
process.env.JACKPOT_MIN_INTERVAL_DAYS = '0';

const BASE = process.env.PUBLIC_ORIGIN;

let passed = 0;
let failed = 0;
function check(label, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} ${extra}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`); }

/** Простейший cookie-jar: сервер отдаёт одну cookie сессии. */
function makeClient() {
  let cookie = null;
  return async function call(method, url, { body, headers = {} } = {}) {
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: json };
  };
}

await import('../server.js');
await new Promise((r) => setTimeout(r, 400));

// ─────────────────────────────────────────────────────────────────────────────
section('Публичная витрина');
const guest = makeClient();

const cfg = await guest('GET', '/api/config');
check('GET /api/config → 200', cfg.status === 200, `(${cfg.status})`);
check('таблица выплат содержит 12 комбинаций', cfg.body?.payouts?.length === 12, `(${cfg.body?.payouts?.length})`);
check('партнёров пятеро', cfg.body?.partners?.length === 5);
check('джекпот — Apple Watch', cfg.body?.jackpot?.id === 'apple_watch');
check('веса и себестоимость не утекают', !JSON.stringify(cfg.body).includes('cogs'));

// ─────────────────────────────────────────────────────────────────────────────
section('Контур 1: гость приходит от партнёра');

const scan = await guest('POST', '/api/scan', { body: { partnerId: 'helloapple' } });
check('POST /api/scan → 204', scan.status === 204, `(${scan.status})`);

const badEntry = await guest('POST', '/api/entry', {
  body: { partnerId: 'helloapple', name: 'Тест', phone: '+79000000001', consentAge: true },
});
check('регистрация без согласия на ПДн отклоняется', badEntry.status === 422, `(${badEntry.status})`);

const entry = await guest('POST', '/api/entry', {
  body: {
    partnerId: 'helloapple', name: 'Иван Тестов', phone: '+7 900 000-00-01',
    consentPd: true, consentAge: true, consentPartners: true, consentMarketing: true,
  },
});
check('POST /api/entry → 201', entry.status === 201, `(${entry.status}) ${JSON.stringify(entry.body).slice(0, 120)}`);
check('выдан код приглашения ПР-', /^ПР-/.test(entry.body?.inviteCode || ''), `(${entry.body?.inviteCode})`);
check('карта партнёра добавлена в маршрут', entry.body?.cardAdded === true);
check('маршрут: 1 из 4', entry.body?.route?.collectedCount === 1 && entry.body?.route?.total === 4);
check('выдан QR приглашения', String(entry.body?.inviteQr || '').startsWith('data:image/png'));

const deviceToken = entry.body.deviceToken;
const inviteCode = entry.body.inviteCode;

const statusPending = await guest('GET', `/api/invite-status?code=${encodeURIComponent(inviteCode)}`, {
  headers: { 'X-Device-Token': deviceToken },
});
check('до подтверждения статус pending', statusPending.body?.status === 'pending');

const foreign = await guest('GET', `/api/invite-status?code=${encodeURIComponent(inviteCode)}`, {
  headers: { 'X-Device-Token': 'forged-token-xyz' },
});
check('чужое устройство получает 403', foreign.status === 403, `(${foreign.status})`);

// Гость доходит до второго партнёра — маршрут растёт
const entry2 = await guest('POST', '/api/entry', {
  headers: { 'X-Device-Token': deviceToken },
  body: {
    partnerId: 'levvel', name: 'Иван Тестов', phone: '+79000000001',
    consentPd: true, consentAge: true, consentPartners: true,
  },
});
check('токен устройства сохраняется при походе по цепочке', entry2.body?.deviceToken === deviceToken);
check('вторая карта маршрута добавлена', entry2.body?.route?.collectedCount === 2, `(${entry2.body?.route?.collectedCount})`);

const entryDup = await guest('POST', '/api/entry', {
  headers: { 'X-Device-Token': deviceToken },
  body: { partnerId: 'levvel', name: 'Иван Тестов', phone: '+79000000001', consentPd: true, consentAge: true },
});
check('повторный скан того же партнёра карту не дублирует', entryDup.body?.cardAdded === false);
check('приглашение переиспользуется, а не плодится', entryDup.body?.inviteCode === inviteCode);

// ─────────────────────────────────────────────────────────────────────────────
section('Сотрудник клуба подтверждает визит');
const staff = makeClient();

const noAuth = await staff('POST', '/api/activate-invite', { body: { code: inviteCode } });
check('без входа активация запрещена', noAuth.status === 401, `(${noAuth.status})`);

const login = await staff('POST', '/api/admin/login', { body: { role: 'staff', name: 'Анна Хостес' } });
check('вход сотрудника по имени', login.status === 200 && login.body?.role === 'staff');

const activate = await staff('POST', '/api/activate-invite', { body: { code: inviteCode } });
check('POST /api/activate-invite → 200', activate.status === 200, `(${activate.status}) ${JSON.stringify(activate.body).slice(0, 120)}`);
check('создана игровая сессия', !!activate.body?.sessionId);
check('визит засчитан гостю', activate.body?.guest?.visits === 1);
check('сотруднику показано, что выдать', /стек фишек/i.test(activate.body?.grant || ''));

const activateAgain = await staff('POST', '/api/activate-invite', { body: { code: inviteCode } });
check('повторная активация того же кода отклоняется', activateAgain.status === 409, `(${activateAgain.status})`);

const sessionId = activate.body.sessionId;

// ─────────────────────────────────────────────────────────────────────────────
section('Раздача');

const dealNoDevice = await guest('POST', '/api/deal', { headers: { 'X-Session-Id': sessionId } });
check('раздача без токена устройства запрещена', dealNoDevice.status === 403, `(${dealNoDevice.status})`);

const deal = await guest('POST', '/api/deal', {
  headers: { 'X-Session-Id': sessionId, 'X-Device-Token': deviceToken },
});
check('POST /api/deal → 200', deal.status === 200, `(${deal.status}) ${JSON.stringify(deal.body).slice(0, 160)}`);
check('пришло ровно 5 карт', deal.body?.cards?.length === 5, `(${deal.body?.cards?.length})`);
check('комбинация названа по-русски', typeof deal.body?.comboName === 'string' && deal.body.comboName.length > 2);
check('выдан код приза ВЛ-', /^ВЛ-/.test(deal.body?.code || ''), `(${deal.body?.code})`);
check('сертификат партнёра выдан всегда', !!deal.body?.cert);
check('покупатель HELLO APPLE получил сертификат своего магазина',
  deal.body?.cert?.id === 'cert_helloapple' || deal.body?.prize?.provider === 'helloapple',
  `(${deal.body?.cert?.id})`);
check('веса не утекли клиенту', !JSON.stringify(deal.body).includes('weight'));

const dealAgain = await guest('POST', '/api/deal', {
  headers: { 'X-Session-Id': sessionId, 'X-Device-Token': deviceToken },
});
check('вторая раздача по тому же QR невозможна', dealAgain.status === 409, `(${dealAgain.status})`);

const restore = await guest('GET', '/api/session-status', {
  headers: { 'X-Session-Id': sessionId, 'X-Device-Token': deviceToken },
});
check('состояние восстанавливается после перезагрузки', !!restore.body?.code && restore.body.code === deal.body.code);
check('рука в восстановлении та же', restore.body?.cards?.length === 5 && restore.body.cards[0].code === deal.body?.cards?.[0]?.code);

const prizeCode = deal.body.code;

// ─────────────────────────────────────────────────────────────────────────────
section('Погашение');

const preview = await staff('GET', `/api/redeem?code=${encodeURIComponent(prizeCode)}`);
check('предпросмотр кода сотрудником', preview.status === 200 && preview.body?.code === prizeCode);
check('в предпросмотре видна рука гостя', preview.body?.cards?.length === 5);

if (deal.body.prize) {
  const redeem = await staff('POST', '/api/redeem', { body: { code: prizeCode, what: 'prize' } });
  check('приз выдан', redeem.status === 200, `(${redeem.status})`);
  const redeemTwice = await staff('POST', '/api/redeem', { body: { code: prizeCode, what: 'prize' } });
  check('повторная выдача приза заблокирована', redeemTwice.status === 409, `(${redeemTwice.status})`);
} else {
  const noPrize = await staff('POST', '/api/redeem', { body: { code: prizeCode, what: 'prize' } });
  check('по руке без приза выдача возвращает 422', noPrize.status === 422, `(${noPrize.status})`);
}

// Партнёр гасит свой сертификат сам
const partner = makeClient();
const pLogin = await partner('POST', '/api/admin/login', {
  body: { role: 'partner', partnerId: 'helloapple', password: 'apple-pass' },
});
check('вход партнёра по паролю', pLogin.status === 200 && pLogin.body?.partnerId === 'helloapple', `(${pLogin.status})`);

const pBadLogin = await makeClient()('POST', '/api/admin/login', {
  body: { role: 'partner', partnerId: 'helloapple', password: 'неверный' },
});
check('неверный пароль партнёра отклоняется', pBadLogin.status === 401);

const certProvider = deal.body?.cert?.provider;
const certRedeem = await partner('POST', '/api/redeem', { body: { code: prizeCode, what: 'cert' } });
if (certProvider === 'helloapple') {
  check('партнёр погасил свой сертификат', certRedeem.status === 200, `(${certRedeem.status})`);
} else {
  check('партнёр не может погасить чужой сертификат', certRedeem.status === 403, `(${certRedeem.status})`);
}

const partnerTriesPrize = await partner('POST', '/api/redeem', { body: { code: prizeCode, what: 'prize' } });
check('партнёр не может выдавать призы клуба', partnerTriesPrize.status === 403, `(${partnerTriesPrize.status})`);

const partnerStats = await partner('GET', '/api/admin/stats');
check('партнёр не видит сводку клуба', partnerStats.status === 401, `(${partnerStats.status})`);

// ─────────────────────────────────────────────────────────────────────────────
section('Контур 2: гость клуба по чеку на кухню');

const lowCheck = await staff('POST', '/api/session', { body: { check: 900 } });
check('чек ниже порога отклоняется', lowCheck.status === 422, `(${lowCheck.status})`);

const batch = await staff('POST', '/api/session', { body: { check: 5200, tableNo: '7' } });
check('чек 5200 ₽ → 2 QR', batch.body?.qrCount === 2, `(${batch.body?.qrCount})`);
check('QR отдан картинкой', String(batch.body?.qrs?.[0]?.qrDataUrl || '').startsWith('data:image/png'));

const clubSession = batch.body.qrs[0].sessionId;
const clubGuest = makeClient();

const dealBeforeReg = await clubGuest('POST', '/api/deal', { headers: { 'X-Session-Id': clubSession } });
check('без регистрации раздача недоступна', dealBeforeReg.status === 412, `(${dealBeforeReg.status})`);

// Тот же телефон, что и в партнёрском контуре: маршрут должен подтянуться
const reg = await clubGuest('POST', '/api/registration', {
  headers: { 'X-Session-Id': clubSession },
  body: { name: 'Иван Тестов', phone: '+79000000001', consentPd: true, consentAge: true },
});
check('регистрация гостя клуба', reg.status === 200, `(${reg.status})`);
check('маршрут подтянулся по телефону', reg.body?.route?.collectedCount === 2, `(${reg.body?.route?.collectedCount})`);

const clubDeal = await clubGuest('POST', '/api/deal', {
  headers: { 'X-Session-Id': clubSession, 'X-Device-Token': reg.body.deviceToken },
});
check('раздача гостю клуба', clubDeal.status === 200 && clubDeal.body?.cards?.length === 5, `(${clubDeal.status})`);
check('сертификат ведёт к несобранному партнёру',
  ['cert_chapaev', 'cert_kontora'].includes(clubDeal.body?.cert?.id) || !!clubDeal.body?.prize,
  `(${clubDeal.body?.cert?.id})`);

// ─────────────────────────────────────────────────────────────────────────────
section('Аналитика и права доступа');

const mkt = makeClient();
await mkt('POST', '/api/admin/login', { body: { role: 'marketing', password: 'mkt-pass' } });

const stats = await mkt('GET', '/api/admin/stats');
check('сводка доступна маркетологу', stats.status === 200, `(${stats.status})`);
check('раздачи посчитаны', stats.body?.totals?.deals === 2, `(${stats.body?.totals?.deals})`);
check('воронка построена', stats.body?.funnel?.signups >= 1);
check('распределение комбинаций отдаётся', Array.isArray(stats.body?.combos) && stats.body.combos.length === 12);
check('остаток Apple Watch виден', stats.body?.stock?.some((s) => s.id === 'apple_watch'));

const partnersReport = await mkt('GET', '/api/admin/partners');
check('партнёрский отчёт по всей цепочке', partnersReport.body?.partners?.length === 5, `(${partnersReport.body?.partners?.length})`);
const apple = partnersReport.body.partners.find((p) => p.id === 'helloapple');
check('скан засчитан HELLO APPLE', apple?.totals?.scans === 1, `(${apple?.totals?.scans})`);
check('регистрация засчитана HELLO APPLE', apple?.totals?.signups === 1);
check('визит засчитан HELLO APPLE', apple?.totals?.visits === 1);

const leads = await mkt('GET', '/api/admin/leads');
check('база участников доступна маркетологу', leads.status === 200 && leads.body?.total === 1, `(${leads.body?.total})`);
check('в лиде виден источник', leads.body?.leads?.[0]?.sourcePartnerName === 'HELLO APPLE');

const partnerLeads = await partner('GET', '/api/admin/leads');
check('партнёр видит только своих лидов', partnerLeads.status === 200 && partnerLeads.body?.scope === 'partner');

const csv = await mkt('GET', '/api/admin/leads?format=csv');
check('выгрузка CSV работает', typeof csv.body?.raw === 'string' && csv.body.raw.includes('Телефон'));

const audit = await mkt('GET', '/api/admin/audit');
check('журнал выдач заполняется', audit.body?.total === 2, `(${audit.body?.total})`);

// ─────────────────────────────────────────────────────────────────────────────
section('Права субъекта персональных данных');

const revoke = await mkt('POST', '/api/admin/guest', { body: { phone: '+79000000001', action: 'revoke_partners' } });
check('отзыв согласия на передачу партнёрам', revoke.status === 200, `(${revoke.status})`);

const leadsAfterRevoke = await partner('GET', '/api/admin/leads');
check('после отзыва контакт исчезает из партнёрской выгрузки',
  leadsAfterRevoke.body?.total === 0, `(${leadsAfterRevoke.body?.total})`);

const del = await mkt('POST', '/api/admin/guest', { body: { phone: '+79000000001', action: 'delete' } });
check('удаление персональных данных', del.status === 200, `(${del.status})`);

const gone = await mkt('GET', '/api/admin/guest?phone=+79000000001');
check('профиль действительно удалён', gone.status === 404, `(${gone.status})`);

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(64)}`);
console.log(`Пройдено: ${passed}   Провалено: ${failed}`);
console.log('═'.repeat(64));
process.exit(failed ? 1 : 0);
