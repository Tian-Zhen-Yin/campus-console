import fs from 'node:fs';
import { launch } from './src/session.mjs';
import { profileDir } from './src/paths.mjs';

// 快手校招一次性诊断：全量记录页面请求（不过滤），30 秒滚动存档到 /tmp/kuaishou-diag.json
// 并周期性转储 localStorage 到 /tmp/kuaishou-ls.json。浏览器保持打开，直到进程被杀。

const recs = [];
const dump = () => { try { fs.writeFileSync('/tmp/kuaishou-diag.json', JSON.stringify(recs, null, 1)); } catch {} };

const ctx = await launch('kuaishou', { headless: false });
const page = ctx.pages()[0] || (await ctx.newPage());
page.on('response', async (r) => {
  try {
    const req = r.request();
    const url = r.url();
    if (!/kuaishou\.cn/.test(url)) return;
    const ctype = r.headers()['content-type'] || '';
    let bodyHead = '';
    if (['xhr', 'fetch'].includes(req.resourceType())) {
      try { bodyHead = (await r.text()).slice(0, 400); } catch { bodyHead = '(读取失败)'; }
    }
    const rh = {};
    for (const [k, v] of Object.entries(req.headers())) {
      if (/^x-|token|auth|cookie/i.test(k)) rh[k] = String(v).slice(0, 120);
    }
    recs.push({
      t: new Date().toISOString().slice(11, 19),
      type: req.resourceType(),
      method: req.method(),
      status: r.status(),
      ctype: ctype.slice(0, 40),
      url: url.slice(0, 180),
      reqHeaders: rh,
      bodyHead,
    });
    if (recs.length > 1000) recs.splice(0, recs.length - 1000);
    dump();
  } catch { /* ignore */ }
});

await page.goto('https://campus.kuaishou.cn/recruit/campus/e/#/campus/my-apply', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
console.log(`[diag] 浏览器已打开（profile: ${profileDir('kuaishou')}）`);
console.log('[diag] 请在里面完成登录并进入「我的投递」列表页。');
setInterval(async () => {
  dump();
  try {
    const ls = await page.evaluate(() => {
      const o = {};
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = String(localStorage.getItem(k)).slice(0, 120); }
      return o;
    });
    fs.writeFileSync('/tmp/kuaishou-ls.json', JSON.stringify(ls, null, 1));
  } catch { /* 页面跳转期间可能失败 */ }
}, 30000);
console.log('[diag] 录制中…每 30 秒存档。诊断完成后由外部结束本进程。');
