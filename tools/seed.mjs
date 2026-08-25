// Наполняет запущенный сервер демонстрационными данными — чтобы витрину маркетолога
// и кабинет партнёра можно было показывать заказчику не на пустых таблицах.
//
// Запуск (сервер должен быть поднят):
//   node tools/seed.mjs [адрес] [сколько гостей]
//   node tools/seed.mjs http://127.0.0.1:3300 40
//
// ⚠️ Только для тестового окружения: создаёт фиктивные телефоны +7900XXXXXXX.

const BASE = process.argv[2] || 'http://127.0.0.1:3300';
const COUNT = Number(process.argv[3]) || 40;

const PARTNERS = ['helloapple', 'levvel', 'chapaev', 'kontora'];
const NAMES = ['Иван', 'Пётр', 'Анна', 'Мария', 'Сергей', 'Ольга', 'Дмитрий', 'Елена',
  'Алексей', 'Наталья', 'Артём', 'Ксения', 'Михаил', 'Юлия', 'Роман', 'Дарья'];
const SURNAMES = ['Волков', 'Смирнов', 'Кузнецов', 'Попов', 'Соколов', 'Лебедев',
  'Новиков', 'Морозов', 'Петров', 'Егоров'];

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

async function call(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* пусто — это нормально для 204 */ }
  return { status: res.status, ok: res.ok, data, cookie: res.headers.get('set-cookie') };
}

// ── Вход сотрудника ──────────────────────────────────────────────────────────
const staffLogin = await call('POST', '/api/admin/login', {
  body: { role: 'staff', name: 'Демо Хостес' },
});
if (!staffLogin.ok) {
  console.error('Не удалось войти как сотрудник. Проверьте, что сервер запущен:', BASE);
  process.exit(1);
}
const staffCookie = staffLogin.cookie.split(';')[0];
const asStaff = (headers = {}) => ({ ...headers, Cookie: staffCookie });

console.log(`Наполняю ${BASE} — ${COUNT} участников\n`);

let stats = { partnerFlow: 0, clubFlow: 0, deals: 0, prizes: 0, wolf: 0 };

for (let i = 0; i < COUNT; i++) {
  const phone = `+7900${String(1000000 + i).slice(-7)}`;
  const name = `${pick(NAMES)} ${pick(SURNAMES)}`;

  // Часть гостей приходит по цепочке партнёров, часть — сразу в клуб по чеку.
  const viaPartner = Math.random() < 0.7;

  if (viaPartner) {
    // Сколько точек цепочки обошёл этот гость: большинство — одну, единицы — все.
    const roll = Math.random();
    const visitCount = roll < 0.6 ? 1 : roll < 0.85 ? 2 : roll < 0.96 ? 3 : 4;
    const route = [...PARTNERS].sort(() => Math.random() - 0.5).slice(0, visitCount);

    let deviceToken = null;
    let inviteCode = null;

    for (const partnerId of route) {
      await call('POST', '/api/scan', { body: { partnerId, anonId: `demo-${i}` } });
      const entry = await call('POST', '/api/entry', {
        headers: deviceToken ? { 'X-Device-Token': deviceToken } : {},
        body: {
          partnerId, name, phone,
          consentPd: true, consentAge: true,
          consentPartners: Math.random() < 0.8,
          consentMarketing: Math.random() < 0.6,
        },
      });
      if (!entry.ok) break;
      deviceToken = entry.data.deviceToken;
      inviteCode = entry.data.inviteCode;
    }
    if (!inviteCode) continue;
    stats.partnerFlow++;

    // Доходит до клуба примерно каждый второй — это и есть узкое место воронки.
    if (Math.random() > 0.55) continue;

    const act = await call('POST', '/api/activate-invite', {
      headers: asStaff(), body: { code: inviteCode },
    });
    if (!act.ok) continue;
    if (act.data.wolfHand) stats.wolf++;

    const deal = await call('POST', '/api/deal', {
      headers: { 'X-Session-Id': act.data.sessionId, 'X-Device-Token': deviceToken },
    });
    if (!deal.ok) continue;
    stats.deals++;
    if (deal.data.prize) stats.prizes++;

    // Часть призов и сертификатов сразу гасится — иначе журнал выглядит мёртвым,
    // а у партнёров вечный ноль в строке «дошло до кассы».
    if (deal.data.prize && Math.random() < 0.7) {
      await call('POST', '/api/redeem', { headers: asStaff(), body: { code: deal.data.code, what: 'prize' } });
    }
    if (Math.random() < 0.35) {
      await call('POST', '/api/redeem', { headers: asStaff(), body: { code: deal.data.code, what: 'cert' } });
    }
  } else {
    const check = [2500, 2800, 3200, 5100, 4000, 2600, 7500][rnd(7)];
    const batch = await call('POST', '/api/session', {
      headers: asStaff(), body: { check, tableNo: String(1 + rnd(12)) },
    });
    if (!batch.ok) continue;
    stats.clubFlow++;

    const sessionId = batch.data.qrs[0].sessionId;
    const reg = await call('POST', '/api/registration', {
      headers: { 'X-Session-Id': sessionId },
      body: {
        name, phone, consentPd: true, consentAge: true,
        consentPartners: Math.random() < 0.7, consentMarketing: Math.random() < 0.5,
      },
    });
    if (!reg.ok) continue;

    const deal = await call('POST', '/api/deal', {
      headers: { 'X-Session-Id': sessionId, 'X-Device-Token': reg.data.deviceToken },
    });
    if (!deal.ok) continue;
    stats.deals++;
    if (deal.data.prize) stats.prizes++;

    if (deal.data.prize && Math.random() < 0.6) {
      await call('POST', '/api/redeem', { headers: asStaff(), body: { code: deal.data.code, what: 'prize' } });
    }
    if (Math.random() < 0.3) {
      await call('POST', '/api/redeem', { headers: asStaff(), body: { code: deal.data.code, what: 'cert' } });
    }
  }

  if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${COUNT}\r`);
}

console.log(`
Готово:
  через партнёров зарегистрировались   ${stats.partnerFlow}
  пришли в клуб по чеку                ${stats.clubFlow}
  сыграно раздач                       ${stats.deals}
  из них с материальным призом         ${stats.prizes}
  «рук волка»                          ${stats.wolf}

Витрина: ${BASE}/admin/ → маркетолог`);
