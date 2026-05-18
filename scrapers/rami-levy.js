const axios = require('axios');
const { upsertPrice, logScrape } = require('../price-db');

const CHAIN = 'rami-levy';
const SEARCH_URL = 'https://www.rami-levy.co.il/api/search';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'he-IL,he;q=0.9',
  'Referer': 'https://www.rami-levy.co.il/',
};

async function scrapeProduct(query) {
  let data;
  try {
    const res = await axios.get(SEARCH_URL, {
      params: { q: query, page: 1, per_page: 20 },
      headers: HEADERS,
      timeout: 12000,
    });
    data = res.data;
  } catch (err) {
    logScrape(CHAIN, 'error', `HTTP error for "${query}": ${err.message}`);
    return null;
  }

  const products = data?.data || [];
  if (products.length === 0) {
    logScrape(CHAIN, 'no_results', `No products for "${query}"`);
    return null;
  }

  const queryWords = query.split(/\s+/).filter(w => w.length > 1);

  // נרמל כתיב (יי→י) וצורות מורפולוגיות נפוצות
  const SYNONYMS = { 'קפואה': ['מוקפאת'], 'קפוא': ['מוקפא'], 'מוקפאת': ['קפואה'], 'מוקפא': ['קפוא'],
                     'טחון': ['טחונה'], 'טחונה': ['טחון'], 'מעושן': ['מעושנת'], 'מעושנת': ['מעושן'] };
  function wordInName(name, w) {
    const norm = w.replace(/יי/g, 'י');
    if (name.includes(norm)) return true;
    for (const s of (SYNONYMS[norm] || [])) if (name.includes(s)) return true;
    return false;
  }

  function relevanceScore(name) {
    if (!name) return -1;
    if (name.startsWith(query)) return 2;
    if (queryWords.every(w => wordInName(name, w))) return 1;
    if (queryWords.some(w => wordInName(name, w))) return 0;
    return -1;
  }

  const scored = products
    .filter(p => p.name && p.price?.price != null)
    .map(p => ({ name: p.name, price: p.price.price, score: relevanceScore(p.name) }))
    .filter(p => p.score >= 1)
    .sort((a, b) => b.score - a.score || a.price - b.price);

  const best = scored[0] || null;
  if (!best) {
    logScrape(CHAIN, 'no_results', `No relevant products for "${query}"`);
    return null;
  }

  upsertPrice(CHAIN, query, best.name, best.price, '');
  logScrape(CHAIN, 'ok', `"${query}" → ${best.name} ₪${best.price}`);
  console.log(`[rami-levy] "${query}" → ${best.name} ₪${best.price}`);
  return { name: best.name, price: best.price, unit: '' };
}

module.exports = { scrapeProduct };
