require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { getPricesForQuery, upsertPrice, logScrape, searchGovPrices, searchGovPricesMulti } = require('./price-db');

const scrapers = {};
['shufersal', 'rami-levy'].forEach(name => {
  try { scrapers[name] = require(`./scrapers/${name}`); } catch(e) { console.warn(`Scraper ${name} unavailable:`, e.message); }
});
const { runHidden } = require('./scrapers/playwright-runner');

const PLAYWRIGHT_CHAINS = ['tivtaam', 'keshet-teamim', 'freshmarket'];
const GOV_CHAINS = new Set(['shufersal', 'victory', 'hazi-hinam']);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// חיפוש מתכונים לפי מרכיבים
app.post('/api/search', async (req, res) => {
  const { ingredients, filter } = req.body;
  if (!ingredients || ingredients.length === 0) {
    return res.status(400).json({ error: 'נא להזין לפחות מרכיב אחד' });
  }

  const filters = Array.isArray(filter) ? filter : (filter ? [filter] : []);
  const filterText = filters.length > 0 ? ` ${filters.join(' ')}` : '';
  const query = `מתכון עם ${ingredients.join(' ')}${filterText} הוראות הכנה`;

  try {
    const searchResponse = await axios.post(
      'https://google.serper.dev/search',
      { q: query, gl: 'il', hl: 'iw', num: 10 },
      {
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const results = searchResponse.data.organic || [];
    console.log(`Serper returned ${results.length} results`);
    if (results.length === 0) {
      return res.json({ recipes: [], aiGenerated: null });
    }

    // AI מנתח את התוצאות ומחלץ מתכונים רלוונטיים
    const resultsText = results.map((r, i) =>
      `${i + 1}. כותרת: ${r.title}\nתיאור: ${r.snippet}\nקישור: ${r.link}`
    ).join('\n\n');

    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: `אתה עוזר בחיפוש מתכונים. המשתמש חיפש מתכונים עם המרכיבים: ${ingredients.join(', ')}.
      תפקידך לנתח את תוצאות החיפוש ולהחזיר JSON בלבד עם המתכונים הרלוונטיים ביותר.
      דרג את המתכונים לפי כמה המרכיבים שחיפשו הם דומיננטיים במתכון.
      החזר JSON בפורמט הזה בלבד, ללא טקסט נוסף. תיאור לא יעלה על 15 מילים:
      {
        "recipes": [
          {
            "title": "שם המתכון",
            "description": "תיאור קצר עד 15 מילים",
            "dominance": "גבוה/בינוני/נמוך",
            "source": "שם האתר",
            "url": "קישור"
          }
        ]
      }`,
      messages: [{ role: 'user', content: resultsText }]
    });

    let parsed;
    try {
      const text = aiResponse.content[0].text.trim();
      console.log('AI response:', text.substring(0, 300));
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { recipes: [] };
      console.log(`Parsed ${parsed.recipes?.length || 0} recipes`);
    } catch (e) {
      console.error('Parse error:', e.message);
      parsed = { recipes: [] };
    }

    res.json(parsed);
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'שגיאה בחיפוש, נסה שוב' });
  }
});

// יצירת מתכון חדש עם AI
const CUISINES = ['איטלקי', 'מזרח תיכוני', 'אסייתי', 'צרפתי', 'מקסיקני', 'הודי', 'יווני', 'מרוקאי', 'ספרדי', 'ישראלי מודרני', 'יפני', 'לבנוני', 'פרסי', 'טורקי'];
const METHODS  = ['בתנור', 'מוקפץ', 'על הגריל', 'מאודה', 'קר / ללא בישול', 'מבושל לאט', 'על מחבת', 'אפוי', 'מטוגן עמוק', 'בסיר לחץ'];
const FORMATS  = ['מנה ראשונה', 'ארוחה עיקרית', 'ממרח / דיפ', 'פאי / קיש', 'כריך גורמה', 'גראטן', 'טרטלט', 'עוגת בשר', 'רולדה', 'סלט חם', 'פסטה', 'ריזוטו', 'קציצות', 'קרפ / בלינץ'];
const rand = arr => arr[Math.floor(Math.random() * arr.length)];
let lastGeneratedTitle = null;

app.post('/api/generate', async (req, res) => {
  const { ingredients, filter } = req.body;
  if (!ingredients || ingredients.length === 0) {
    return res.status(400).json({ error: 'נא להזין לפחות מרכיב אחד' });
  }

  const filters = Array.isArray(filter) ? filter : (filter ? [filter] : []);
  const filterInstruction = filters.length > 0 ? ` המתכון חייב להיות: ${filters.join(', ')}.` : '';

  const cuisine = rand(CUISINES);
  const method  = rand(METHODS);
  const format  = rand(FORMATS);

  try {
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      system: `אתה שף יצירתי ברמה עולמית עם ניסיון של 20 שנה במטבחים מובילים.
תפקידך לייצר מתכונים מקוריים, מפתיעים ומגוונים בעברית.

כללים שאסור לשבור:
- אסור לייצר מנה זהה או דומה מאוד למה שיצרת בפעם הקודמת
- גוון בין ארוחות, מרקמים, וטכניקות בישול
- חשוב מחוץ לקופסה: מה פחות מוכר אבל טעים עם המרכיב?
- כמויות מדויקות ומציאותיות לכל מרכיב
- הוראות מפורטות עם זמנים ספציפיים
- טיפ מקצועי שמשדרג את המתכון

החזר תמיד JSON בלבד, ללא שום טקסט מחוץ ל-JSON.`,
      messages: [{
        role: 'user',
        content: `צור מתכון מקורי ומפורט בעברית עם המרכיבים: ${ingredients.join(', ')}.${filterInstruction}
${lastGeneratedTitle ? `\nחשוב: המתכון האחרון שיצרת היה "${lastGeneratedTitle}" — אסור לחזור על אותו סוג מנה. תהיה שונה לחלוטין.\n` : ''}
השראה לפעם הזאת (אם לא מתנגש עם הפילטרים — השתמש בה, אחרת היה יצירתי בדרכך):
• מטבח: ${cuisine}
• שיטת בישול: ${method}
• סוג המנה: ${format}

החזר JSON בפורמט הזה בלבד:
{
  "title": "שם המתכון",
  "description": "תיאור מפתה של המנה ב-2-3 משפטים",
  "servings": "מספר מנות (לדוגמה: 4 מנות)",
  "difficulty": "קל / בינוני / מאתגר",
  "prep_time": "זמן הכנה (לדוגמה: 15 דקות)",
  "cook_time": "זמן בישול/אפייה (לדוגמה: 30 דקות)",
  "total_time": "זמן כולל",
  "ingredients": ["מרכיב 1 עם כמות מדויקת", "מרכיב 2 עם כמות מדויקת"],
  "instructions": ["שלב 1 מפורט עם זמנים", "שלב 2 מפורט"],
  "chef_tip": "טיפ מקצועי אחד שמשדרג את המתכון"
}`
      }]
    });

    const text = aiResponse.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const recipe = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!recipe) return res.status(500).json({ error: 'שגיאה ביצירת המתכון' });
    lastGeneratedTitle = recipe.title;
    console.log(`Generated: [${cuisine}/${method}/${format}] → ${recipe.title}`);
    res.json(recipe);
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: 'שגיאה ביצירת מתכון, נסה שוב' });
  }
});

// קבלת פרטי מתכון מאתר מקור
app.post('/api/recipe-details', async (req, res) => {
  const { url, title } = req.body;
  if (!url) return res.status(400).json({ error: 'חסר קישור' });

  try {
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `בהתבסס על שם המתכון "${title}" מהאתר ${url}, צור מתכון מלא בעברית עם הוראות הכנה.
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

const PORT = process.env.PORT || 3000;
app.get('/health', (req, res) => res.send('ok'));
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
