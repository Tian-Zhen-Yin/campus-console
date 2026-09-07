import fs from 'node:fs';
import { SITES } from './config.mjs';
import { launch } from './session.mjs';
import { capturedFile, outFile, historyFile, rawFile } from './paths.mjs';
import { readJson, writeJson, appendJsonl, nowIso, table, unwrapJsonp } from './util.mjs';
import { extractApplications } from './extract.mjs';
import { replayApi, looksAuthFail, envelopeFail } from './replay.mjs';
import { writeTrackerSync } from './trackerSync.mjs';

// 查询某站点当前投递状态。无已保存接口时自动尝试预置 seeds。
// API 直连失败（签名/风控）自动降级为页面模式：打开状态页截获同一接口的响应。
export async function status(site, opts = {}) {
  const cfg = SITES[site];
  if (!cfg) throw new Error(`未知站点 ${site}（可用: ${Object.keys(SITES).join(', ')}）`);
  const candidates = readJson(capturedFile(site)) ? [readJson(capturedFile(site))] : (cfg.seeds || []).map((s) => ({ mode: 'api', verified: false, ...s }));
  if (!candidates.length) {
    console.log(`${cfg.label}: 尚无可用接口，请先运行: node src/cli.mjs capture ${site}`);
    return { ok: false, reason: 'no-spec' };
  }

  // opts.ctx：外部传入已登录的常驻浏览器上下文（web 控制台用），此时不关闭
  const ctx = opts.ctx || await launch(site, { headless: !opts.headed });
  try {
    let text = null, via = null, authFail = false;
    const probes = [];
    for (const spec of candidates) {
      const r = await trySpec(ctx, cfg, spec, opts);
      probes.push(...(r.probes || []));
      if (r.text) { text = r.text; via = r.via; break; }
      if (r.authFail) authFail = true;
    }
    if (!text) {
      if (opts.raw) writeJson(rawFile(site), { at: nowIso(), authFail, probes });
      console.log(authFail
        ? `${cfg.label}: 会话已失效 → node src/cli.mjs login ${site}`
        : `${cfg.label}: 未能取到数据。接口可能需要参数或已改版 → 重跑 capture 更新；或加 --raw 查看原始返回`);
      return { ok: false, reason: authFail ? 'auth' : 'no-data' };
    }

    if (opts.raw) writeJson(rawFile(site), { at: nowIso(), via, bodyHead: text.slice(0, 20000) });
    const ex = extractApplications(text);
    if (!ex.records.length) {
      const head = text.slice(0, 240).replace(/\s+/g, ' ');
      console.log(`${cfg.label}: 接口通了但没识别到投递记录（可能确实没有投递）。返回开头: ${head}`);
      if (opts.raw) console.log(`原始返回已保存 → ${rawFile(site)}`);
      return { ok: true, records: [] };
    }

    const prev = lastHistory(site);
    const stamp = nowIso();
    writeJson(outFile(site), { site, at: stamp, via, records: ex.records });
    appendJsonl(historyFile(site), { at: stamp, records: ex.records.map(({ job, statusRaw, status }) => ({ job, statusRaw, status })) });
    // 同步刷新「校招投递管理」的状态包；失败不影响本次查询结果
    try { writeTrackerSync({ quiet: true }); } catch (e) { console.warn(`状态包更新失败（不影响本次查询）：${e.message}`); }
    console.log(`\n=== ${cfg.label}（via ${via}，${stamp}）===`);
    console.log(table(ex.records, [
      { key: 'job', title: '岗位', width: 36 },
      { key: 'city', title: '地点', width: 10 },
      { key: 'statusRaw', title: '状态', width: 22 },
      { key: 'status', title: '归一', width: 10 },
      { key: 'appliedAt', title: '投递时间', width: 20 },
    ]));
    const changes = ex.records.filter((r) => prev.has(r.job) && prev.get(r.job) !== r.statusRaw);
    if (changes.length) {
      console.log('\n状态变化:');
      for (const c of changes) console.log(`  ${c.job}: ${prev.get(c.job)} → ${c.statusRaw}`);
    }
    return { ok: true, records: ex.records };
  } finally {
    if (!opts.ctx) await ctx.close().catch(() => {});
  }
}

// 注入页面的钩子：截获 SPA 解密后 JSON.parse 出的明文对象（对付 Moka 等加密返回的站点）
const HOOK_SCRIPT = `
(() => {
  if (window.__atsHooked) return;
  window.__atsHooked = [];
  const orig = JSON.parse;
  JSON.parse = function () {
    const out = orig.apply(this, arguments);
    try { if (window.__atsHooked.length < 300) window.__atsHooked.push(out); } catch {}
    return out;
  };
})();
`;

async function tryHookedDecrypted(page, fallbackText, probes) {
  try {
    const hooked = await page.evaluate(() => (window.__atsHooked || []).slice(-150));
    for (let i = hooked.length - 1; i >= 0; i--) {
      const ex = extractApplications(JSON.stringify(hooked[i]));
      if (ex.records.length) {
        probes.push({ kind: 'hook', records: ex.records.length });
        return JSON.stringify(hooked[i]);
      }
    }
  } catch { /* 页面跳转期间可能取不到 */ }
  return fallbackText;
}

async function trySpec(ctx, cfg, spec, opts) {
  const probes = [];
  let authFail = false;

  // pagefetch 模式：在常驻标签页内用页面自己的身份发同源 fetch——
  // 不导航、不刷新（短会话站点整页刷新会重新鉴权，被踢回登录页）
  if (spec.mode === 'pagefetch') {
    const page = opts.page || ctx.pages()[0] || (await ctx.newPage());
    const origin = new URL(spec.url).origin;
    try {
      if (!page.url().startsWith(origin)) {
        await page.goto(spec.statusPageUrl || origin, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      }
      const text = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { headers: { accept: 'application/json' }, credentials: 'include' });
          return await r.text();
        } catch (e) { return 'FETCH_ERR ' + String(e); }
      }, spec.url);
      probes.push({ kind: 'pagefetch', url: spec.url, head: text.slice(0, 300) });
      if (text.startsWith('FETCH_ERR')) return { authFail: false, probes };
      if (looksAuthFail({ status: 200, text }) || envelopeFail(text)) {
        return { authFail: looksAuthFail({ status: 200, text }), probes };
      }
      return { text, via: 'pagefetch', probes };
    } catch (e) {
      probes.push({ kind: 'pagefetch', error: String(e?.message || e) });
      return { probes };
    }
  }

  if (spec.mode !== 'page') {
    const r = await replayApi(ctx, spec);
    probes.push({ kind: 'api', method: spec.method, status: r.status, head: r.text.slice(0, 2000) });
    const jsonable = r.ok && /^[\s]*[[{]/.test(r.text);
    if (jsonable && !envelopeFail(r.text)) return { text: r.text, via: 'api', probes };
    if (looksAuthFail(r) || (jsonable && envelopeFail(r.text) && looksAuthFail({ status: 200, text: r.text }))) {
      // 不立即判死：登录态可能藏在 localStorage/请求头里（纯 cookie 回放带不上），先让页面模式兜底
      authFail = true;
    }
    // 继续走页面模式兜底
  }
  // 页面选择：优先用传入的指定标签页（常驻浏览器里该站点登录着的那个），
  // sessionStorage 里的登录态按标签页隔离，骑错标签页会是未登录状态；不要关闭它
  const page = opts.page || ctx.pages()[0] || (await ctx.newPage());
  await page.addInitScript(HOOK_SCRIPT).catch(() => {});
  const hits = [];
  const h = async (resp) => {
    try {
      const rt = resp.request().resourceType();
      // script 类型：截获 JSONP（阿里 mtop 等网关的返回形式）
      if (!['xhr', 'fetch'].includes(rt) && !(rt === 'script' && /[?&]callback=/.test(resp.url()))) return;
      if (spec.urlMatch && !resp.url().includes(spec.urlMatch)) return;
      hits.push(unwrapJsonp(await resp.text()));
    } catch { /* ignore */ }
  };
  page.on('response', h);
  const target = spec.statusPageUrl || cfg.entry;
  console.log(`页面模式：打开 ${target} 截获接口…`);
  try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch { /* 超时也可能已加载 */ }
  if (!hits.length) { try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch { /* ignore */ } }
  if (!hits.length) { try { await page.reload({ waitUntil: 'networkidle', timeout: 20000 }); } catch { /* ignore */ } }
  page.off('response', h);
  probes.push({ kind: 'page', statusPageUrl: target, hits: hits.length, finalUrl: page.url() });
  if (hits.length) return { text: await tryHookedDecrypted(page, hits[hits.length - 1], probes), via: 'page', probes };
  const low = page.url().toLowerCase();
  const onLogin = /login|signin|passport|havana/.test(low);
  const entryIsLogin = (cfg.entry || '').toLowerCase().includes('login');
  if (onLogin && !entryIsLogin) return { authFail: true, probes };
  return { authFail, probes };
}

function lastHistory(site) {
  const f = historyFile(site);
  if (!fs.existsSync(f)) return new Map();
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  if (!lines.length) return new Map();
  try {
    const last = JSON.parse(lines[lines.length - 1]);
    return new Map(last.records.map((r) => [r.job, r.statusRaw]));
  } catch { return new Map(); }
}
