const { chromium } = require('playwright');
const { upsertPrice, logScrape } = require('../price-db');

const CHAIN = 'keshet-teamim';
const BASE_URL = 'https://www.keshet-teamim.co.il/search?q=';

async function scrapeProduct(query) {
  const url = BASE_URL + encodeURIComponent(query);
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForSelector('.carousel-component-product-item', { timeout: 12000 }).catch(() => {});

    const products = await page.evaluate((q) => {
      const queryWords = q.split(/\s+/).filter(w => w.length > 1);
      const containers = document.querySelectorAll('.carousel-component-product-item.product');
      const items = [];

      containers.forEach(el => {
        const nameEl = el.querySelector('h2, h3, h4, [class*="name"], [class*="title"]');
        const name = nameEl?.textContent?.trim();
        if (!name) return;

        let price = null;
        const salePriceEl = el.querySelector('.sale-price');
        const regPriceEl  = el.querySelector('.regular-price, .sp-product-price, .price');
        const priceSource = salePriceEl || regPriceEl;
        if (priceSource) {
          const m = priceSource.textContent.trim().match(/₪([\d.]+)/);
          if (m) price = parseFloat(m[1]);
        }
        if (!price || price <= 0) return;

        const score = name.startsWith(q) ? 2
          : queryWords.every(w => name.includes(w)) ? 1
          : queryWords.some(w => name.includes(w)) ? 0 : -1;
        if (score >= 1) items.push({ name, price, score });
      });

      return items.sort((a, b) => b.score - a.score || a.price - b.price);
    }, query);

    if (products.length === 0) {
      logScrape(CHAIN, 'no_results', `No products for "${query}"`);
      return null;
    }

    const best = products[0];
    upsertPrice(CHAIN, query, best.name, best.price, '');
    logScrape(CHAIN, 'ok', `"${query}" → ${best.name} ₪${best.price}`);
    console.log(`[keshet-teamim] "${query}" → ${best.name} ₪${best.price}`);
    return { name: best.name, price: best.price, unit: '' };

  } catch (err) {
    logScrape(CHAIN, 'error', `Error for "${query}": ${err.message}`);
    console.error(`[keshet-teamim] Error:`, err.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeProduct };
