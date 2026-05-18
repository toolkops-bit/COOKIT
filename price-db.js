const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'prices.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS prices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chain       TEXT NOT NULL,
      query       TEXT NOT NULL,
      product_name TEXT NOT NULL,
      price       REAL NOT NULL,
      unit        TEXT,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_query_chain ON prices(query, chain);

    CREATE TABLE IF NOT EXISTS scrape_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chain      TEXT NOT NULL,
      status     TEXT NOT NULL,
      message    TEXT,
      ran_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- מחירי ממשלה: כל המוצרים מכל הרשתות
    CREATE TABLE IF NOT EXISTS gov_prices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chain        TEXT NOT NULL,
      barcode      TEXT,
      product_name TEXT NOT NULL,
      price        REAL NOT NULL,
      unit         TEXT,
      imported_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_gov_chain_name ON gov_prices(chain, product_name);
    CREATE INDEX IF NOT EXISTS idx_gov_name ON gov_prices(product_name);

    CREATE TABLE IF NOT EXISTS gov_import_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chain      TEXT NOT NULL,
      items      INTEGER,
      status     TEXT,
      ran_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function upsertPrice(chain, query, productName, price, unit) {
  const d = getDb();
  d.prepare(`
    INSERT INTO prices (chain, query, product_name, price, unit, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT DO NOTHING
  `).run(chain, query, productName, price, unit || '');

  // שמור רק את הכניסה האחרונה (הסקרייפר כבר בחר את המוצר הרלוונטי ביותר)
  d.prepare(`
    DELETE FROM prices
    WHERE chain = ? AND query = ?
      AND id NOT IN (
        SELECT id FROM prices
        WHERE chain = ? AND query = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      )
  `).run(chain, query, chain, query);
}

function getPricesForQuery(query) {
  return getDb().prepare(`
    SELECT chain, product_name, price, unit, updated_at
    FROM prices
    WHERE query = ?
    ORDER BY price ASC
  `).all(query);
}

function logScrape(chain, status, message) {
  getDb().prepare(`
    INSERT INTO scrape_log (chain, status, message) VALUES (?, ?, ?)
  `).run(chain, status, message || '');
}

function clearOldPrices(hoursOld = 25) {
  getDb().prepare(`
    DELETE FROM prices
    WHERE updated_at < datetime('now', '-${hoursOld} hours')
  `).run();
}

// מילים נרדפות לצורות דקדוקיות נפוצות
const WORD_SYNONYMS = {
  'קפוא':    ['מוקפא'],
  'קפואה':   ['מוקפאת'],
  'קפואים':  ['מוקפאים'],
  'מוקפא':   ['קפוא'],
  'מוקפאת':  ['קפואה'],
  'מוקפאים': ['קפואים'],
  'טחון':    ['טחונה', 'טחונים'],
  'טחונה':   ['טחון'],
  'מעושן':   ['מעושנת'],
  'מעושנת':  ['מעושן'],
  'אורגני':  ['אורגנית'],
  'אורגנית': ['אורגני'],
  'שלם':     ['שלמה', 'שלמים'],
  'שלמה':    ['שלם'],
  'שלמים':   ['שלם'],
  'פרוס':    ['פרוסה', 'פרוסים'],
  'פרוסה':   ['פרוס'],
};

// נרמול כתיב עברי (יי→י, וו→ו)
function normalizeHeb(w) {
  return w.replace(/יי/g, 'י').replace(/וו/g, 'ו');
}

// מילים שמופיעות לפני שם המוצר האמיתי (אריזה / תיאור מרכיב) — לא נחשבות כמוצר עצמאי
const SKIP_PREFIX_WORDS = new Set([
  'מארז', 'חבילת', 'שקית', 'אריזת', 'אריזה', 'מגש', 'קופסת', 'פח', 'ארגז', 'כד', 'קרטון', 'סט',
  'שורש', 'עלי', 'פרי', 'גרעיני', 'פולי', 'גרגרי', 'זרעי',
]);

// מחזיר את עמדת המילה הראשונה שאינה מילת prefix ואינה מספר
function effectiveFirstWordPos(nWords) {
  for (let i = 0; i < nWords.length; i++) {
    if (!SKIP_PREFIX_WORDS.has(nWords[i]) && !/^\d+$/.test(nWords[i])) return i;
  }
  return 0;
}

// בונה תנאי SQL + פונקציות ניקוד לשאילתא נתונה
function buildQueryHelpers(words) {
  const queryLower = words.join(' ');

  function buildSQL() {
    const condParts = [], params = [];
    for (const w of words) {
      const syns = WORD_SYNONYMS[w] || [];
      const all = [w, ...syns];
      condParts.push('(' + all.map(() => 'product_name LIKE ?').join(' OR ') + ')');
      params.push(...all.map(s => `%${s}%`));
    }
    return { cond: condParts.join(' AND '), params };
  }

  function wordMatch(nameWord, qWord) {
    const nw = normalizeHeb(nameWord);
    if (nw === qWord) return true;
    if (nw === 'ה' + qWord) return true;
    if (nw === qWord + 'ים') return true;
    if (nw === qWord + 'ות') return true;
    if (nw === qWord + 'י') return true;
    const syns = WORD_SYNONYMS[qWord] || [];
    for (const s of syns) {
      if (nw === s || nw === 'ה' + s || nw === s + 'ים' || nw === s + 'ות' || nw === s + 'י') return true;
    }
    return false;
  }

  function nameContainsWord(name, qWord) {
    return name.split(/\s+/).some(nw => wordMatch(nw, qWord));
  }

  function qWordPos(n, qWord) {
    return n.split(/\s+/).findIndex(w => wordMatch(w, qWord));
  }

  function relevance(name) {
    const n = normalizeHeb(name.toLowerCase());
    const nWords = n.split(/\s+/);
    if (n === queryLower) return 4;
    if (n.startsWith(queryLower)) return 3;
    if (words.every(w => nameContainsWord(n, w))) {
      if (words.length > 1 && nWords.length <= words.length + 2) return 2;
      if (words.length === 1) {
        const pos = qWordPos(n, words[0]);
        if (pos === 0) return 2;
        const effPos = effectiveFirstWordPos(nWords);
        if (pos !== -1 && pos === effPos && wordMatch(nWords[effPos], words[0])) return 2;
      }
    }
    if (words.every(w => nameContainsWord(n, w))) return 1;
    return 0;
  }

  return { buildSQL, wordMatch, relevance };
}

// חיפוש מוצרים ב-gov_prices — מחזיר מוצר אחד לכל רשת (הרלוונטי ביותר)
function searchGovPrices(query) {
  const words = query.split(/\s+/).filter(w => w.length > 1).map(normalizeHeb);
  if (words.length === 0) return [];
  const d = getDb();
  const { buildSQL, wordMatch, relevance } = buildQueryHelpers(words);
  const { cond, params } = buildSQL();

  const rows = d.prepare(`
    SELECT chain, product_name, price, unit
    FROM gov_prices
    WHERE ${cond}
    ORDER BY price ASC
    LIMIT 200
  `).all(...params);

  const best = {};
  for (const row of rows) {
    const s = relevance(row.product_name);
    const cur = best[row.chain];
    const rowNorm = normalizeHeb(row.product_name.toLowerCase());
    const curNorm = cur ? normalizeHeb(cur.product_name.toLowerCase()) : '';
    const rowW = rowNorm.split(/\s+/).length;
    const curW = cur ? curNorm.split(/\s+/).length : Infinity;
    const rowFirst = words.length === 1 && wordMatch(rowNorm.split(/\s+/)[0], words[0]);
    const curFirst = cur && words.length === 1 && wordMatch(curNorm.split(/\s+/)[0], words[0]);
    const rowWins = !cur || s > cur.score ||
      (s === cur.score && rowFirst && !curFirst) ||
      (s === cur.score && rowFirst && curFirst && (rowW < curW || (rowW === curW && row.price < cur.price))) ||
      (s === cur.score && !rowFirst && !curFirst && (row.price < cur.price || (row.price === cur.price && rowW < curW)));
    if (rowWins) {
      best[row.chain] = { chain: row.chain, product_name: row.product_name, price: row.price, unit: row.unit, score: s };
    }
  }

  return Object.values(best)
    .filter(r => r.score >= 2)
    .sort((a, b) => a.price - b.price)
    .map(({ score: _s, ...r }) => r);
}

// חיפוש מוצרים ב-gov_prices — מחזיר עד limitPerChain מועמדים לכל רשת (לבחירת משתמש)
// skip: כמה מועמדים לדלג (לפגינציה)
// minScore: ניקוד מינימלי — 2 לתצוגה ראשונית (מדויקים בלבד), 1 לכפתור "עוד" (חלופות)
function searchGovPricesMulti(query, limitPerChain = 3, skip = 0, minScore = 2) {
  const words = query.split(/\s+/).filter(w => w.length > 1).map(normalizeHeb);
  if (words.length === 0) return {};
  const d = getDb();
  const { buildSQL, relevance } = buildQueryHelpers(words);
  const { cond, params } = buildSQL();

  const rows = d.prepare(`
    SELECT chain, product_name, price, unit
    FROM gov_prices
    WHERE ${cond}
    ORDER BY price ASC
    LIMIT 500
  `).all(...params);

  const byChain = {};
  for (const row of rows) {
    const s = relevance(row.product_name);
    if (s < minScore) continue;
    if (!byChain[row.chain]) byChain[row.chain] = [];
    byChain[row.chain].push({ product_name: row.product_name, price: row.price, unit: row.unit || '', score: s });
  }

  const result = {};
  for (const [chain, candidates] of Object.entries(byChain)) {
    candidates.sort((a, b) => b.score - a.score || a.price - b.price);
    const sliced = candidates.slice(skip, skip + limitPerChain);
    if (sliced.length > 0) {
      result[chain] = sliced.map(({ score: _s, ...c }) => c);
    }
  }
  return result;
}

function importGovPrices(chain, products) {
  const d = getDb();
  // מחק ייבוא ישן לרשת זו
  d.prepare('DELETE FROM gov_prices WHERE chain = ?').run(chain);
  const insert = d.prepare(
    'INSERT INTO gov_prices (chain, barcode, product_name, price, unit) VALUES (?, ?, ?, ?, ?)'
  );
  const insertMany = d.transaction(items => {
    for (const item of items) insert.run(chain, item.barcode, item.name, item.price, item.unit || '');
  });
  insertMany(products);
  d.prepare('INSERT INTO gov_import_log (chain, items, status) VALUES (?, ?, ?)').run(chain, products.length, 'ok');
  console.log(`[gov] imported ${products.length} products for ${chain}`);
}

function getGovImportStatus() {
  return getDb().prepare(`
    SELECT chain, items, ran_at FROM gov_import_log
    WHERE ran_at = (SELECT MAX(ran_at) FROM gov_import_log g2 WHERE g2.chain = gov_import_log.chain)
    ORDER BY ran_at DESC
  `).all();
}

module.exports = { getDb, upsertPrice, getPricesForQuery, logScrape, clearOldPrices, searchGovPrices, searchGovPricesMulti, importGovPrices, getGovImportStatus };
