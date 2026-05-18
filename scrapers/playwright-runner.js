const { spawn } = require('child_process');
const path = require('path');

const WORKER = path.join(__dirname, 'run-playwright.js');

// מפעיל סקרייפר Playwright בתהליך נסתר (ללא חלון CMD)
function runHidden(chain, query) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, chain, query], {
      windowsHide: true,   // מסתיר CMD ב-Windows
      detached: false,
      stdio: 'ignore',
    });
    child.on('close', resolve);
    child.on('error', () => resolve());
    // timeout: אם הסקרייפר תקוע יותר מ-60 שנ' — הרוג אותו
    setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 60000);
  });
}

module.exports = { runHidden };
