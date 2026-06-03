// Vorta UA — content.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrapeProduct') {
    try {
      sendResponse({ success: true, data: scrape() });
    } catch(e) {
      sendResponse({ success: false, error: e.message });
    }
  }
  return true;
});

function scrape() {
  const get = sels => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) {
        const t = el.tagName === 'META' ? el.getAttribute('content') : el.textContent;
        if (t && t.trim().length > 2) return t.trim();
      }
    }
    return '';
  };

  const title = get(['#productTitle','h1.product-title-text','.product-title','h1[itemprop="name"]','h1','title']);
  const brand = get(['#bylineInfo','#brand','.product-brand','[itemprop="brand"]']);
  const price = get(['.a-price .a-offscreen','#priceblock_ourprice','.product-price','.price','[itemprop="price"]']);
  const rating = get(['#acrPopover','.a-icon-alt','[itemprop="ratingValue"]']);
  const desc = get(['#productDescription p','#aplus p','.product-description','.product__description','[itemprop="description"]','meta[name="description"]']);

  const bullets = [];
  document.querySelectorAll('#feature-bullets li span:not(.aok-hidden), .product-features li').forEach(el => {
    const t = el.textContent.trim();
    if (t && t.length > 8) bullets.push(t);
  });

  const chars = [];
  document.querySelectorAll('#productDetails_techSpec_section_1 tr, #detailBullets_feature_div li, .product-specs tr').forEach(row => {
    const t = row.textContent.replace(/\s+/g, ' ').trim();
    if (t && t.length < 200) chars.push(t);
  });

  const cats = [];
  document.querySelectorAll('#wayfinding-breadcrumbs_feature_div a, .breadcrumb a, [itemprop="breadcrumb"] a').forEach(a => {
    if (a.textContent.trim()) cats.push(a.textContent.trim());
  });

  return {
    url: window.location.href,
    domain: window.location.hostname,
    title: title.substring(0, 300),
    brand: brand.replace(/^(Brand:|Visit the|Store)/i, '').trim(),
    price, rating,
    bullets: bullets.slice(0, 5),
    description: desc.substring(0, 1000),
    characteristics: chars.slice(0, 10),
    category: cats.join(' > ')
  };
}
