// Vorta UA — autofill.js v5
// Простий content script — просто реєструє listener
// Дані приходять через executeScript з аргументами

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'vorta_fill') return;
  runFill(msg.data).then(n => sendResponse({ ok: true, filled: n }));
  return true;
});

async function runFill(d) {
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

  const inp = () => Array.from(document.querySelectorAll('input'));
  let filled = 0;

  // Назва укр
  const nameEl = inp().find(el => el.placeholder?.includes('H&M жіноча сукня'));
  if (d.title && nameEl && fillReact(nameEl, d.title)) filled++;
  await sleep(150);

  // Ціна
  const priceEl = inp().find(el => el.placeholder === '0');
  if (d.price && priceEl && fillReact(priceEl, d.price)) filled++;
  await sleep(100);

  // Артикул
  const articleEl = inp().find(el => el.placeholder === '-');
  if (d.article && articleEl && fillReact(articleEl, d.article)) filled++;
  await sleep(100);

  // Габарити
  const dims = d.dimensions || {};
  for (const [ph, val] of [
    ['Ширина, см', dims.width],
    ['Висота, см', dims.height],
    ['Довжина, см', dims.length],
    ['Вага, кг', dims.weight],
  ]) {
    const el = inp().find(i => i.placeholder === ph);
    if (val && el && fillReact(el, val)) filled++;
    await sleep(60);
  }

  // SEO теги
  const seoEl = inp().find(el => el.placeholder?.includes('Додайте не менше 8 запитів'));
  if (seoEl && d.seo_tags?.length) {
    seoEl.focus();
    for (const tag of d.seo_tags.slice(0, 10)) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (setter?.set) setter.set.call(seoEl, tag);
      else seoEl.value = tag;
      seoEl.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(80);
      seoEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
      seoEl.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13 }));
      await sleep(100);
    }
    seoEl.blur();
    filled++;
  }

  // Опис Quill
  const editor = document.querySelector('.ql-editor[contenteditable="true"]')
    || document.querySelector('[contenteditable="true"]');
  if (editor && d.description) {
    const clean = d.description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, clean);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    filled++;
  }

  // Сповіщення
  document.getElementById('vorta-n')?.remove();
  const n = document.createElement('div');
  n.id = 'vorta-n';
  n.style.cssText = 'position:fixed;top:20px;right:20px;z-index:999999;background:' +
    (filled > 0 ? '#00D4FF' : '#FF4D6A') +
    ';color:#000;padding:12px 20px;border-radius:10px;font-weight:700;font-size:13px;font-family:sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.3);max-width:320px';
  n.textContent = filled > 0
    ? `✅ Vorta: заповнено ${filled} полів! Перевір і збережи.`
    : '⚠️ Vorta: поля не знайдено';
  document.body.appendChild(n);
  setTimeout(() => { n.style.opacity='0'; n.style.transition='opacity .5s'; setTimeout(()=>n.remove(),500); }, 5000);

  return filled;
}
