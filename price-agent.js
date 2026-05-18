require('dotenv').config();
const cron = require('node-cron');
const { clearOldPrices, getDb } = require('./price-db');
const { importAll: importGovAll } = require('./gov-import');
const shufersal = require('./scrapers/shufersal');

// סקרייפרים מהירים (axios/JSON)
const scrapers = { shufersal };
try {
  scrapers['rami-levy'] = require('./scrapers/rami-levy');
  console.log('[price-agent] rami-levy: loaded');
} catch (e) {
  console.warn('[price-agent] rami-levy not available:', e.message);
}
const { runHidden } = require('./scrapers/playwright-runner');
const PLAYWRIGHT_CHAINS = ['victory', 'tivtaam', 'keshet-teamim', 'freshmarket'];

async function scrapeAllPending() {
  const db = getDb();
  // קבל את כל השאילתות הפעילות (נרשמו בפחות מ-24 שעות)
  const pendingQueries = db.prepare(`
    SELECT DISTINCT query FROM prices
    WHERE updated_at > datetime('now', '-24 hours')
  `).all().map(r => r.query);

  if (pendingQueries.length === 0) {
    console.log('[price-agent] No pending queries to refresh');
    return;
  }

  const totalChains = Object.keys(scrapers).length + PLAYWRIGHT_CHAINS.length;
  console.log(`[price-agent] Refreshing ${pendingQueries.length} queries across ${totalChains} chains`);

  for (const query of pendingQueries) {
    // סקרייפרים מהירים — בו-זמנית
    await Promise.allSettled(
      Object.entries(scrapers).map(([, scraper]) => scraper.scrapeProduct(query).catch(() => {}))
    );
    // Playwright — תהליכים נסתרים, בסדרה כדי לא להעמיס זיכרון
    for (const chain of PLAYWRIGHT_CHAINS) {
      await runHidden(chain, query);
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

// ניקוי מחירים ישנים כל יום בחצות
cron.schedule('0 0 * * *', () => {
  clearOldPrices(25);
  console.log('[price-agent] Cleared old prices');
});

// ייבוא מחירים ממקורות ממשלה כל יום ב-4:00 בבוקר
cron.schedule('0 4 * * *', () => {
  console.log('[price-agent] Starting daily gov price import...');
  importGovAll().catch(err => console.error('[price-agent] Gov import error:', err.message));
});

// רענון מחירים כל שעה
cron.schedule('0 * * * *', scrapeAllPending);

console.log('[price-agent] Started — refreshing every hour');
scrapeAllPending(); // ריצה ראשונית מיד
