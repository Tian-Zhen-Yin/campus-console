import fs from 'node:fs';
import { chromium } from 'playwright';
const ver = await (await fetch('http://127.0.0.1:9330/json/version')).json();
const browser = await chromium.connectOverCDP(ver.webSocketDebuggerUrl);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0];
console.log('附着页面:', page.url());
const recs = [];
page.on('response', async (r) => {
  try {
    const req = r.request();
    if (!['xhr', 'fetch'].includes(req.resourceType())) return;
    let body = '';
    try { body = (await r.text()).slice(0, 500); } catch { body = '(不可读)'; }
    recs.push({ method: req.method(), status: r.status(), url: r.url().slice(0, 170), bodyHead: body.replace(/\s+/g, ' ').slice(0, 350) });
    fs.writeFileSync('/tmp/bytedance-diag.json', JSON.stringify(recs, null, 1));
  } catch {}
});
await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('reload:', e.message));
await page.waitForTimeout(15000);
console.log('捕获', recs.length, '条 XHR → /tmp/bytedance-diag.json');
process.exit(0);
