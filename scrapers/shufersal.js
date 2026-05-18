const axios = require('axios');
const cheerio = require('cheerio');
const { upsertPrice, logScrape } = require('../price-db');

const CHAIN = 'shufersal';
const BASE_URL = 'https://www.shufersal.co.il/online/he/search';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function parsePrice(text) {
  if (!text) return null;
  const cleaned = text.replace(/כ-|₪|שקלים חדשים|\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

async function scrapeProduct(query) {
  const url = `${BASE_URL}?q=${encodeURIComponent(query)}&pageSize=10`;

  let html;
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    html = res.data;
  } catch (err) {
    logScrape(CHAIN, 'error', `HTTP error for "${query}": ${err.message}`);
    return null;
  }

  const $ = cheerio.load(html);

  const queryWords = query.split(/\s+/).filter(w => w.length > 1);
  const allProducts = [];

  $('li.miglog-prod').each((_, el) => {
    // imgContainer הוא קישור תמונת המוצר — ה-title שלו הוא שם המוצר האמיתי
    const name  = $(el).find('a.imgContainer[title]').first().attr('title');
    const price = parsePrice($(el).find('.price').first().text());
    const unit  = $(el).find('.pricePerUnit').first().text().trim();

    if (name && price !== null) {
      allProducts.push({ name, price, unit });
    }
  });

  // ציון רלוונטיות: 2 = שם מתחיל בשאילתא, 1 = מכיל כל המילות, 0 = אחר
  function relevanceScore(name) {
    if (name.startsWith(query)) return 2;
    if (queryWords.every(w => name.includes(w))) return 1;
    if (queryWords.some(w => name.includes(w))) return 0;
    return -1;
  }
  const scored = allProducts
    .map(p => ({ ...p, score: relevanceScore(p.name) }))
    .filter(p => p.score >= 1)
    .sort((a, b) => b.score - a.score || a.price - b.price);

  const best = scored[0] || null;

  let bestName = best?.name || null;
  let bestPrice = best?.price || Infinity;
  let bestUnit = best?.unit || '';

  if (!bestName) {
    logScrape(CHAIN, 'no_results', `No products found for "${query}"`);
    return null;
  }

  upsertPrice(CHAIN, query, bestName, bestPrice, bestUnit);
  logScrape(CHAIN, 'ok', `"${query}" → ${bestName} ₪${bestPrice}`);
  console.log(`[shufersal] "${query}" → ${bestName} ₪${bestPrice}`);
  return { name: bestName, price: bestPrice, unit: bestUnit };
}

module.exports = { scrapeProduct };
