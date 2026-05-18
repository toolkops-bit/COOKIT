// Worker script — מופעל כתהליך נפרד עם windowsHide:true
// args: chain query
const [,, chain, query] = process.argv;
if (!chain || !query) process.exit(1);

(async () => {
  try {
    const scraper = require(`./${chain}`);
    await scraper.scrapeProduct(query);
    process.exit(0);
  } catch (e) {
    process.exit(1);
  }
})();
