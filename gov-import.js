const axios = require('axios');
const zlib = require('zlib');
const cheerio = require('cheerio');
const { importGovPrices } = require('./price-db');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
};

const CHAINS = [
  { id: 'shufersal',  label: 'שופרסל',    type: 'shufersal',  indexUrl: 'https://prices.shufersal.co.il/?sort=Size&sortdir=DESC' },
  { id: 'victory',    label: 'ויקטורי',    type: 'victory',    indexUrl: 'https://laibcatalog.co.il/webapi/api/getfiles?edi=7290696200003' },
  { id: 'hazi-hinam', label: 'חצי חינם',   type: 'hazi-hinam', indexUrl: 'https://shop.hazi-hinam.co.il/Prices' },
  { id: 'carrefour',  label: 'קרפור',      type: 'carrefour',  indexUrl: 'https://prices.carrefour.co.il/?sort=Size&sortdir=DESC' },
];

// שופרסל / קרפור: קישורי GZ ישירות ב-HTML (Azure Blob Storage).
// מחזיר את כל הקישורים התואמים (לא רק הראשון)
async function fetchAzureBlobUrls(indexUrl, prefix) {
  const res = await axios.get(indexUrl, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(res.data);
  const found = [];
  $('a').each(function() {
    const href = $(this).attr('href') || '';
    if (href.includes('.gz') && href.includes(prefix)) found.push(href);
  });
  return found;
}

async function fetchAzureBlobUrl(indexUrl, prefix) {
  const urls = await fetchAzureBlobUrls(indexUrl, prefix);
  return urls[0] || null;
}

// ויקטורי: JSON API → מזג את כל קבצי המחיר (פר-סניף) לרשימה אחת
async function fetchVictoryUrls(indexUrl) {
  const res = await axios.get(indexUrl, { headers: HEADERS, timeout: 15000 });
  const files = res.data;
  if (!Array.isArray(files)) return [];
  return files
    .filter(f => f.fileType === 'pricefull' || f.fileType === 'price')
    .map(f => `https://laibcatalog.co.il/webapi/7290696200003/${f.fileName}`);
}

// חצי חינם: HTML עם קישורים לאזור Azure
async function fetchHaziHinamUrl(indexUrl) {
  const res = await axios.get(indexUrl, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(res.data);
  let found = null;
  $('a').each(function() {
    if (found) return;
    const href = $(this).attr('href') || '';
    if (href.includes('.gz') && href.includes('PriceFull')) found = href;
  });
  // fallback: חפש ב-HTML גולמי
  if (!found) {
    const match = res.data.match(/https?:\/\/[^"'\s]*PriceFull[^"'\s]*\.gz/);
    if (match) found = match[0];
  }
  return found;
}

async function fetchFileUrl(chain) {
  if (chain.type === 'carrefour')  return fetchAzureBlobUrl(chain.indexUrl, 'PriceFull');
  if (chain.type === 'hazi-hinam') return fetchHaziHinamUrl(chain.indexUrl);
  return null;
}

// הורד GZ ופרסר XML
async function downloadAndParse(url) {
  const res = await axios.get(url, {
    headers: HEADERS,
    responseType: 'arraybuffer',
    timeout: 90000,
  });

  return new Promise((resolve, reject) => {
    zlib.gunzip(res.data, (err, buf) => {
      if (err) return reject(err);
      // נסה UTF-8 קודם; אם ה-XML מצהיר encoding אחר — השתמש בו
      let xml = buf.toString('utf8');
      const encMatch = xml.match(/encoding=["']([^"']+)["']/i);
      if (encMatch && encMatch[1].toLowerCase() !== 'utf-8') {
        try {
          xml = new TextDecoder(encMatch[1]).decode(buf);
        } catch (_) { /* remain utf-8 */ }
      }

      const products = [];
      const itemRegex = /<Item>([\s\S]*?)<\/Item>/g;
      let match;

      while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];
        const rawName = (block.match(/<ItemName>([^<]+)/)  || [])[1]?.trim();
        const name  = rawName
          ? rawName.replace(/&apos;/g,"'").replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          : undefined;
        const price = parseFloat((block.match(/<ItemPrice>([^<]+)/) || [])[1] || '');
        const bar   = (block.match(/<ItemCode>([^<]+)/)  || [])[1]?.trim();
        const rawUnit = (block.match(/<UnitOfMeasure>([^<]+)/) || [])[1]?.trim() || '';
        // פסול unit עם תווים גרובים (encoding שגוי)
        const unit = /\?{2,}|[\x80-\x9F]/.test(rawUnit) ? '' : rawUnit;

        if (name && !isNaN(price) && price > 0) {
          products.push({ name, price, barcode: bar || '', unit });
        }
      }
      resolve(products);
    });
  });
}

async function importChain(chain) {
  console.log(`[gov-import] ${chain.label}: fetching index...`);
  try {
    // ויקטורי: כל סניפי ה-API — מיזוג לפי שם מוצר
    if (chain.type === 'victory') {
      const urls = await fetchVictoryUrls(chain.indexUrl);
      if (urls.length === 0) { console.warn(`[gov-import] ${chain.label}: no store files found`); return 0; }
      console.log(`[gov-import] ${chain.label}: downloading ${urls.length} store files...`);
      const allProducts = [];
      for (let i = 0; i < urls.length; i += 5) {
        const batch = urls.slice(i, i + 5);
        const results = await Promise.allSettled(batch.map(u => downloadAndParse(u)));
        for (const r of results) if (r.status === 'fulfilled') allProducts.push(...r.value);
      }
      const byName = {};
      for (const p of allProducts) {
        if (!byName[p.name] || p.price < byName[p.name].price) byName[p.name] = p;
      }
      const merged = Object.values(byName);
      importGovPrices(chain.id, merged);
      console.log(`[gov-import] ${chain.label}: ${allProducts.length} items → ${merged.length} unique`);
      return merged.length;
    }

    // שופרסל: כל סניפי הדף הראשון (ממוין לפי גודל) — מיזוג לפי שם מוצר
    if (chain.type === 'shufersal') {
      const urls = await fetchAzureBlobUrls(chain.indexUrl, 'PriceFull');
      if (urls.length === 0) { console.warn(`[gov-import] ${chain.label}: no store files found`); return 0; }
      console.log(`[gov-import] ${chain.label}: downloading ${urls.length} store files...`);
      const allProducts = [];
      for (let i = 0; i < urls.length; i += 3) {
        const batch = urls.slice(i, i + 3);
        const results = await Promise.allSettled(batch.map(u => downloadAndParse(u)));
        for (const r of results) {
          if (r.status === 'fulfilled') allProducts.push(...r.value);
        }
      }
      // מיזוג: שם מוצר ייחודי → המחיר הזול ביותר
      const byName = {};
      for (const p of allProducts) {
        if (!byName[p.name] || p.price < byName[p.name].price) byName[p.name] = p;
      }
      const merged = Object.values(byName);
      importGovPrices(chain.id, merged);
      console.log(`[gov-import] ${chain.label}: ${allProducts.length} items → ${merged.length} unique`);
      return merged.length;
    }

    const fileUrl = await fetchFileUrl(chain);
    if (!fileUrl) {
      console.warn(`[gov-import] ${chain.label}: no price file found`);
      return 0;
    }
    console.log(`[gov-import] ${chain.label}: downloading ${fileUrl.substring(0, 80)}...`);
    const products = await downloadAndParse(fileUrl);
    console.log(`[gov-import] ${chain.label}: parsed ${products.length} products`);
    importGovPrices(chain.id, products);
    return products.length;
  } catch (err) {
    console.error(`[gov-import] ${chain.label} failed:`, err.message);
    return 0;
  }
}

async function importAll() {
  console.log(`[gov-import] Starting import of ${CHAINS.length} chains...`);
  for (const chain of CHAINS) {
    await importChain(chain);
  }
  console.log('[gov-import] Done.');
}

module.exports = { importAll, importChain, CHAINS };

if (require.main === module) {
  importAll().catch(console.error);
}
