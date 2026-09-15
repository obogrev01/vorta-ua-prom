const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '256kb' }));

const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && !DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false,
  max: 5,
});

const STAFF = [
  { email: 'obogrev14@gmail.com', limit: 10, env: 'STAFF_PASSWORD_OBOGREV14' },
  { email: 'obogrev09@gmail.com', limit: 10, env: 'STAFF_PASSWORD_OBOGREV09' },
  { email: 'obogrev03@gmail.com', limit: 10, env: 'STAFF_PASSWORD_OBOGREV03' },
  { email: 'obogrev06@gmail.com', limit: 40, env: 'STAFF_PASSWORD_OBOGREV06' },
];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, expected] = String(stored).split(':');
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) {
    return false;
  }
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function signUser(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Потрібна авторизація' });
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Сесія закінчилась. Увійдіть знову.' });
  }
}

async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [normalizeEmail(email)]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getUsage(userId, date = todayUtc()) {
  const { rows } = await pool.query(
    'SELECT generations FROM daily_usage WHERE user_id = $1 AND usage_date = $2',
    [userId, date]
  );
  return Number(rows[0]?.generations || 0);
}

async function getUserStatus(user) {
  const used = await getUsage(user.id);
  return {
    used,
    dailyLimit: Number(user.daily_limit || 0),
    credits: Math.max(0, Number(user.daily_limit || 0) - used),
  };
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT 'staff',
      daily_limit INTEGER NOT NULL DEFAULT 10,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usage_date DATE NOT NULL,
      generations INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, usage_date)
    );

    CREATE TABLE IF NOT EXISTS generation_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      email TEXT NOT NULL,
      mode TEXT,
      target TEXT,
      source_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  for (const staff of STAFF) {
    const password = process.env[staff.env];
    if (!password) continue;
    const existing = await getUserByEmail(staff.email);
    if (!existing) {
      await pool.query(
        'INSERT INTO users (email, password_hash, plan, daily_limit) VALUES ($1, $2, $3, $4)',
        [staff.email, hashPassword(password), 'staff', staff.limit]
      );
    } else {
      await pool.query(
        'UPDATE users SET daily_limit = $1, plan = $2, active = TRUE WHERE id = $3',
        [staff.limit, 'staff', existing.id]
      );
    }
  }
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'vorta-ua-api' });
  } catch (_) {
    res.status(503).json({ ok: false, error: 'Database unavailable' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const user = await getUserByEmail(email);
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }
    const status = await getUserStatus(user);
    res.json({
      token: signUser(user),
      user: { email: user.email, plan: user.plan },
      credits: status.credits,
      dailyLimit: status.dailyLimit,
      usedToday: status.used,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

app.post('/auth/register', async (_req, res) => {
  res.status(403).json({ error: 'Самостійна реєстрація вимкнена для MVP' });
});

app.get('/auth/me', auth, async (req, res) => {
  try {
    const user = await getUserById(req.auth.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Користувача не знайдено' });
    const status = await getUserStatus(user);
    res.json({
      user: { email: user.email, plan: user.plan },
      credits: status.credits,
      dailyLimit: status.dailyLimit,
      usedToday: status.used,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

function buildPrompt(data, mode, target) {
  const needListing = mode === 'listing' || mode === 'both';
  const needSocial = mode === 'social' || mode === 'both';
  const platformName = target === 'prom' ? 'Prom.ua' : target === 'rozetka' ? 'Rozetka' : 'Prom.ua та Rozetka';
  const fields = [];

  if (needListing) fields.push(`
  "title": "Назва товару до 100 символів для ${platformName}, українською, з ключовими словами",
  "description": "Продаючий HTML-опис 400-700 символів українською. Абзаци через <br>. Живий текст що продає.",
  "price": "ціна числом або порожній рядок",
  "article": "артикул/SKU або порожній рядок",
  "category": "найточніша категорія для ${platformName} українською",
  "brand": "бренд товару або порожній рядок",
  "country": "країна виробника або порожній рядок",
  "characteristics": [{"name":"назва характеристики","value":"значення"}],
  "dimensions": {"width":"ширина в см або порожній рядок","height":"висота в см або порожній рядок","length":"довжина в см або порожній рядок","weight":"вага в кг або порожній рядок"},
  "seo_title": "SEO заголовок сторінки до 60 символів",
  "seo_description": "META description до 160 символів",
  "seo_tags": ["тег1","тег2","тег3","тег4","тег5","тег6","тег7","тег8"]`);

  if (needSocial) fields.push(`
  "instagram": "Instagram підпис з емодзі, хук + перевага + CTA, 150-220 символів",
  "facebook": "Facebook пост, 200-300 символів, закінчується питанням або CTA",
  "tiktok": "TikTok підпис, 80-120 символів",
  "hashtags": ["#хештег1","#хештег2","#хештег3","#хештег4","#хештег5","#хештег6","#хештег7","#хештег8","#хештег9","#хештег10"]`);

  return `Ти — експерт з e-commerce та маркетплейсів. Створи ПОВНУ картку товару для ${platformName}.
Весь контент УКРАЇНСЬКОЮ або РОСІЙСЬКОЮ відповідно до поля. Назви брендів/моделей залишай як є.

ВХІДНІ ДАНІ:
URL: ${data.url || ''}
Назва: ${data.title || 'Не вказано'}
Бренд: ${data.brand || 'Не вказано'}
Ціна: ${data.price || 'Не вказано'}
Артикул: ${data.sku || data.article || 'Не вказано'}
Категорія: ${data.category || 'Не вказано'}
Характеристики: ${(data.bullets || []).join(' | ') || 'Не вказано'}
Опис: ${(data.description || '').substring(0, 1200)}
Специфікації: ${(data.characteristics || []).slice(0, 15).join(' | ') || 'Не вказано'}
Габарити: ${data.dimensions ? JSON.stringify(data.dimensions) : 'Не знайдено'}
Вага: ${data.weight || 'Не вказано'}
Країна: ${data.country || 'Не вказано'}

Поверни ТІЛЬКИ валідний JSON без markdown:
{${fields.join(',')}}`;
}

function buildPrompt2(result) {
  return `Створи додаткові поля для картки товару на Prom.ua.
Назва (укр): ${result.title || ''}
Категорія: ${result.category || ''}
Бренд: ${result.brand || ''}
Артикул: ${result.article || ''}
Опис (укр): ${(result.description || '').replace(/<[^>]+>/g, '').substring(0, 500)}

Поверни ТІЛЬКИ валідний JSON без markdown:
{
  "title_ru": "Назва товару російською до 100 символів",
  "description_ru": "Продаючий опис російською 400-600 символів, абзаци через <br>",
  "html_title_ua": "SEO рядок до 100 символів",
  "html_title_ru": "SEO рядок російською до 100 символів",
  "html_desc_ua": "Короткий SEO-опис до 240 символів українською",
  "html_desc_ru": "Короткий SEO-опис до 240 символів російською",
  "seo_tags_ru": ["тег1","тег2","тег3","тег4","тег5","тег6","тег7","тег8"]
}`;
}

function parseJson(text) {
  const clean = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI повернув невалідний JSON');
  return JSON.parse(clean.slice(start, end + 1));
}

async function claude(prompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY не налаштований на Render');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Anthropic API ${response.status}`);
  return data?.content?.[0]?.text || '';
}

app.post('/generate', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const user = await getUserById(req.auth.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Користувача не знайдено' });

    const mode = ['listing', 'social', 'both'].includes(req.body.mode) ? req.body.mode : 'listing';
    const target = ['prom', 'rozetka', 'both'].includes(req.body.target) ? req.body.target : 'prom';
    const productData = req.body.productData && typeof req.body.productData === 'object' ? req.body.productData : null;
    if (!productData?.title) return res.status(400).json({ error: 'Не отримано дані товару' });

    const usageDate = todayUtc();
    await client.query('BEGIN');
    const usage = await client.query(
      `INSERT INTO daily_usage (user_id, usage_date, generations) VALUES ($1, $2, 0)
       ON CONFLICT (user_id, usage_date) DO UPDATE SET generations = daily_usage.generations
       RETURNING generations`,
      [user.id, usageDate]
    );
    const used = Number(usage.rows[0].generations);
    if (used >= user.daily_limit) {
      await client.query('ROLLBACK');
      return res.status(429).json({ error: `Денний ліміт вичерпано (${user.daily_limit} генерацій/день). Спробуй завтра.`, creditsLeft: 0 });
    }

    await client.query(
      'UPDATE daily_usage SET generations = generations + 1 WHERE user_id = $1 AND usage_date = $2',
      [user.id, usageDate]
    );
    await client.query('COMMIT');

    let result;
    try {
      result = parseJson(await claude(buildPrompt(productData, mode, target)));
      if (mode === 'listing' || mode === 'both') {
        try {
          const extra = parseJson(await claude(buildPrompt2(result)));
          result = { ...result, ...extra };
        } catch (e) {
          console.warn('Second prompt failed:', e.message);
        }
      }
    } catch (e) {
      await pool.query(
        'UPDATE daily_usage SET generations = GREATEST(generations - 1, 0) WHERE user_id = $1 AND usage_date = $2',
        [user.id, usageDate]
      );
      throw e;
    }

    await pool.query(
      'INSERT INTO generation_logs (user_id, email, mode, target, source_url) VALUES ($1, $2, $3, $4, $5)',
      [user.id, user.email, mode, target, String(productData.url || '').slice(0, 2000)]
    );

    const newUsed = used + 1;
    res.json({ result, creditsLeft: Math.max(0, user.daily_limit - newUsed), dailyLimit: user.daily_limit, usedToday: newUsed });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(e);
    res.status(500).json({ error: e.message || 'Помилка генерації' });
  } finally {
    client.release();
  }
});

app.post('/staff-log', auth, async (_req, res) => {
  res.json({ ok: true });
});

(async () => {
  try {
    await ensureSchema();
    app.listen(PORT, '0.0.0.0', () => console.log(`Vorta API listening on ${PORT}`));
  } catch (e) {
    console.error('Startup failed:', e);
    process.exit(1);
  }
})();
