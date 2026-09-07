import fs from 'node:fs';
import { chromium } from 'playwright';
const ver = await (await fetch('http://127.0.0.1:9331/json/version')).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];
console.log('附着页面:', page.url());
const recs = [];
page.on('response', async (r) => {
  try {
    const req = r.request();
    let body = '';
    try { body = (await r.text()).slice(0, 400); } catch { body = '(不可读)'; }
    recs.push({
      type: req.resourceType(), method: req.method(), status: r.status(),
      ctype: (r.headers()['content-type'] || '').slice(0, 50),
      url: r.url().slice(0, 190),
      bodyHead: body.replace(/\s+/g, ' ').slice(0, 260),
    });
    fs.writeFileSync('/tmp/alibaba-diag.json', JSON.stringify(recs, null, 1));
  } catch {}
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('reload:', e.message));
await page.waitForTimeout(15000);
console.log('捕获', recs.length, '条请求 → /tmp/alibaba-diag.json');
process.exit(0);
