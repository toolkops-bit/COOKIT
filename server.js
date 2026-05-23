require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
const { getPricesForQuery, upsertPrice, logScrape, searchGovPrices, searchGovPricesMulti } = require('./price-db');

const scrapers = {};
['shufersal', 'rami-levy'].forEach(name => {
  try { scrapers[name] = require(`./scrapers/${name}`); } catch(e) { console.warn(`Scraper ${name} unavailable:`, e.message); }
});
const { runHidden } = require('./scrapers/playwright-runner');

const PLAYWRIGHT_CHAINS = ['tivtaam', 'keshet-teamim', 'freshmarket'];
const GOV_CHAINS = new Set(['shufersal', 'victory', 'hazi-hinam']);

const app = express();

// Railway פועל מאחורי proxy — חובה לסמוך על X-Forwarded-For לקבלת IP אמיתי
app.set('trust proxy', 1);

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors());

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
// כללי: 120 בקשות לדקה לכל IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again in a minute.' }
});

// API: 30 בקשות לדקה לכל IP (מגן על עלויות Claude/Serper)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit reached. Please wait a minute and try again.' }
});

app.use(globalLimiter);
app.use('/api', apiLimiter);

app.use(express.json({ limit: '50kb' }));  // מגביל גודל body
app.use(express.static('public'));

// ── INPUT VALIDATION ─────────────────────────────────────────────────────────
app.use('/api/chat', (req, res, next) => {
  const msg = req.body?.message;
  if (msg && typeof msg === 'string' && msg.length > 500) {
    return res.status(400).json({ error: 'Message too long.' });
  }
  next();
});

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// קבלת פרטי מתכון מאתר מקור
app.post('/api/recipe-details', async (req, res) => {
  const { url, title } = req.body;
  const isEn = req.body.lang === 'en';
  if (!url) return res.status(400).json({ error: isEn ? 'Missing link' : 'חסר קישור' });

  try {
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: isEn
          ? `Based on the recipe name "${title}" from ${url}, create a full recipe in English with preparation instructions. Return JSON only:
        {
          "title": "Recipe name",
          "ingredients": ["ingredient 1 + amount", "ingredient 2 + amount"],
          "instructions": ["step 1", "step 2"],
          "time": "prep time",
          "source": "${url}"
        }`
          : `בהתבסס על שם המתכון "${title}" מהאתר ${url}, צור מתכון מלא בעברית עם הוראות הכנה.
        החזר JSON בלבד:
        {
          "title": "שם המתכון",
          "ingredients": ["מרכיב 1 + כמות", "מרכיב 2 + כמות"],
          "instructions": ["שלב 1", "שלב 2"],
          "time": "זמן הכנה",
          "source": "${url}"
        }`
      }]
    });

    const text = aiResponse.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const recipe = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!recipe) return res.status(500).json({ error: 'שגיאה בטעינת המתכון' });
    res.json(recipe);
  } catch (err) {
    console.error('Recipe details error:', err.message);
    res.status(500).json({ error: 'שגיאה בטעינת פרטי המתכון' });
  }
});

// זיהוי המוצר המדויק הנדרש לפי ההקשר של המתכון
async function identifyProductQuery(ingredient, recipeContext) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    system: `אתה עוזר לזיהוי מוצרי מזון לחיפוש בסופרמרקט ישראלי.
כללים:
- הסר כמויות, מידות ואופן הכנה (קצוץ, קלוף, מגורר, טחון, חתוך, מוקפץ וכו')
- החזר רק את שם המוצר הבסיסי — 1 עד 3 מילים, כפי שנמכר בסופרמרקט ישראלי
- השתמש בשמות ישראליים כפי שמופיעים על המדף

דוגמאות:
"שיני שום" / "שיני שום קלופות" → "שום"
"2 ביצים גדולות" → "ביצים"
"100 גרם חזה עוף" → "חזה עוף"
"כוס קמח לבן" → "קמח לבן"
"שמנת קוקוס" / "קרם קוקוס" → "קרם קוקוס"
"מיץ לימון" → "לימון"
"ג'ינג'ר טרי" → "ג'ינג'ר"
"פלפל צ'ילי" / "צ'ילי אדום" → "צ'ילי"
"גראם מסאלה" → "גרם מסאלה"
"גהי" → "גהי"
"חופן עלי בזיליקום" → "בזיליקום"
"עלי קארי טריים" → "עלי קארי"

- ענה בעברית בלבד, ללא הסבר, ללא פיסוק`,
    messages: [{
      role: 'user',
      content: `מרכיב: "${ingredient}"`
    }]
  });
  return response.content[0].text.trim();
}

// זיהוי queries לפי רשימת מרכיבים — ללא סקרייפינג
app.post('/api/identify-queries', async (req, res) => {
  const { items, recipeContext } = req.body;
  if (!items || items.length === 0) return res.json({ queries: [] });
  const queries = [];
  for (const item of items) {
    let query;
    try {
      query = await identifyProductQuery(item, recipeContext || '');
    } catch {
      query = item;
    }
    queries.push({ ingredient: item, query });
  }
  res.json({ queries });
});

// רענון מחירים לפי queries ידועות — קורא DB בלבד, ללא AI וללא Playwright
app.post('/api/refresh-prices', (req, res) => {
  const { queries } = req.body; // [{ ingredient, query }, ...]
  if (!queries || queries.length === 0) return res.json({ items: [], cheapestChain: null });

  const results = [];
  for (const { ingredient, query } of queries) {
    const prices    = getPricesForQuery(query);
    const govPrices = searchGovPrices(query);
    const chainMap  = {};
    for (const g of govPrices) chainMap[g.chain] = { chain: g.chain, product_name: g.product_name, price: g.price, unit: g.unit || '' };
    for (const p of prices)    chainMap[p.chain] = { chain: p.chain, product_name: p.product_name, price: p.price, unit: p.unit || '' };
    results.push({ ingredient, query, prices: Object.values(chainMap).sort((a, b) => a.price - b.price) });
  }

  const chainTotals = {};
  for (const r of results) for (const p of r.prices) chainTotals[p.chain] = (chainTotals[p.chain] || 0) + p.price;
  const cheapestChain = Object.entries(chainTotals).sort((a, b) => a[1] - b[1])[0];

  res.json({ items: results, cheapestChain: cheapestChain ? { chain: cheapestChain[0], total: cheapestChain[1] } : null });
});

// מציאת מחירים לסל קניות
app.post('/api/find-prices', async (req, res) => {
  const { items, recipeContext } = req.body;
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'נא לשלוח רשימת מרכיבים' });
  }

  const results = [];

  for (const item of items) {
    // זהה את שם המוצר המדויק
    let query;
    try {
      query = await identifyProductQuery(item, recipeContext || '');
    } catch {
      query = item;
    }

    // בדוק מחירים שמורים מסקרייפינג ומנתוני ממשלה
    let prices = getPricesForQuery(query);
    const govPrices = searchGovPrices(query);

    // אם אין נתונים בכלל — סרוק עכשיו את הרשתות המהירות
    if (prices.length === 0 && govPrices.length === 0) {
      const fastScrapers = ['shufersal', 'rami-levy'].filter(n => scrapers[n]);
      await Promise.allSettled(fastScrapers.map(n => scrapers[n].scrapeProduct(query)));
      prices = getPricesForQuery(query);
    }

    // Playwright רץ רק לפי בקשת המשתמש דרך /api/scrape-chain

    // מזג: scraped (טרי, חנות רגילה) + gov (ייתכן מחנות מיוחדת).
    // סקרייפ חי גובר על gov לאותה רשת; gov משלים רשתות שאין להן סקרייפר
    const chainMap = {};
    for (const g of govPrices) {
      chainMap[g.chain] = { chain: g.chain, product_name: g.product_name, price: g.price, unit: g.unit || '' };
    }
    for (const p of prices) {
      // סקרייפ חי מחליף gov לאותה רשת (נתון טרי מחנות כללית, יותר מדויק)
      chainMap[p.chain] = { chain: p.chain, product_name: p.product_name, price: p.price, unit: p.unit || '' };
    }
    const mergedPrices = Object.values(chainMap).sort((a, b) => a.price - b.price);

    results.push({ ingredient: item, query, prices: mergedPrices });
  }

  // חשב את הרשת הזולה לסל כולו
  const chainTotals = {};
  for (const r of results) {
    for (const p of r.prices) {
      chainTotals[p.chain] = (chainTotals[p.chain] || 0) + p.price;
    }
  }

  const cheapestChain = Object.entries(chainTotals).sort((a, b) => a[1] - b[1])[0];

  res.json({
    items: results,
    cheapestChain: cheapestChain ? { chain: cheapestChain[0], total: cheapestChain[1] } : null
  });
});

// סריקת רשת ספציפית לפי בקשת המשתמש — מריץ סקרייפר ומחזיר תוצאות + מועמדים חלופיים
app.post('/api/scrape-chain', async (req, res) => {
  const { chain, queries } = req.body; // queries: [{ingredient, query}]
  if (!chain || !queries?.length) return res.status(400).json({ error: 'missing params' });

  const isGov = GOV_CHAINS.has(chain);

  if (!isGov) {
    const limit = 3;
    for (let i = 0; i < queries.length; i += limit) {
      const batch = queries.slice(i, i + limit);
      await Promise.allSettled(batch.map(({ query }) => {
        if (scrapers[chain]) return scrapers[chain].scrapeProduct(query);
        if (PLAYWRIGHT_CHAINS.includes(chain)) return runHidden(chain, query);
        return Promise.resolve();
      }));
    }
  }

  const results = queries.map(({ ingredient, query }) => {
    let candidates = [];
    if (isGov) {
      const multi = searchGovPricesMulti(query, 3);
      candidates = (multi[chain] || []);
    } else {
      const prices  = getPricesForQuery(query);
      const chainP  = prices.find(p => p.chain === chain);
      const govP    = searchGovPrices(query).find(p => p.chain === chain);
      const best    = chainP || govP || null;
      candidates    = best ? [{ product_name: best.product_name, price: best.price, unit: best.unit || '' }] : [];
    }
    return { ingredient, query, candidates, price: candidates[0] || null };
  });

  res.json({ chain, isGov, results });
});

// הבא עוד מועמדים לאחר הראשונים (פגינציה — רק עבור GOV chains)
app.post('/api/search-more', (req, res) => {
  const { chain, query, skip } = req.body;
  if (!chain || !query) return res.status(400).json({ error: 'missing params' });
  if (!GOV_CHAINS.has(chain)) return res.json({ candidates: [] });
  const multi = searchGovPricesMulti(query, 3, skip || 0, 1);
  res.json({ candidates: multi[chain] || [] });
});

// חיפוש תמונת אוכל דרך Serper + proxy ישיר (עוקף CORS/hotlink)
// TTS
app.get('/api/tts', async (req, res) => {
  const text = (req.query.text || '').substring(0, 200);
  if (!text) return res.status(400).end();
  const tl = req.query.lang === 'en' ? 'en' : 'iw';
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${tl}&client=tw-ob&ttsspeed=0.9`;
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/91.0.4472.120 Mobile Safari/537.36' }
    });
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(r.data));
  } catch {
    res.status(500).end();
  }
});

app.get('/api/food-image', async (req, res) => {
  const q = (req.query.q || 'food dish') + ' plated dish food recipe';
  try {
    const r = await axios.post('https://google.serper.dev/images',
      { q, num: 10 },
      { headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' } }
    );
    const imgs = (r.data.images || []).filter(i => i.imageUrl && i.imageUrl.startsWith('http'));
    for (const img of imgs.slice(0, 5)) {
      try {
        const imgRes = await axios.get(img.imageUrl, {
          responseType: 'arraybuffer',
          timeout: 5000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' }
        });
        const ct = (imgRes.headers['content-type'] || 'image/jpeg').split(';')[0];
        if (!ct.startsWith('image/')) continue;
        res.set('Content-Type', ct);
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(Buffer.from(imgRes.data));
      } catch {}
    }
    res.status(404).end();
  } catch {
    res.status(500).end();
  }
});

// ── STREAMING GENERATE ──
app.post('/api/generate-stream', async (req, res) => {
  const { ingredients, filters, strictIngredients } = req.body;
  if (!ingredients?.length) return res.status(400).json({ error: 'נא לשלוח מרכיבים' });

  const GEN_CUISINES = ['איטלקי','מזרח תיכוני','אסייתי','צרפתי','מקסיקני','הודי','יווני','מרוקאי','ישראלי מודרני','טורקי','לבנוני','פרסי','ספרדי','יפני'];
  const GEN_METHODS  = ['בתנור','מוקפץ','על הגריל','מאודה','מבושל לאט','על מחבת'];
  const randI = a => a[Math.floor(Math.random()*a.length)];
  const CKW = ['איטלקי','יווני','טורקי','מרוקאי','אסייתי','צרפתי','הודי','ספרדי','מקסיקני','יפני','לבנוני','פרסי','ישראלי','ים תיכוני','מזרח תיכוני','תאילנדי','סיני','קוריאני','ארגנטינאי','ברזילאי','אמריקאי','אתיופי','וייטנאמי','אפריקאי','גרמני','פולני','רוסי'];

  const filtersArr = Array.isArray(filters) ? filters : (filters ? [filters] : []);
  const detectedCuisine = filtersArr.find(f => CKW.some(c => f.includes(c)));
  const cuisineInst = detectedCuisine
    ? `חובה: המטבח הוא ${detectedCuisine} בלבד — השתמש אך ורק במרכיבים, תבלינים וטכניקות של מטבח זה. אסור לערבב עם מטבח אחר.`
    : `השראה למטבח (חופשי): ${randI(GEN_CUISINES)}`;
  const nonCuisineFilters = filtersArr.filter(f => !CKW.some(c => f.includes(c)));
  const filterInst = nonCuisineFilters.length > 0 ? ` חייב להיות: ${nonCuisineFilters.join(', ')}.` : '';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `אתה שף יצירתי. צור מתכון מקורי בעברית. החזר JSON בלבד:
{"title":"","description":"","servings":"","difficulty":"קל|בינוני|מאתגר","prep_time":"","cook_time":"","total_time":"","ingredients":[],"instructions":[],"chef_tip":"","imageQuery":""}
imageQuery: 4-7 מילים באנגלית שמתארות בדיוק את המנה — שיטת הבישול + מרכיבים נראים לעין בלבד.`,
      messages: [{ role: 'user', content: `מרכיבים: ${ingredients.join(', ')}.${filterInst}${strictIngredients ? ' השתמש רק במרכיבים אלה + תבלינים/שמן.' : ''} ${cuisineInst}, שיטת בישול: ${randI(GEN_METHODS)}.` }]
    });

    let full = '';
    stream.on('text', t => {
      full += t;
      res.write(`data: ${JSON.stringify({ d: t })}\n\n`);
    });
    stream.on('finalMessage', () => {
      try {
        const m = full.match(/\{[\s\S]*\}/);
        const recipe = m ? JSON.parse(m[0]) : null;
        res.write(`data: ${JSON.stringify({ done: true, recipe })}\n\n`);
      } catch {
        res.write(`data: ${JSON.stringify({ done: true, recipe: null })}\n\n`);
      }
      res.end();
    });
    stream.on('error', () => {
      res.write(`data: ${JSON.stringify({ done: true, recipe: null })}\n\n`);
      res.end();
    });
  } catch (err) {
    console.error('Stream error:', err.message);
    res.write(`data: ${JSON.stringify({ done: true, recipe: null })}\n\n`);
    res.end();
  }
});

// ── CHAT ENDPOINT ──
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  const lang = req.body.lang || 'he';
  const isEn = lang === 'en';
  if (!message) return res.status(400).json({ error: isEn ? 'Message missing' : 'חסרה הודעה' });

  try {
    // שלב 1: זהה כוונה (כולל היסטוריה לטיפול בהמשך שיחה)
    const intentMessages = [
      ...history.slice(-8).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];
    const intentRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system: isEn ? `Identify user intent and return JSON only:
{"action":"search"|"generate"|"chat","ingredients":[],"filters":[],"query":"","strictIngredients":false}
- search: any request to search the internet / "find" / "look up" / "existing recipes"
- generate: any request for AI chef / "create" / "make me" / "original recipe"
- chat: only general cooking questions that are not recipe requests
ingredients: array of ingredients — if continuation, extract from history
filters: array of style/diet/cuisine — include cuisines: "italian","greek","turkish","moroccan","asian","french","indian","spanish","mexican","japanese","lebanese","persian","american","mediterranean","argentinian","brazilian","thai","chinese","korean","vietnamese","ethiopian","german","russian" etc. Include diets: "vegan","vegetarian","gluten-free" etc.
strictIngredients: true only if user said "only with what I have" / "no additions" / "only these ingredients"`
      : `זהה את כוונת המשתמש והחזר JSON בלבד:
{"action":"search"|"generate"|"chat","ingredients":[],"filters":[],"query":"","strictIngredients":false}
- search: כל בקשה לחיפוש מהאינטרנט / "חפש" / "מה יש באינטרנט" / "מתכונים קיימים" — גם ללא מרכיבים
- generate: כל בקשה ל"שף AI" / "תיצור" / "מתכון מקורי" — גם ללא מרכיבים
- chat: רק שאלות כלליות על בישול שאינן בקשת מתכון
ingredients: מערך המרכיבים — אם המשך שיחה, חלץ מההיסטוריה
filters: מערך של סגנון/דיאטה/מטבח — כולל מטבחים: "איטלקי","יווני","טורקי","מרוקאי","אסייתי","צרפתי","הודי","ספרדי","מקסיקני","יפני","לבנוני","פרסי","ישראלי","ים תיכוני","ארגנטינאי","ברזילאי","תאילנדי","סיני","קוריאני","וייטנאמי","אתיופי","גרמני","רוסי" וכו'. כלול גם דיאטות: "טבעוני","צמחוני","ללא גלוטן" וכו'
strictIngredients: true רק אם המשתמש אמר "רק עם מה שיש לי" / "בלי תוספות" / "רק המרכיבים האלה"`,
      messages: intentMessages
    });

    let intent;
    try {
      const m = intentRes.content[0].text.match(/\{[\s\S]*\}/);
      intent = m ? JSON.parse(m[0]) : { action: 'chat', ingredients: [], filters: [], query: message };
    } catch { intent = { action: 'chat', ingredients: [], filters: [], query: message }; }

    // שלב 2: בצע לפי כוונה
    const forcedMode = req.body.mode;
    const forcedIngredients = req.body.ingredients;
    const forcedFilters = req.body.filters;
    const lastIngredientsHint = req.body.lastIngredients;

    if (forcedIngredients?.length > 0) {
      intent.ingredients = forcedIngredients;
      intent.filters = forcedFilters || intent.filters;
    }

    // המשך שיחה: הודעה ללא מרכיבים אך יש מרכיבים מהסיבוב הקודם — קפוץ ישירות לפעולה
    let continuationMode = null;
    if (!forcedMode && !forcedIngredients?.length && intent.ingredients.length === 0 &&
        lastIngredientsHint?.length > 0 && (intent.action === 'generate' || intent.action === 'search')) {
      intent.ingredients = lastIngredientsHint;
      continuationMode = intent.action;
    }

    // אם search/generate ללא מרכיבים — בקש מרכיבים
    if ((intent.action === 'search' || intent.action === 'generate') && intent.ingredients.length === 0 && !forcedMode && !continuationMode) {
      if (isEn) {
        const modeEn = intent.action === 'search' ? 'search online' : 'create an AI recipe';
        return res.json({ type: 'text', text: `Sure! Tell me what ingredients you have and I'll ${modeEn} 🥕` });
      }
      const modeHe = intent.action === 'search' ? 'לחפש באינטרנט' : 'ליצור מתכון שף';
      return res.json({ type: 'text', text: `בשמחה! ספר לי אילו מרכיבים יש לך ואני ${modeHe} 🥕` });
    }

    // אם יש מרכיבים ולא נבחר מצב — שאל קודם
    if ((intent.action === 'search' || intent.action === 'generate') && intent.ingredients.length > 0 && !forcedMode && !continuationMode) {
      return res.json({ type: 'ask_mode', ingredients: intent.ingredients, filters: intent.filters });
    }

    const effectiveAction = forcedMode || continuationMode || intent.action;

    if ((effectiveAction === 'search') && intent.ingredients.length > 0) {
      const filterText = intent.filters.length > 0 ? ` ${intent.filters.join(' ')}` : '';
      const q = isEn
        ? `recipe with ${intent.ingredients.join(' ')}${filterText} cooking instructions`
        : `מתכון עם ${intent.ingredients.join(' ')}${filterText} הוראות הכנה`;
      const searchRes = await axios.post('https://google.serper.dev/search',
        { q, gl: isEn ? 'us' : 'il', hl: isEn ? 'en' : 'iw', num: 8 },
        { headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' } }
      );
      const results = (searchRes.data.organic || []).slice(0, 6);
      if (results.length === 0) return res.json({ type: 'text', text: isEn ? 'No suitable recipes found. Try different ingredients or ask me to create a recipe.' : 'לא מצאתי מתכונים מתאימים. נסה מרכיבים אחרים או בקש שאייצר מתכון.' });

      const aiRes = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: isEn
          ? `You are a helpful cooking assistant. The user searched for recipes with: ${intent.ingredients.join(', ')}.
Analyze search results and return JSON only:
{"recipes":[{"title":"","description":"up to 15 words","dominance":"high|medium|low","source":"","url":""}]}`
          : `אתה עוזר בישול ידידותי. המשתמש חיפש מתכונים עם: ${intent.ingredients.join(', ')}.
נתח את תוצאות החיפוש והחזר JSON בלבד:
{"recipes":[{"title":"","description":"עד 15 מילים","dominance":"גבוה|בינוני|נמוך","source":"","url":""}]}`,
        messages: [{ role: 'user', content: results.map((r,i) => `${i+1}. ${r.title}\n${r.snippet}\n${r.link}`).join('\n\n') }]
      });
      const m2 = aiRes.content[0].text.match(/\{[\s\S]*\}/);
      const parsed = m2 ? JSON.parse(m2[0]) : { recipes: [] };
      return res.json({ type: 'recipes', recipes: parsed.recipes || [], ingredients: intent.ingredients, filters: intent.filters });
    }

    if (effectiveAction === 'generate') {
      const GEN_CUISINES = isEn
        ? ['Italian','Mediterranean','Asian','French','Mexican','Indian','Greek','Moroccan','Modern American','Turkish','Lebanese','Persian','Spanish','Japanese']
        : ['איטלקי','מזרח תיכוני','אסייתי','צרפתי','מקסיקני','הודי','יווני','מרוקאי','ישראלי מודרני','טורקי','לבנוני','פרסי','ספרדי','יפני'];
      const GEN_METHODS = isEn
        ? ['baked','stir-fried','grilled','steamed','slow-cooked','pan-seared']
        : ['בתנור','מוקפץ','על הגריל','מאודה','מבושל לאט','על מחבת'];
      const randI = a => a[Math.floor(Math.random()*a.length)];
      const CUISINE_KW = ['איטלקי','יווני','טורקי','מרוקאי','אסייתי','צרפתי','הודי','ספרדי','מקסיקני','יפני','לבנוני','פרסי','ישראלי','ים תיכוני','מזרח תיכוני','תאילנדי','סיני','קוריאני','ארגנטינאי','ברזילאי','אמריקאי','אתיופי','וייטנאמי','אפריקאי','גרמני','פולני','רוסי'];
      const CUISINE_KW_EN = ['italian','greek','turkish','moroccan','asian','french','indian','spanish','mexican','japanese','lebanese','persian','american','mediterranean','thai','chinese','korean','argentinian','brazilian','ethiopian','vietnamese','african','german','polish','russian'];
      const detectedCuisine = isEn
        ? intent.filters.find(f => CUISINE_KW_EN.some(c => f.toLowerCase().includes(c)))
        : intent.filters.find(f => CUISINE_KW.some(c => f.includes(c)));
      const cuisineInst = isEn
        ? (detectedCuisine ? `Required: cuisine must be ${detectedCuisine} only — use only ingredients, spices and techniques from this cuisine.` : `Cuisine inspiration: ${randI(GEN_CUISINES)}`)
        : (detectedCuisine ? `חובה: המטבח הוא ${detectedCuisine} בלבד — השתמש אך ורק במרכיבים, תבלינים וטכניקות של מטבח זה. אסור לערבב עם מטבח אחר.` : `השראה למטבח (חופשי): ${randI(GEN_CUISINES)}`);
      const nonCuisineFilters = isEn
        ? intent.filters.filter(f => !CUISINE_KW_EN.some(c => f.toLowerCase().includes(c)))
        : intent.filters.filter(f => !CUISINE_KW.some(c => f.includes(c)));
      const filterInst = nonCuisineFilters.length > 0
        ? (isEn ? ` Must be: ${nonCuisineFilters.join(', ')}.` : ` חייב להיות: ${nonCuisineFilters.join(', ')}.`)
        : '';
      const aiRes = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: isEn
          ? `You are a creative chef. Create an original recipe in English. Return JSON only:
{"title":"","description":"","servings":"","difficulty":"easy|medium|challenging","prep_time":"","cook_time":"","total_time":"","ingredients":[],"instructions":[],"chef_tip":"","imageQuery":""}
imageQuery: 4-7 English words describing the dish — include cooking method + visible ingredients only.`
          : `אתה שף יצירתי. צור מתכון מקורי בעברית. החזר JSON בלבד:
{"title":"","description":"","servings":"","difficulty":"קל|בינוני|מאתגר","prep_time":"","cook_time":"","total_time":"","ingredients":[],"instructions":[],"chef_tip":"","imageQuery":""}
imageQuery: 4-7 מילים באנגלית שמתארות בדיוק את המנה הזו — כלול את שיטת הבישול (grilled/baked/stir-fried/steamed/fried וכו') + המרכיבים הנראים לעין. אסור להוסיף מרכיבים או שיטות שלא נמצאים במתכון.`,
        messages: [{ role: 'user', content: isEn
          ? `Main ingredients: ${intent.ingredients.join(', ')}.${filterInst}${intent.strictIngredients ? ' Use only these ingredients + spices/oil.' : ' Feel free to add complementary ingredients.'} ${cuisineInst}, cooking method: ${randI(GEN_METHODS)}.`
          : `מרכיבים עיקריים: ${intent.ingredients.join(', ')}.${filterInst}${intent.strictIngredients ? ' השתמש רק במרכיבים אלה + תבלינים/שמן בלבד.' : ' הרגש חופשי להוסיף מרכיבים שמשדרגים את המנה.'} ${cuisineInst}, שיטת בישול: ${randI(GEN_METHODS)}.` }]
      });
      const m3 = aiRes.content[0].text.match(/\{[\s\S]*\}/);
      const recipe = m3 ? JSON.parse(m3[0]) : null;
      if (!recipe) return res.json({ type: 'text', text: isEn ? 'Error creating recipe, please try again.' : 'שגיאה ביצירת מתכון, נסה שוב.' });
      return res.json({ type: 'recipe', recipe });
    }

    // chat כללי
    const msgs = history.slice(-6).map(h => ({ role: h.role, content: h.content }));
    msgs.push({ role: 'user', content: message });
    const chatRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: isEn
        ? `You are a friendly cooking assistant. Answer in simple conversational English — no asterisks, no headers, no numbered lists, no special symbols. If asked for a recipe, ask what ingredients they have.`
        : `אתה עוזר בישול ידידותי בעברית. ענה בשפה פשוטה ומדוברת, כאילו אתה מדבר עם חבר — בלי כוכביות, בלי כותרות, בלי רשימות ממוספרות, בלי סימני מיוחדים. דבר בעברית רגילה וזורמת. אם מבקשים מתכון — בקש מרכיבים.`,
      messages: msgs
    });
    return res.json({ type: 'text', text: chatRes.content[0].text });

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'שגיאה, נסה שוב' });
  }
});

// מקורות נוספים + מדיה חברתית
app.post('/api/search-more-sources', async (req, res) => {
  const { ingredients, filters, lang } = req.body;
  if (!ingredients?.length) return res.status(400).json({ error: 'missing ingredients' });
  const isEn = lang === 'en';
  const filterText = (filters || []).length > 0 ? ` ${filters.join(' ')}` : '';
  const q = isEn
    ? `recipe with ${ingredients.join(' ')}${filterText}`
    : `מתכון עם ${ingredients.join(' ')}${filterText}`;
  try {
    const [videoRes, socialRes] = await Promise.allSettled([
      axios.post('https://google.serper.dev/videos',
        { q, gl: isEn ? 'us' : 'il', hl: isEn ? 'en' : 'iw', num: 6 },
        { headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' } }
      ),
      axios.post('https://google.serper.dev/search',
        { q: q + ' site:tiktok.com OR site:instagram.com', gl: isEn ? 'us' : 'il', hl: isEn ? 'en' : 'iw', num: 4 },
        { headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' } }
      )
    ]);
    const videos = videoRes.status === 'fulfilled' ? (videoRes.value.data.videos || []) : [];
    const socials = socialRes.status === 'fulfilled' ? (socialRes.value.data.organic || []) : [];
    const results = [
      ...videos.slice(0, 5).map(v => ({
        title: v.title, description: v.snippet || '',
        source: v.channel || 'YouTube', url: v.link, type: 'video'
      })),
      ...socials.slice(0, 3).map(s => ({
        title: s.title, description: s.snippet || '',
        source: s.link.includes('tiktok') ? 'TikTok' : 'Instagram', url: s.link, type: 'social'
      }))
    ];
    res.json({ results });
  } catch (err) {
    console.error('Search more sources:', err.message);
    res.status(500).json({ error: isEn ? 'Error, try again' : 'שגיאה, נסה שוב' });
  }
});

const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.send('ok'));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  const { importAll } = require('./gov-import');
  importAll().catch(err => console.error('[startup] gov-import failed:', err.message));
});
