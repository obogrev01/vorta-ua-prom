// Vorta UA — popup.js
// Модель: pay-per-use кредити, як у Kartka AI
// Admin mode: прямий API ключ для тестування

const $ = id => document.getElementById(id);
const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };

// ── CONFIG ────────────────────────────────────────────────────────────────
const API_BASE = 'https://your-app.railway.app'; // ← замінити після деплою

// ── Список працівників з безкоштовним доступом ───────────────────────────
const STAFF_EMAILS = [
  'obogrev14@gmail.com',
  'obogrev04@gmail.com',
  'obogrev06@gmail.com',
  'obogrev18@gmail.com'
];

function isStaff(email) {
  return STAFF_EMAILS.includes((email || '').toLowerCase().trim());
}

// ── Ліміт для працівників ─────────────────────────────────────────────────
const STAFF_DAILY_LIMIT = 50; // макс генерацій на день

async function getStaffUsageToday(email) {
  const key = `staff_usage_${email}_${new Date().toISOString().slice(0,10)}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || 0;
}

async function incrementStaffUsage(email) {
  const key = `staff_usage_${email}_${new Date().toISOString().slice(0,10)}`;
  const current = await getStaffUsageToday(email);
  await chrome.storage.local.set({ [key]: current + 1 });
  return current + 1;
}

async function checkStaffLimit(email) {
  const used = await getStaffUsageToday(email);
  if (used >= STAFF_DAILY_LIMIT) {
    throw new Error(`Денний ліміт вичерпано (${STAFF_DAILY_LIMIT} генерацій/день). Спробуй завтра.`);
  }
  return used;
}

// ── Відправка звіту адміну через EmailJS або webhook ─────────────────────
// Для MVP — зберігаємо лог локально + надсилаємо через бекенд
async function logStaffGeneration(email, mode, target, url) {
  // Локальний лог
  const logKey = 'staff_log';
  const stored = await chrome.storage.local.get(logKey);
  const log = stored[logKey] || [];
  log.push({
    email, mode, target, url,
    time: new Date().toISOString(),
    date: new Date().toLocaleDateString('uk-UA')
  });
  // Зберігаємо тільки останні 500 записів
  if (log.length > 500) log.splice(0, log.length - 500);
  await chrome.storage.local.set({ [logKey]: log });

  // Надсилаємо на бекенд (для email-звіту адміну)
  try {
    await fetch(`${API_BASE}/staff-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, mode, target, url, time: new Date().toISOString() })
    });
  } catch (_) {} // ігноруємо якщо бекенд недоступний
}

// Вартість кредитів (як у Kartka AI)
const CREDIT_COST = {
  prom:    { listing: 1, social: 0, both: 1 },   // ~$0.10/картка
  rozetka: { listing: 1, social: 0, both: 1 },   // ~$0.14/картка
  both:    { listing: 1, social: 0, both: 2 }    // ~$0.18/картка
};

const COST_LABELS = {
  prom:    { listing: '≈ 4 грн', social: '≈ 2 грн', both: '≈ 8 грн' },
  rozetka: { listing: '≈ 6 грн', social: '≈ 2 грн', both: '≈ 10 грн' },
  both:    { listing: '≈ 8 грн', social: '≈ 2 грн', both: '≈ 12 грн' }
};

let currentMode   = 'listing';
let currentTarget = 'prom';
let isAdmin       = false;
let lastResult    = null;
let seoTagsList   = [], hashtagsList = [];

// ── INIT ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Прив'язуємо showAdmin першим — незалежно від усього іншого
  const adminBtn = document.getElementById('showAdmin');
  if (adminBtn) {
    adminBtn.addEventListener('click', function() {
      document.getElementById('loginForm').style.display    = 'none';
      document.getElementById('registerForm').style.display = 'none';
      document.getElementById('adminForm').style.display    = 'block';
    });
  }

  setupTabs();
  setupTargetTabs();
  setupButtons();
  await initSession();
});

async function initSession() {
  const { vortaToken, adminApiKey } = await chrome.storage.local.get(['vortaToken', 'adminApiKey']);

  if (adminApiKey) {
    isAdmin = true;
    showLoggedIn({ email: 'Admin · Test Mode', plan: 'admin', credits: 9999 });
    await initPageInfo();
  } else if (vortaToken) {
    const ok = await loadUser(vortaToken);
    if (ok) await initPageInfo();
    else showAuthPanel();
  } else {
    showAuthPanel();
  }
}

// ── AUTH ──────────────────────────────────────────────────────────────────
function showAuthPanel() {
  $('authPanel').style.display  = 'block';
  $('userStrip').style.display  = 'none';
  $('pageStrip').style.display  = 'none';
  $('modeTabs').style.display   = 'none';
  const ss2 = $('sitesStrip'); if(ss2) ss2.style.display = 'none';
  $('targetTabs').style.display = 'none';
  $('genZone').style.display    = 'none';
}

async function showLoggedIn(user) {
  $('authPanel').style.display  = 'none';
  $('userStrip').style.display  = 'flex';
  $('pageStrip').style.display  = 'flex';
  $('modeTabs').style.display   = 'flex';
  const ss = $('sitesStrip'); if(ss) ss.style.display = 'block';
  $('targetTabs').style.display = 'flex';
  $('genZone').style.display    = 'block';

  const avatar = user.email[0].toUpperCase();
  set('userAvatar', avatar);
  set('userEmail',  user.email);

  const planEl = $('userPlan');
  // Перевіряємо чи це працівник
  const staffMode = isStaff(user.email);
  if (staffMode) {
    user.plan = 'staff';
    isAdmin = true; // використовує прямий API
    // Зберігаємо email для трекінгу
    await chrome.storage.local.set({ staffEmail: user.email });
    // Показуємо залишок денного ліміту
    const usedToday = await getStaffUsageToday(user.email);
    user.credits = STAFF_DAILY_LIMIT - usedToday;
  }

  const planNames = { free: 'БЕЗКОШТОВНИЙ', prom: 'PROM PRO', rozetka: 'ROZETKA PRO', combined: 'COMBINED PRO', admin: 'ADMIN', staff: '👥 ПРАЦІВНИК' };
  if (planEl) { planEl.textContent = planNames[user.plan] || user.plan.toUpperCase(); }

  updateCredits(user.credits);
}

function updateCredits(count) {
  set('creditsCount', isAdmin ? '∞' : (count || 0));
  const badge = $('creditsBadge');
  if (badge) badge.style.color = isAdmin ? 'var(--green)' : (count <= 0 ? 'var(--red)' : 'var(--acc)');
}

async function loadUser(token) {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return false;
    const d = await res.json();
    showLoggedIn({ email: d.user.email, plan: d.user.plan, credits: d.credits });
    return true;
  } catch { return false; }
}

// ── PAGE INFO ─────────────────────────────────────────────────────────────
async function initPageInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const domain = new URL(tab.url).hostname.replace('www.', '');
    set('pageDomain',  domain);
    set('pagePreview', (tab.title || '').substring(0, 55) || 'Відкрий сторінку товару');

    const icon  = $('pageIcon');
    const badge = $('sourceBadge');

    // Визначаємо джерело
    if (domain.includes('amazon.')) {
      if (icon) icon.textContent = '📦';
      if (badge) { badge.textContent = 'Amazon'; badge.className = 'source-badge badge-amazon'; badge.style.display = 'block'; }
    } else if (domain.includes('aliexpress.')) {
      if (icon) icon.textContent = '🟠';
      if (badge) { badge.textContent = 'AliExpress'; badge.className = 'source-badge badge-ali'; badge.style.display = 'block'; }
    } else if (domain.includes('ebay.')) {
      if (icon) icon.textContent = '🔵';
      if (badge) { badge.textContent = 'eBay'; badge.className = 'source-badge badge-ebay'; badge.style.display = 'block'; }
    } else {
      if (icon) icon.textContent = '🌐';
      if (badge) { badge.textContent = domain.split('.')[0]; badge.className = 'source-badge badge-other'; badge.style.display = 'block'; }
    }
  } catch {}
}

// ── TABS ──────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentMode = tab.dataset.mode;
      updateCostHint();
      const labels = { listing: 'ЗГЕНЕРУВАТИ КАРТКУ', social: 'ЗГЕНЕРУВАТИ ПОСТИ', both: 'ЗГЕНЕРУВАТИ ВСЕ' };
      set('btnLabel', labels[currentMode]);
    });
  });
}

function setupTargetTabs() {
  document.querySelectorAll('.target-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.target-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentTarget = tab.dataset.target;
      updateCostHint();
    });
  });
}

function updateCostHint() {
  const hint = $('costHint');
  if (!hint) return;
  if (isAdmin) { hint.innerHTML = 'Admin mode — безкоштовно'; return; }
  const cost = COST_LABELS[currentTarget]?.[currentMode] || '≈ 4 грн';
  hint.innerHTML = `Буде списано <strong>1 кредит</strong> (${cost})`;
}

// ── BUTTONS ───────────────────────────────────────────────────────────────
function setupButtons() {
  // Switch forms
  $('switchToRegister').addEventListener('click', () => {
    $('loginForm').style.display    = 'none';
    $('registerForm').style.display = 'block';
    $('adminForm').style.display    = 'none';
  });
  $('switchToLogin').addEventListener('click', () => {
    $('registerForm').style.display = 'none';
    $('loginForm').style.display    = 'block';
    $('adminForm').style.display    = 'none';
  });
  $('showAdmin').addEventListener('click', () => {
    $('loginForm').style.display    = 'none';
    $('registerForm').style.display = 'none';
    $('adminForm').style.display    = 'block';
  });
  $('switchToLogin2').addEventListener('click', () => {
    $('adminForm').style.display = 'none';
    $('loginForm').style.display = 'block';
  });

  // Login
  $('loginBtn').addEventListener('click', handleLogin);
  $('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });

  // Register
  $('registerBtn').addEventListener('click', handleRegister);

  // Admin
  $('adminBtn').addEventListener('click', handleAdminLogin);
  $('adminKey').addEventListener('keydown', e => { if (e.key === 'Enter') handleAdminLogin(); });

  // Logout
  $('logoutBtn').addEventListener('click', async () => {
    await chrome.storage.local.remove(['vortaToken', 'adminApiKey']);
    isAdmin = false;
    showAuthPanel();
    hideResults();
    $('loginForm').style.display    = 'block';
    $('registerForm').style.display = 'none';
    $('adminForm').style.display    = 'none';
  });

  // Generate
  $('genBtn').addEventListener('click', handleGenerate);

  // Buy credits
  $('buyBtn')?.addEventListener('click', () => chrome.tabs.create({ url: 'https://vorta.io/credits' }));
  $('pricingLink')?.addEventListener('click', () => chrome.tabs.create({ url: 'https://vorta.io/pricing' }));

  // Копіювати характеристики
  $('copyChars')?.addEventListener('click', () => {
    if (!lastResult?.characteristics) return;
    const text = lastResult.characteristics
      .map(c => c.name ? `${c.name}: ${c.value}` : String(c))
      .join('\n');
    copyText(text, $('copyChars'));
  });

  // Автозаповнення Prom.ua
  $('autofillBtn')?.addEventListener('click', handleAutofill);

  // Copy delegated
  document.addEventListener('click', e => {
    const cb = e.target.closest('[data-copy]');
    if (cb) { copyText($(cb.dataset.copy)?.textContent?.trim() || '', cb); return; }
    const tb = e.target.closest('[data-copy-tags]');
    if (tb) {
      const list = tb.dataset.copyTags === 'seoTags' ? seoTagsList : hashtagsList;
      copyText(list.join(', '), tb); return;
    }
    const tag = e.target.closest('.tag');
    if (tag) copyText(tag.textContent, tag);
  });

  $('copyListing')?.addEventListener('click', () => {
    if (!lastResult) return;
    copyText(`НАЗВА:\n${lastResult.title}\n\nОПИС:\n${lastResult.description}\n\nSEO ТЕГИ:\n${seoTagsList.join(', ')}`, $('copyListing'));
  });
  $('copySocial')?.addEventListener('click', () => {
    if (!lastResult) return;
    copyText(`INSTAGRAM:\n${lastResult.instagram}\n\nFACEBOOK:\n${lastResult.facebook}\n\nTIKTOK:\n${lastResult.tiktok}\n\nХЕШТЕГИ:\n${hashtagsList.join(' ')}`, $('copySocial'));
  });
}

// ── AUTH HANDLERS ─────────────────────────────────────────────────────────
async function handleLogin() {
  const email = ($('loginEmail').value || '').trim();
  const pass  = ($('loginPass').value  || '');
  if (!email || !pass) return showAuthErr('Введіть email і пароль', 'authError');

  $('loginBtn').disabled = true;
  $('loginBtn').textContent = 'Входжу...';
  try {
    const res  = await fetch(`${API_BASE}/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password: pass }) });
    const data = await res.json();
    if (!res.ok) return showAuthErr(data.error || 'Помилка входу', 'authError');
    await chrome.storage.local.set({ vortaToken: data.token });
    showLoggedIn({ email: data.user.email, plan: data.user.plan, credits: data.credits });
    await initPageInfo();
  } catch { showAuthErr('Помилка з\'єднання', 'authError'); }
  finally { $('loginBtn').disabled = false; $('loginBtn').textContent = 'УВІЙТИ'; }
}

async function handleRegister() {
  const email = ($('regEmail').value || '').trim();
  const pass  = ($('regPass').value  || '');
  if (!email || !pass) return showAuthErr('Введіть email і пароль', 'authErrorReg');
  if (pass.length < 8) return showAuthErr('Пароль мінімум 8 символів', 'authErrorReg');

  $('registerBtn').disabled = true;
  $('registerBtn').textContent = 'Реєструю...';
  try {
    const res  = await fetch(`${API_BASE}/auth/register`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password: pass }) });
    const data = await res.json();
    if (!res.ok) return showAuthErr(data.error || 'Помилка реєстрації', 'authErrorReg');
    await chrome.storage.local.set({ vortaToken: data.token });
    showLoggedIn({ email: data.user.email, plan: 'free', credits: 3 });
    await initPageInfo();
  } catch { showAuthErr('Помилка з\'єднання', 'authErrorReg'); }
  finally { $('registerBtn').disabled = false; $('registerBtn').textContent = 'ЗАРЕЄСТРУВАТИСЬ'; }
}

async function handleAdminLogin() {
  const key = ($('adminKey').value || '').trim();
  if (!key.startsWith('sk-ant-')) {
    return showAuthErr('Ключ має починатись з sk-ant-', 'authErrorAdmin');
  }
  await chrome.storage.local.set({ adminApiKey: key });
  isAdmin = true;
  showLoggedIn({ email: 'Admin · Test Mode', plan: 'admin', credits: 9999 });
  await initPageInfo();
}

function showAuthErr(msg, id) {
  const el = $(id); if (!el) return;
  el.style.display = 'block'; el.textContent = msg;
}

// ── GENERATE ──────────────────────────────────────────────────────────────
async function handleGenerate() {
  setLoading(true);
  hideError();
  hideResults();
  $('noCredits').style.display = 'none';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Відкрий сторінку товару');

    const url = tab.url || '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
      throw new Error('Перейди на сторінку товару (Amazon, AliExpress...) і натисни Generate');
    }

    // Зчитуємо дані зі сторінки — триплетний fallback
    // Перевірка ліміту для працівників
    const { adminApiKey } = await chrome.storage.local.get('adminApiKey');
    const currentEmail = (await chrome.storage.local.get('staffEmail')).staffEmail || '';
    if (!adminApiKey && isStaff(currentEmail)) {
      await checkStaffLimit(currentEmail); // кидає помилку якщо ліміт
    }

    let scraped = null;

    // Спроба 1: sendMessage до content.js
    try {
      scraped = await new Promise((res, rej) => {
        const timeout = setTimeout(() => rej(new Error('timeout')), 2000);
        chrome.tabs.sendMessage(tab.id, { action: 'scrapeProduct' }, r => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
          else if (r?.success && r.data?.title) res(r.data);
          else rej(new Error('no data'));
        });
      });
    } catch(_) {
      // Спроба 2: інжектуємо content.js і пробуємо знову
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        await new Promise(r => setTimeout(r, 600));
        scraped = await new Promise((res, rej) => {
          chrome.tabs.sendMessage(tab.id, { action: 'scrapeProduct' }, r => {
            if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
            else if (r?.success && r.data?.title) res(r.data);
            else rej(new Error('no data'));
          });
        });
      } catch(_2) {
        // Спроба 3: executeScript напряму
        const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageData });
        scraped = results?.[0]?.result;
      }
    }

    if (!scraped?.title) throw new Error('Не вдалось зчитати товар. Спробуй F5 на сторінці товару.');

    // Генеруємо
    let result;
    if (isAdmin) {
      const { adminApiKey, shopName: sn } = await chrome.storage.local.get(['adminApiKey','shopName']);
      result = await generateDirect(adminApiKey, scraped, sn || '');
    } else {
      const { vortaToken } = await chrome.storage.local.get('vortaToken');
      result = await generateViaBackend(vortaToken, scraped);
    }

    lastResult = result;
    const needListing = currentMode === 'listing' || currentMode === 'both';
    const needSocial  = currentMode === 'social'  || currentMode === 'both';
    if (needListing) renderListing(result);
    if (needSocial)  renderSocial(result);

    // Логуємо використання для працівників
    const { staffEmail: se } = await chrome.storage.local.get('staffEmail');
    if (se && isStaff(se)) {
      const used = await incrementStaffUsage(se);
      const remaining = STAFF_DAILY_LIMIT - used;
      // Показуємо залишок
      const badge = $('creditsBadge');
      if (badge) {
        set('creditsCount', remaining);
        if (remaining <= 10) badge.style.color = 'var(--gold)';
        if (remaining <= 0)  badge.style.color = 'var(--red)';
      }
      // Логуємо
      await logStaffGeneration(se, currentMode, currentTarget, tab.url || '');
    }

  } catch (err) {
    let msg = err.message || 'Невідома помилка';
    if (msg.includes('402') || msg.includes('credits')) {
      $('noCredits').style.display = 'block'; return;
    }
    if (msg.includes('401')) msg = 'Сесія закінчилась. Увійдіть знову.';
    showError(msg);
  } finally {
    setLoading(false);
  }
}

// ── DIRECT CLAUDE (Admin) ─────────────────────────────────────────────────
async function generateDirect(apiKey, data, shopName) {
  // Запит 1: основні поля (назва, опис укр, SEO, характеристики, габарити)
  const prompt1 = buildPrompt(data, currentMode, currentTarget, shopName);
  const resp1 = await claudeCall(apiKey, prompt1);
  const result = parseResult(resp1);

  // Запит 2: HTML заголовки + рос версії (тільки для listing режиму)
  const needListing = currentMode === 'listing' || currentMode === 'both';
  if (needListing) {
    try {
      const prompt2 = buildPrompt2(data, result, shopName);
      const resp2 = await claudeCall(apiKey, prompt2);
      const result2 = parseResult2(resp2);
      Object.assign(result, result2);
    } catch(e) {
      console.log('Prompt 2 failed:', e.message);
    }
  }

  return result;
}

async function claudeCall(apiKey, prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    if (resp.status === 401) throw new Error('Невірний API ключ. Натисни "Змінити ключ".');
    if (resp.status === 429) throw new Error('Rate limit — зачекай хвилину і спробуй знову.');
    throw new Error(`API ${resp.status}: ${e?.error?.message || ''}`);
  }
  const d = await resp.json();
  return d.content?.[0]?.text || '';
}



// ── VIA BACKEND (Users) ───────────────────────────────────────────────────
async function generateViaBackend(token, data) {
  const resp = await fetch(`${API_BASE}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ productData: data, mode: currentMode, target: currentTarget })
  });
  const d = await resp.json();
  if (resp.status === 402) throw new Error('credits');
  if (!resp.ok) throw new Error(d.error || 'Помилка генерації');
  updateCredits(d.creditsLeft);
  return d.result;
}

// ── PROMPT ────────────────────────────────────────────────────────────────
function buildPrompt(data, mode, target, shopName) {
  const needListing = mode === 'listing' || mode === 'both';
  const needSocial  = mode === 'social'  || mode === 'both';
  const platformName = target === 'prom' ? 'Prom.ua' : target === 'rozetka' ? 'Rozetka' : 'Prom.ua та Rozetka';
  const shop = shopName || '[Назва магазину]';

  const listingFields = `
  "title": "Назва товару до 100 символів для ${platformName}, українською, з ключовими словами",
  "description": "Продаючий HTML-опис 400-700 символів українською. Абзаци через <br>. Живий текст що продає.",
  "price": "ціна числом (тільки цифри, без валюти) або порожній рядок",
  "article": "артикул/SKU товару або порожній рядок",
  "category": "найточніша категорія для ${platformName} українською",
  "brand": "бренд товару або порожній рядок",
  "country": "країна виробника або порожній рядок",
  "characteristics": [{"name": "назва характеристики", "value": "значення"}],
  "dimensions": {
    "width":  "ширина в см або порожній рядок",
    "height": "висота в см або порожній рядок",
    "length": "довжина в см або порожній рядок",
    "weight": "вага в кг або порожній рядок"
  },
  "description_ru": "Повний продаючий опис РОСІЙСЬКОЮ мовою 400-700 символів. Абзаци через <br>. Переклад і адаптація укр опису. НЕ копіювати укр текст.",
  "html_title_ua": "${shop}: купити [Назву товару скорочено] за найкращою ціною. [Категорія] від [Бренд] - [Артикул]. Рядок до 100 символів.",
  "html_title_ru": "Аналог html_title_ua але російською мовою. [Назва магазину по-русски якщо відомо]. Рядок до 100 символів.",
  "html_desc_ua": "Короткий HTML-опис до 240 символів українською для SEO. Без тегів.",
  "html_desc_ru": "Аналог html_desc_ua але російською мовою. До 240 символів.",
  "seo_title": "SEO заголовок сторінки до 60 символів",
  "seo_description": "META description до 160 символів",
  "seo_tags": ["тег1","тег2","тег3","тег4","тег5","тег6","тег7","тег8"]`;

  const socialFields = `
  "instagram": "Instagram підпис з емодзі, хук + перевага + CTA, 150-220 символів",
  "facebook": "Facebook пост, розмовний тон, 200-300 символів, закінчується питанням або CTA",
  "tiktok": "TikTok підпис, динамічний, 80-120 символів",
  "hashtags": ["#хештег1","#хештег2","#хештег3","#хештег4","#хештег5","#хештег6","#хештег7","#хештег8","#хештег9","#хештег10"]`;

  const fields = [];
  if (needListing) fields.push(listingFields);
  if (needSocial)  fields.push(socialFields);

  return `Ти — експерт з e-commerce та маркетплейсів. Створи ПОВНУ картку товару для ${platformName}.
Весь контент УКРАЇНСЬКОЮ або РОСІЙСЬКОЮ відповідно до поля. Назви брендів/моделей залишай як є.
Назва магазину: "${shop}"

ВХІДНІ ДАНІ:
URL: ${data.url}
Назва: ${data.title || 'Не вказано'}
Бренд: ${data.brand || 'Не вказано'}
Ціна: ${data.price || 'Не вказано'}
Артикул: ${data.sku || data.article || 'Не вказано'}
Категорія: ${data.category || 'Не вказано'}
Характеристики: ${(data.bullets || []).join(' | ') || 'Не вказано'}
Опис: ${(data.description || '').substring(0, 600)}
Специфікації: ${(data.characteristics || []).slice(0, 10).join(' | ') || 'Не вказано'}
Габарити зі сторінки: ${data.dimensions ? JSON.stringify(data.dimensions) : 'Не знайдено'}
Вага: ${data.weight || 'Не вказано'}
Країна: ${data.country || 'Не вказано'}

Поверни ТІЛЬКИ валідний JSON без markdown:
{${fields.join(',\n')}}`;
}

function buildPrompt2(data, result1, shopName) {
  const shop = shopName || '[Назва магазину]';
  const title = result1.title || data.title || '';
  const category = result1.category || data.category || '';
  const brand = result1.brand || data.brand || '';
  const article = result1.article || data.sku || '';
  const descUa = result1.description || '';

  return `Створи додаткові поля для картки товару на Prom.ua.
Назва магазину: "${shop}"

ДАНІ ТОВАРУ:
Назва (укр): ${title}
Категорія: ${category}
Бренд: ${brand}
Артикул: ${article}
Опис (укр, вже є): ${descUa.replace(/<[^>]+>/g,'').substring(0,300)}

Поверни ТІЛЬКИ валідний JSON без markdown:
{
  "title_ru": "Назва товару РОСІЙСЬКОЮ до 100 символів. Переклад укр назви. Технічні назви не перекладати.",
  "description_ru": "Повний продаючий опис РОСІЙСЬКОЮ мовою 400-600 символів. Абзаци через <br>. Переклад укр опису. Не копіювати укр текст.",
  "html_title_ua": "Рядок до 100 символів: ${shop}: купити [назва товару коротко] за найкращою ціною. [категорія] від [бренд] - [артикул]",
  "html_title_ru": "Аналог html_title_ua але ПОВНІСТЮ РОСІЙСЬКОЮ. Назву магазину перекласти якщо потрібно.",
  "html_desc_ua": "Короткий SEO-опис до 240 символів українською. Без HTML тегів. Ключові переваги товару.",
  "html_desc_ru": "Аналог html_desc_ua але ПОВНІСТЮ РОСІЙСЬКОЮ. До 240 символів.",
  "seo_tags_ru": ["тег1","тег2","тег3","тег4","тег5","тег6","тег7","тег8"]
}`;
}

function parseResult2(text) {
  try {
    const clean = text.replace(/```json/g,'').replace(/```/g,'').trim();
    const j = JSON.parse(clean);
    return {
      title_ru:       j.title_ru       || '',
      description_ru: j.description_ru || '',
      html_title_ua:  j.html_title_ua  || '',
      html_title_ru:  j.html_title_ru  || '',
      html_desc_ua:   j.html_desc_ua   || '',
      html_desc_ru:   j.html_desc_ru   || '',
      seo_tags_ru:    Array.isArray(j.seo_tags_ru) ? j.seo_tags_ru : [],
    };
  } catch(e) {
    console.log('parseResult2 error:', e.message, text.substring(0,100));
    return {};
  }
}


// ── EXTRACT PAGE DATA (runs on tab) ──────────────────────────────────────
function extractPageData() {
  const get = sels => {
    for (const s of sels) {
      try {
        const el = document.querySelector(s);
        if (el) {
          const t = el.tagName === 'META' ? el.getAttribute('content') : el.textContent;
          if (t && t.trim().length > 1) return t.trim();
        }
      } catch(_) {}
    }
    return '';
  };

  const getAll = sels => {
    for (const s of sels) {
      try {
        const els = document.querySelectorAll(s);
        if (els.length) return Array.from(els).map(e => e.textContent.trim()).filter(t => t.length > 1);
      } catch(_) {}
    }
    return [];
  };

  // Базові поля
  const title = get(['#productTitle','h1.product-title-text','h1[itemprop="name"]','.product__name','h1']);
  const brand = get(['#bylineInfo','#brand','[itemprop="brand"]','.product-brand','.brand-name']);
  const price = get(['.a-price .a-offscreen','#priceblock_ourprice','[itemprop="price"]','.product-price__price','.price-value','.price']);
  const rating = get(['#acrPopover','[itemprop="ratingValue"]','.rating-value']);

  // Артикул
  const sku = get([
    '[itemprop="sku"]','[data-sku]','.product-article','.sku',
    '#ASIN','[data-asin]','.articul'
  ]) || (() => {
    const text = document.body.innerText;
    const m = text.match(/(?:артикул|sku|код товару|арт\.?)[:\s]+([A-Za-z0-9\-_]+)/i);
    return m ? m[1] : '';
  })();

  // Опис
  const desc = get([
    '#productDescription p','#aplus p','.product-description',
    '[itemprop="description"]','.product__description',
    '.description-content','meta[name="description"]'
  ]);

  // Bullets / features
  const bullets = [];
  document.querySelectorAll('#feature-bullets li span:not(.aok-hidden), .product-features li, .product__features li').forEach(el => {
    const t = el.textContent.trim();
    if (t && t.length > 5 && t.length < 300) bullets.push(t);
  });

  // Характеристики — таблиці
  const characteristics = [];
  document.querySelectorAll([
    '#productDetails_techSpec_section_1 tr',
    '#detailBullets_feature_div li',
    '.product-specs tr',
    '.characteristics tr',
    '.product__characteristics tr',
    'table.product-table tr',
    '.specs-table tr'
  ].join(',')).forEach(row => {
    const cells = row.querySelectorAll('td, th');
    if (cells.length >= 2) {
      const k = cells[0].textContent.replace(/[‎‏:]/g,'').trim();
      const v = cells[1].textContent.trim();
      if (k && v && k.length < 80) characteristics.push(`${k}: ${v}`);
    } else {
      const t = row.textContent.replace(/\s+/g,' ').trim();
      if (t && t.includes(':') && t.length < 200) characteristics.push(t);
    }
  });

  // Габарити — парсимо з тексту характеристик
  const dims = { width: '', height: '', length: '', weight: '' };
  const allText = characteristics.join(' ') + ' ' + desc + ' ' + bullets.join(' ');

  const mW = allText.match(/(?:ширина|width)[:\s]+([0-9.,]+)\s*(?:см|mm|cm)?/i);
  const mH = allText.match(/(?:висота|height)[:\s]+([0-9.,]+)\s*(?:см|mm|cm)?/i);
  const mL = allText.match(/(?:довжина|глибина|length|depth)[:\s]+([0-9.,]+)\s*(?:см|mm|cm)?/i);
  const mWt = allText.match(/(?:вага|weight|маса)[:\s]+([0-9.,]+)\s*(?:кг|г|kg|g)?/i);
  if (mW) dims.width  = mW[1];
  if (mH) dims.height = mH[1];
  if (mL) dims.length = mL[1];
  if (mWt) dims.weight = mWt[1];

  // Матеріал
  const material = (() => {
    const m = allText.match(/(?:матеріал|material)[:\s]+([^,;.]+)/i);
    return m ? m[1].trim().substring(0,50) : '';
  })();

  // Країна
  const country = get([
    '[itemprop="countryOfOrigin"]',
    '.product-country',
    '.origin'
  ]) || (() => {
    const m = allText.match(/(?:країна|виробник|country)[:\s]+([^,;.]{2,30})/i);
    return m ? m[1].trim() : '';
  })();

  // Категорія з breadcrumbs
  const cats = [];
  document.querySelectorAll('#wayfinding-breadcrumbs_feature_div a,.breadcrumb a,[itemprop="breadcrumb"] a,.breadcrumbs a,.breadcrumbs__item').forEach(a => {
    const t = a.textContent.trim();
    if (t && t.length > 1 && t.length < 60) cats.push(t);
  });

  // Зображення
  const images = [];
  document.querySelectorAll('#landingImage,[data-old-hires],#imgTagWrapperId img,.product-gallery img,.product__images img').forEach(img => {
    const src = img.getAttribute('data-old-hires') || img.getAttribute('data-zoom-src') || img.getAttribute('src');
    if (src && src.startsWith('http') && !images.includes(src)) images.push(src);
  });

  return {
    url:   window.location.href,
    domain: window.location.hostname,
    title:  title.substring(0, 300),
    brand:  brand.replace(/^(Brand:|Visit the|Store)/i,'').trim(),
    price:  price.replace(/[^\d.,]/g,'').trim(),
    rating, sku,
    bullets: bullets.slice(0, 7),
    description: desc.substring(0, 1000),
    characteristics: characteristics.slice(0, 15),
    dimensions: dims,
    material, country,
    category: cats.join(' > '),
    images: images.slice(0, 5)
  };
}

// ── PARSE RESULT ──────────────────────────────────────────────────────────
function parseResult(text) {
  try {
    const j = JSON.parse(text.replace(/```json\n?|```\n?/g,'').trim());
    return {
      // Listing fields
      title:           j.title           || '',
      title_ru:        j.title_ru        || '',
      description:     j.description     || '',
      description_ru:  j.description_ru  || '',
      price:           j.price           || '',
      article:         j.article         || '',
      category:        j.category        || '',
      brand:           j.brand           || '',
      country:         j.country         || '',
      characteristics: Array.isArray(j.characteristics) ? j.characteristics : [],
      dimensions:      j.dimensions      || { width:'', height:'', length:'', weight:'' },
      package:         j.package         || '',
      seo_title:       j.seo_title       || '',
      seo_description: j.seo_description || '',
      seo_tags:        Array.isArray(j.seo_tags) ? j.seo_tags : [],
      seo_tags_ru:     [],
      // Social fields
      instagram:       j.instagram       || '',
      facebook:        j.facebook        || '',
      tiktok:          j.tiktok          || '',
      hashtags:        Array.isArray(j.hashtags) ? j.hashtags : []
    };
  } catch(e) {
    throw new Error('Помилка розбору відповіді AI. Спробуй ще раз.');
  }
}

// ── RENDER ────────────────────────────────────────────────────────────────
function renderListing(r) {
  // Назва
  set('titleOut', r.title);
  const tl = r.title.length;
  const tc = $('titleCount');
  if (tc) { tc.textContent = `${tl} / 100 символів`; tc.className = 'char-line' + (tl > 100 ? ' warn' : ''); }

  // Опис
  set('descOut', r.description.replace(/<br\s*\/?>/gi, '\n'));
  const dc = $('descCount');
  if (dc) dc.textContent = `${r.description.length} символів`;

  // Ціна та артикул
  set('priceOut',   r.price   || '—');
  set('articleOut', r.article || '—');
  set('categoryOut',r.category|| '—');
  set('brandOut',   r.brand   || '—');
  set('countryOut', r.country || '—');

  // Габарити
  const d = r.dimensions || {};
  set('dimWidth',  d.width  || '—');
  set('dimHeight', d.height || '—');
  set('dimLength', d.length || '—');
  set('dimWeight', d.weight || '—');

  // Комплектація
  set('packageOut', r.package || '—');

  // SEO
  set('seoTitleOut', r.seo_title       || '—');
  set('seoDescOut',  r.seo_description || '—');

  // Характеристики
  const charsContainer = $('charsOut');
  if (charsContainer) {
    charsContainer.innerHTML = '';
    (r.characteristics || []).forEach(c => {
      const row = document.createElement('div');
      row.className = 'char-row';
      const parts = c.name ? [c.name, c.value] : (typeof c === 'string' ? c.split(':') : [String(c), '']);
      const key = (parts[0] || '').trim();
      const val = (parts.slice(1).join(':') || '').trim();
      row.innerHTML = `<span class="char-key">${key}</span><span class="char-val">${val}</span>`;
      charsContainer.appendChild(row);
    });
  }

  // SEO теги
  seoTagsList = r.seo_tags || [];
  renderTags('seoTags', seoTagsList);

  const lr = $('listingResults'); if (lr) lr.style.display = 'block';
}

function renderSocial(r) {
  set('igOut', r.instagram);
  set('fbOut', r.facebook);
  set('ttOut', r.tiktok);
  hashtagsList = r.hashtags || [];
  renderTags('hashtagsOut', hashtagsList);
  const sr = $('socialResults'); if (sr) sr.style.display = 'block';
}

function renderTags(id, tags) {
  const c = $(id); if (!c) return;
  c.innerHTML = '';
  tags.forEach(t => {
    const s = document.createElement('span');
    s.className = 'tag'; s.textContent = t; c.appendChild(s);
  });
}

// ── AUTOFILL PROM.UA ─────────────────────────────────────────────────────
async function handleAutofill() {
  if (!lastResult) { showError('Спочатку згенеруй картку'); return; }

  const btn = $('autofillBtn');
  const data = lastResult;

  // Шукаємо вже відкриту вкладку Prom.ua
  const allTabs = await chrome.tabs.query({});
  const promTab = allTabs.find(t =>
    t.url && (t.url.includes('my.prom.ua/cms/product') || t.url.includes('my.prom.ua/cabinet/product'))
  );

  if (!promTab) {
    // Немає вкладки — просто відкриваємо, дані заповнимо коли користувач натисне знову
    await chrome.tabs.create({ url: 'https://my.prom.ua/cms/product/create' });
    showError('Форма відкрита! Зачекай 3-5 секунд поки завантажиться, потім натисни кнопку ще раз.');
    return;
  }

  // Є вкладка — заповнюємо
  if (btn) { btn.textContent = '⏳ Заповнюю...'; btn.disabled = true; }

  try {
    // Інжектуємо скрипт напряму з даними як аргумент — не потрібен listener
    const results = await chrome.scripting.executeScript({
      target: { tabId: promTab.id },
      world: 'MAIN',
      func: async (d) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        function fillReact(el, value) {
          if (!el || !value) return false;
          try {
            const proto = el.tagName === 'TEXTAREA'
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value');
            if (setter?.set) setter.set.call(el, String(value));
            else el.value = String(value);
          } catch(_) { el.value = String(value); }
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.blur();
          return true;
        }

        const allInp = Array.from(document.querySelectorAll('input'));
        const allTa  = Array.from(document.querySelectorAll('textarea'));
        let filled = 0;

        // 1. Код/Артикул — перший input[type=text] з класом base__input без placeholder
        const articleEl = allInp.find(el =>
          el.type === 'text' &&
          el.className.includes('base__input') &&
          !el.placeholder
        );
        if (d.article && articleEl && fillReact(articleEl, d.article)) filled++;
        await sleep(150);

        // 2. Назва укр + рос — обидва inputs з placeholder H&M
        const nameEls = allInp.filter(el => el.placeholder && el.placeholder.includes('H&M жіноча сукня'));
        const nameUa = nameEls[0];
        const nameRu = nameEls[1];
        if (d.title && nameUa && fillReact(nameUa, d.title)) filled++;
        // Назва рос — перекладена назва або транслітерація
        const titleRu = d.title_ru || d.title || '';
        if (titleRu && nameRu && fillReact(nameRu, titleRu)) filled++;
        await sleep(150);

        // 3. Ціна — placeholder="0"
        const priceEl = allInp.find(el => el.placeholder === '0');
        if (d.price && priceEl && fillReact(priceEl, d.price)) filled++;
        await sleep(100);

        // 4. Залишки (placeholder="-") — НЕ чіпаємо, пропускаємо

        // 5. Габарити — парсимо з characteristics якщо dimensions порожні
        const dims = d.dimensions || {};
        // Fallback: шукаємо в характеристиках
        // Fallback: шукаємо габарити в characteristics (тільки явні розмірні поля)
        if (Array.isArray(d.characteristics)) {
          for (const c of d.characteristics) {
            const str = (typeof c === 'string' ? c : c.name + ': ' + c.value).toLowerCase();
            // Шукаємо ТІЛЬКИ якщо є одиниці виміру мм/см/м або явні назви
            if (!dims.width  && /(?:^|[^а-яa-z])(?:ширина|width)[^:]*:\s*([\d.,]+)\s*(?:мм|mm|см|cm|м|m)/i.test(str)) {
              dims.width = str.match(/(?:ширина|width)[^:]*:\s*([\d.,]+)/i)?.[1];
            }
            if (!dims.height && /(?:^|[^а-яa-z])(?:висота|height)[^:]*:\s*([\d.,]+)\s*(?:мм|mm|см|cm|м|m)/i.test(str)) {
              dims.height = str.match(/(?:висота|height)[^:]*:\s*([\d.,]+)/i)?.[1];
            }
            if (!dims.length && /(?:^|[^а-яa-z])(?:довжина|глибина|length|depth)[^:]*:\s*([\d.,]+)\s*(?:мм|mm|см|cm|м|m)/i.test(str)) {
              dims.length = str.match(/(?:довжина|глибина|length|depth)[^:]*:\s*([\d.,]+)/i)?.[1];
            }
            if (!dims.weight && /(?:вага|маса|weight)[^:]*:\s*([\d.,]+)\s*(?:кг|г|kg|g)/i.test(str)) {
              dims.weight = str.match(/(?:вага|маса|weight)[^:]*:\s*([\d.,]+)/i)?.[1];
            }
          }
        }
        for (const [ph, val] of [
          ['Ширина, см', dims.width],
          ['Висота, см', dims.height],
          ['Довжина, см', dims.length],
          ['Вага, кг',   dims.weight],
        ]) {
          const el = allInp.find(i => i.placeholder === ph);
          if (val && el && fillReact(el, val)) filled++;
          await sleep(50);
        }

        // 6. SEO теги укр та рос
        const allSeoEls = Array.from(document.querySelectorAll('input')).filter(el =>
          el.className && el.className.includes('styles__input') &&
          el.placeholder && el.placeholder.includes('Додайте')
        );
        const seoEl = allSeoEls[0];    // укр
        const seoElRu = allSeoEls[1];  // рос

        // Заповнюємо рос SEO теги
        if (seoElRu && d.seo_tags_ru && d.seo_tags_ru.length) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          for (const tag of d.seo_tags_ru.slice(0, 10)) {
            seoElRu.focus();
            if (setter?.set) setter.set.call(seoElRu, tag);
            else seoElRu.value = tag;
            seoElRu.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(80);
            seoElRu.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
            seoElRu.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
            await sleep(120);
          }
          seoElRu.blur();
          filled++;
        }

        // Оригінальний SEO укр selector
        if (seoEl && d.seo_tags && d.seo_tags.length) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          for (const tag of d.seo_tags.slice(0, 10)) {
            seoEl.focus();
            if (setter && setter.set) setter.set.call(seoEl, tag);
            else seoEl.value = tag;
            seoEl.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(150);
            seoEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
            seoEl.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
            await sleep(200);
          }
          filled++;
        }
        await sleep(300);

        // 7. Опис (Українська) — CKEditor (перший екземпляр = укр)
        if (d.description && typeof CKEDITOR !== 'undefined') {
          const instances = Object.values(CKEDITOR.instances);
          const descInstance = instances[0]; // перший = українська
          if (descInstance) {
            const clean = d.description.replace(/<br\s*\/?>/gi, '<br>').replace(/\n/g, '<br>');
            try {
              descInstance.setData(clean);
              descInstance.fire('change');
              filled++;
            } catch(e) { console.log('CKEditor error:', e); }
          }
        }
        await sleep(200);

        // 8. CKEditor[1] — повний російський опис (окремо згенерований)
        if (typeof CKEDITOR !== 'undefined') {
          const instances = Object.values(CKEDITOR.instances);
          if (instances[1] && d.description_ru) {
            try {
              const clean = d.description_ru.replace(/<br\s*\/?>/gi, '<br>').replace(/\n/g, '<br>');
              instances[1].setData(clean);
              instances[1].fire('change');
              filled++;
            } catch(e) {}
          }
        }

        // 9. Textarea (Нотатки, HTML-опис) — React блокує програмне заповнення
        // Показуємо floating панель з кнопками для ручного копіювання
        const shortDesc = d.description
          ? d.description.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').substring(0, 240)
          : '';

        // Створюємо floating helper панель
        document.getElementById('vorta-helper')?.remove();
        const helper = document.createElement('div');
        helper.id = 'vorta-helper';
        helper.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;background:#0F1318;border:1px solid #252D3A;border-radius:12px;padding:16px;width:320px;font-family:sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.5)';
        // 10. Характеристики категорії Prom.ua
        if (d.characteristics && d.characteristics.length > 0) {
          const charBlocks = Array.from(document.querySelectorAll('.b-product-edit__characteristic'));

          for (const charBlock of charBlocks) {
            const labelEl = charBlock.querySelector('[data-qaid="name_field"]');
            if (!labelEl) continue;
            const label = labelEl.textContent.trim().toLowerCase();
            const parent = charBlock.parentElement;

            // Пошук значення для поля Prom.ua
            let matchVal = '';
            const srcText = [
              d.title || '',
              d.description ? d.description.replace(/<[^>]+>/g,'') : '',
              ...(d.bullets || []),
              ...(Array.isArray(d.characteristics) ? d.characteristics.map(c => typeof c==='string'?c:(c.name+': '+c.value)) : [])
            ].join(' ');

            // Точне зіставлення по назві поля Prom.ua
            if (label === 'виробник' || label === 'бренд') {
              matchVal = d.brand || '';
            } else if (label.startsWith('країна')) {
              matchVal = d.country || '';
            } else if (label.includes('ємність акумулятор')) {
              const m = srcText.match(/(\d{2,4})\s*(?:Ач|ах|ah)/i);
              if (m) matchVal = m[1];
            } else if (label.includes('напрацювання') || label.includes('цикл')) {
              const m = srcText.match(/(\d{3,5})\+?\s*(?:цикл|cycle)/i);
              if (m) matchVal = m[1];
            } else if (label.includes('напруга')) {
              // Тільки з назви товару — 3.2V, 3.7V тощо
              const m = (d.title||'').match(/(\d+[.,]\d+)\s*[Vv]/);
              if (m) matchVal = m[1].replace(',','.');
              else {
                const m2 = srcText.match(/(?:напруга|voltage)[^\d]*(\d+[.,]\d+)/i);
                if (m2) matchVal = m2[1].replace(',','.');
              }
            } else if (label.includes('струм заряду')) {
              const m = srcText.match(/(?:струм|current|charge)[^\d]*(\d+[.,]?\d*)\s*[Аa]/i);
              if (m) matchVal = m[1];
            } else if (label.includes('мінімальна') && label.includes('темп')) {
              const m = srcText.match(/-(\d+)\s*°?[CcСс]/);
              if (m) matchVal = '-' + m[1];
            } else if (label.includes('максимальна') && label.includes('темп')) {
              const temps = [...srcText.matchAll(/[+]?(\d{2,3})\s*°?[CcСс]/g)].map(m=>parseInt(m[1]));
              if (temps.length) matchVal = String(Math.max(...temps));
            } else if (label.includes('гарантійний')) {
              const m = srcText.match(/гарант[^\d]*(\d+)\s*(?:міс|month|рік|year)/i);
              if (m) matchVal = label.includes('рік') ? m[1] : m[1];
            } else if (label.includes('стан')) {
              matchVal = 'Новий';
            } else if (label.includes('довжина') && label.includes('мм')) {
              // Габарити в мм — конвертуємо зі см якщо потрібно
              const v = d.dimensions?.length;
              if (v) matchVal = String(parseFloat(v) > 100 ? Math.round(parseFloat(v)) : Math.round(parseFloat(v)*10));
            } else if (label.includes('висота') && label.includes('мм')) {
              const v = d.dimensions?.height;
              if (v) matchVal = String(parseFloat(v) > 100 ? Math.round(parseFloat(v)) : Math.round(parseFloat(v)*10));
            } else if (label.includes('ширина') && label.includes('мм')) {
              const v = d.dimensions?.width;
              if (v) matchVal = String(parseFloat(v) > 100 ? Math.round(parseFloat(v)) : Math.round(parseFloat(v)*10));
            } else if (label === 'вага (кг)' || label.startsWith('вага')) {
              matchVal = d.dimensions?.weight || '';
            }

            if (!matchVal) continue;

            const hasDropdown = !!parent.querySelector('.b-drop-down');
            const inputEl = parent.querySelector('input[type="text"]:not([data-qaid="search_value_field"])');

            if (inputEl && !hasDropdown) {
              // Звичайний input
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
              if (setter?.set) setter.set.call(inputEl, matchVal);
              else inputEl.value = matchVal;
              inputEl.dispatchEvent(new Event('input',  { bubbles: true }));
              inputEl.dispatchEvent(new Event('change', { bubbles: true }));
              filled++;
              await sleep(50);

            } else if (hasDropdown) {
              // Dropdown — відкриваємо і шукаємо збіг
              const ddVal = parent.querySelector('.b-drop-down__value');
              if (!ddVal) continue;

              ddVal.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              ddVal.dispatchEvent(new MouseEvent('click',     { bubbles: true }));
              await sleep(800);

              // Вводимо в пошук
              const searchInput = parent.querySelector('[data-qaid="search_value_field"]');
              if (searchInput) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                if (setter?.set) setter.set.call(searchInput, matchVal);
                else searchInput.value = matchVal;
                searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                await sleep(800);
              }

              // Клікаємо перший збіг у списку
              const list = parent.querySelector('.b-drop-down__list');
              const firstItem = list?.querySelector('.b-drop-down__list-item');
              if (firstItem) {
                firstItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                firstItem.dispatchEvent(new MouseEvent('click',     { bubbles: true }));
                filled++;
                await sleep(300);
              } else {
                // Закриваємо dropdown якщо нічого не знайдено
                document.body.click();
                await sleep(200);
              }
            }
          }
        }
        await sleep(200);

        // Floating helper — поля що не можна заповнити програмно
        const helperRows = [];

        // HTML-заголовок укр
        if (d.html_title_ua) helperRows.push({ label: 'HTML-заголовок (укр):', val: d.html_title_ua, id: 'vht-ua' });
        // HTML-заголовок рос
        if (d.html_title_ru) helperRows.push({ label: 'HTML-заголовок (рос):', val: d.html_title_ru, id: 'vht-ru' });
        // HTML-опис укр
        if (shortDesc) helperRows.push({ label: 'HTML-опис (укр, до 240 симв):', val: shortDesc, id: 'vhd-ua', rows: 2 });
        // HTML-опис рос
        if (d.html_desc_ru) helperRows.push({ label: 'HTML-опис (рос):', val: d.html_desc_ru, id: 'vhd-ru', rows: 2 });
        // Рос опис (якщо не заповнився CKEditor)
        if (d.description_ru && !Object.values((typeof CKEDITOR!=='undefined'?CKEDITOR.instances:{})).find(i=>i.getData().length>10)) {
          helperRows.push({ label: 'Опис (рос) — вставити в CKEditor:', val: d.description_ru, id: 'vdesc-ru', rows: 4 });
        }
        // Габарити
        const dims2 = d.dimensions || {};
        const dimParts = [
          dims2.width  ? 'Ширина: '  + dims2.width  + ' см' : '',
          dims2.height ? 'Висота: '  + dims2.height + ' см' : '',
          dims2.length ? 'Довжина: ' + dims2.length + ' см' : '',
          dims2.weight ? 'Вага: '    + dims2.weight + ' кг' : '',
        ].filter(Boolean);
        if (dimParts.length < 4) {
          // Якщо не всі габарити — показуємо по одному для ручного вводу
          dimParts.forEach((dp, i) => {
            const ids = ['vdim-w','vdim-h','vdim-l','vdim-wt'];
            helperRows.push({ label: dp.split(':')[0] + ' (см/кг):', val: dp.split(':')[1]?.trim() || '', id: ids[i] });
          });
        } else if (dimParts.length > 0) {
          helperRows.push({ label: 'Габарити:', val: dimParts.join(' | '), id: 'vdim' });
        }

        if (helperRows.length === 0) {
          helper.remove();
        } else {
          const hp = [];
          hp.push('<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">');
          hp.push('<span style="color:#00D4FF;font-weight:700;font-size:13px">Vorta - скопіюй вручну</span>');
          hp.push('<button id="vorta-close-btn" style="background:none;border:none;color:#6B7A8F;cursor:pointer;font-size:18px">x</button>');
          hp.push('</div>');

          helperRows.forEach(row => {
            hp.push('<div style="margin-bottom:8px">');
            hp.push('<div style="color:#6B7A8F;font-size:10px;margin-bottom:3px">' + row.label + '</div>');
            hp.push('<div style="display:flex;gap:6px">');
            if (row.rows) {
              hp.push('<textarea readonly rows="' + row.rows + '" id="' + row.id + '" style="flex:1;background:#161C24;border:1px solid #252D3A;border-radius:6px;padding:5px 8px;color:#E8EDF5;font-size:11px;resize:none">' + row.val + '</textarea>');
            } else {
              hp.push('<input readonly id="' + row.id + '" value="' + row.val.replace(/"/g, '&quot;') + '" style="flex:1;background:#161C24;border:1px solid #252D3A;border-radius:6px;padding:5px 8px;color:#E8EDF5;font-size:11px">');
            }
            hp.push('<button data-copy-id="' + row.id + '" style="background:#00D4FF;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:11px;font-weight:700;align-self:flex-start;flex-shrink:0">Copy</button>');
            hp.push('</div></div>');
          });

          helper.innerHTML = hp.join('');
          document.body.appendChild(helper);

          document.getElementById('vorta-close-btn').onclick = () => helper.remove();
          helper.querySelectorAll('[data-copy-id]').forEach(btn => {
            btn.onclick = () => {
              const el = document.getElementById(btn.dataset.copyId);
              navigator.clipboard.writeText(el.value || el.textContent);
              btn.textContent = '✓';
              setTimeout(() => btn.textContent = 'Copy', 1500);
            };
          });
        }

        // Сповіщення на сторінці
        document.getElementById('vorta-n') && document.getElementById('vorta-n').remove();
        const n = document.createElement('div');
        n.id = 'vorta-n';
        n.style.cssText = 'position:fixed;top:20px;right:20px;z-index:999999;background:' +
          (filled > 0 ? '#00D4FF' : '#FF4D6A') +
          ';color:#000;padding:12px 20px;border-radius:10px;font-weight:700;font-size:13px;font-family:sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.3)';
        n.textContent = filled > 0
          ? ('✅ Vorta: заповнено ' + filled + ' полів! Перевір і збережи.')
          : '⚠️ Vorta: поля не знайдено';
        document.body.appendChild(n);
        setTimeout(() => { n.style.opacity='0'; n.style.transition='opacity .5s'; setTimeout(()=>n.remove(),500); }, 5000);

        return filled;
      },
      args: [data]
    });

    const filled = results?.[0]?.result || 0;

    if (btn) {
      btn.textContent = filled > 0 ? `✅ Заповнено ${filled} полів!` : '⚠️ Поля не знайдено';
      btn.style.background = filled > 0 ? 'var(--green)' : 'var(--red)';
      btn.style.color = '#000';
      btn.disabled = false;
      setTimeout(() => {
        btn.textContent = '⚡ Автозаповнити форму Prom.ua';
        btn.style.background = '';
        btn.style.color = '';
      }, 4000);
    }

    // Фокусуємо вкладку Prom.ua
    await chrome.tabs.update(promTab.id, { active: true });

  } catch(e) {
    if (btn) {
      btn.textContent = '⚡ Автозаповнити форму Prom.ua';
      btn.disabled = false;
      btn.style.background = '';
    }
    showError('Помилка: ' + (e.message || 'спробуй ще раз'));
  }
}


async function fillPromForm(tabId, data) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (d) => {
      // Універсальна функція заповнення з React/Vue підтримкою
      function fillInput(el, value) {
        if (!el || !value) return;
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (el.tagName === 'TEXTAREA' && nativeTextareaSetter) {
          nativeTextareaSetter.set.call(el, value);
        } else if (nativeInputValueSetter) {
          nativeInputValueSetter.set.call(el, value);
        } else {
          el.value = value;
        }
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      }

      function find(selectors) {
        for (const s of selectors.split(',')) {
          const el = document.querySelector(s.trim());
          if (el) return el;
        }
        return null;
      }

      let filled = 0;

      // Назва товару
      const nameEl = find('[name="name"], #id_name, input[placeholder*="назв"], input[placeholder*="Назв"]');
      if (nameEl) { fillInput(nameEl, d.title); filled++; }

      // Ціна
      const priceEl = find('[name="price"], #id_price, input[placeholder*="ціна"], input[placeholder*="Ціна"], input[placeholder*="цена"]');
      if (priceEl && d.price) { fillInput(priceEl, d.price); filled++; }

      // Артикул
      const skuEl = find('[name="sku"], #id_sku, [name="article"], input[placeholder*="артикул"], input[placeholder*="Артикул"]');
      if (skuEl && d.article) { fillInput(skuEl, d.article); filled++; }

      // Опис
      const cleanDesc = (d.description || '').replace(/<[^>]+>/g, '');
      const descEl = find('[name="description"], #id_description, textarea[placeholder*="опис"], textarea[placeholder*="Опис"]');
      if (descEl) { fillInput(descEl, cleanDesc); filled++; }

      // SEO title
      const seoTitleEl = find('[name="seo_title"], #id_seo_title, input[placeholder*="SEO"], input[name*="seo"]');
      if (seoTitleEl && d.seo_title) { fillInput(seoTitleEl, d.seo_title); filled++; }

      // SEO description
      const seoDescEl = find('[name="seo_description"], #id_seo_description, textarea[name*="seo"]');
      if (seoDescEl && d.seo_description) { fillInput(seoDescEl, d.seo_description); filled++; }

      // Ключові слова
      if (d.seo_tags && d.seo_tags.length) {
        const kwEl = find('[name="keywords"], #id_keywords, input[placeholder*="ключов"], input[placeholder*="тег"]');
        if (kwEl) { fillInput(kwEl, d.seo_tags.join(', ')); filled++; }
      }

      // Показуємо сповіщення на сторінці
      const notice = document.createElement('div');
      notice.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;background:#00D4FF;color:#000;padding:12px 20px;border-radius:10px;font-weight:bold;font-size:14px;box-shadow:0 4px 20px rgba(0,212,255,0.5)';
      notice.textContent = filled > 0 ? `✅ Vorta UA: заповнено ${filled} полів` : '⚠️ Vorta UA: поля не знайдено — можливо форма ще завантажується';
      document.body.appendChild(notice);
      setTimeout(() => notice.remove(), 4000);

      return filled;
    },
    args: [data]
  });
}

// ── UTILS ─────────────────────────────────────────────────────────────────
function setLoading(on) {
  const btn = $('genBtn'); if (btn) btn.disabled = on;
  const sp  = $('spin');   if (sp)  sp.style.display = on ? 'block' : 'none';
  const labels = { listing:'ЗГЕНЕРУВАТИ КАРТКУ', social:'ЗГЕНЕРУВАТИ ПОСТИ', both:'ЗГЕНЕРУВАТИ ВСЕ' };
  set('btnLabel', on ? 'ГЕНЕРУЮ...' : labels[currentMode]);
}
function showError(msg) { const e=$('errorBox'); if(e){e.style.display='block';e.textContent='⚠ '+msg;} }
function hideError()    { const e=$('errorBox'); if(e) e.style.display='none'; }
function hideResults()  { [$('listingResults'),$('socialResults')].forEach(el=>{if(el)el.style.display='none';}); }
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✓'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  });
}
