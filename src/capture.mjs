import { SITES } from './config.mjs';
import { launch } from './session.mjs';
import { capturedFile } from './paths.mjs';
import { prompt, writeJson, readJson, nowIso, table, unwrapJsonp } from './util.mjs';
import { extractApplications } from './extract.mjs';
import { replayApi } from './replay.mjs';

const KEY_URLS = /(status|progress|history|myapp|my-?apply|applylist|applic|deliver|schedule|interview|offer|center|process)/i;
const BODY_WORDS = ['投递', '简历', '面试', '笔试', 'offer', 'Offer', '不匹配', '已查看', '筛选', '录用', '申请', '进度', '候选人'];

const cleanKey = (url) => { try { const u = new URL(url); return u.host + u.pathname; } catch { return url; } };

// 录制器：绑定到任意浏览器上下文记录 XHR。向导自开的浏览器与常驻浏览器共用。
export function attachRecorder(site, ctx, log = () => {}) {
  const cfg = SITES[site];
  if (!cfg) throw new Error(`未知站点 ${site}`);
  const existing = readJson(capturedFile(site));
  if (existing) log(`注意：已有已保存接口（${existing.name || existing.url}），本次成功后将覆盖。`);

  const seen = new Map();
  const attached = [];
  async function onResp(page, r) {
    try {
      const req = r.request();
      const rt = req.resourceType();
      const url = r.url();
      // JSONP（阿里 mtop 等）：以 script 形式加载、URL 带 callback 参数
      if (!['xhr', 'fetch'].includes(rt)) {
        if (rt !== 'script' || !/[?&]callback=/.test(url)) return;
      }
      if ((cfg.exclude || []).some((rx) => rx.test(url))) return;
      const ctype = r.headers()['content-type'] || '';
      if (!/(json|javascript|ecma)/i.test(ctype) && rt !== 'script') return;
      let body = await r.text();
      if (!body || body.length > 800000) return;
      body = unwrapJsonp(body);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers())) {
        if (k.startsWith('x-') && !/x-requested-with|x-request-id|x-trace/.test(k)) headers[k] = v;
      }
      seen.set(`${req.method()} ${cleanKey(url)}`, { url, method: req.method(), status: r.status(), body, headers, pageUrl: page.url() });
    } catch { /* 忽略单条读取失败 */ }
  }
  const attach = (page) => {
    const h = (r) => onResp(page, r);
    page.on('response', h);
    attached.push({ page, h });
  };
  ctx.pages().forEach(attach);
  ctx.on('page', attach);
  const detachAll = () => { for (const { page, h } of attached) { try { page.off('response', h); } catch { /* 已关闭 */ } } attached.length = 0; };

  return {
    scan: () => rank([...seen.values()], cfg),
    pick: (chosen) => saveSpec(site, chosen, cfg, ctx),
    detachAll,
  };
}

// 抓包向导的浏览器会话：自开浏览器 + 录制器
export async function startRecording(site, log = () => {}) {
  const cfg = SITES[site];
  if (!cfg) throw new Error(`未知站点 ${site}`);
  const ctx = await launch(site, { headless: false });
  const rec = attachRecorder(site, ctx, log);
  return {
    site,
    cfg,
    ctx,
    scan: rec.scan,
    pick: rec.pick,
    close: async () => { rec.detachAll(); await ctx.close().catch(() => {}); },
  };
}

// 验证所选接口并保存：直连成功 → API 模式；否则降级页面模式。
export async function saveSpec(site, chosen, cfg, ctx) {
  const spec = buildSpec(site, chosen, cfg);
  const replay = await replayApi(ctx, spec);
  const exr = replay.ok ? extractApplications(replay.text) : { records: [], ok: false };
  if (replay.ok && (exr.records.length || exr.reason === 'ok')) {
    spec.mode = 'api';
    spec.verified = true;
  } else {
    spec.mode = 'page';
    spec.verified = false;
  }
  spec.capturedAt = nowIso();
  writeJson(capturedFile(site), spec);
  return { spec, replayStatus: replay.status, replayError: replay.error, records: exr.records };
}

function rank(list, cfg) {
  const scored = [];
  for (const c of list) {
    if (c.status >= 400) continue;
    let s = 0;
    const low = c.url.toLowerCase();
    // URL 语义分：投递/我的/进度这类关键词（零记录的候选全靠它证明自己不是配置类噪音）
    let urlSem = 0;
    for (const k of cfg.statusHints || []) if (low.includes(k.toLowerCase())) urlSem += 2;
    if (KEY_URLS.test(low)) urlSem += 3;
    s += urlSem;
    if (c.method === 'POST') s += 1;
    // 同源 API（与来源页面同主机）本身就是强信号——空列表的投递接口也应可识别
    try { if (new URL(c.url).host === new URL(c.pageUrl).host) s += 3; } catch { /* 忽略 */ }
    for (const w of BODY_WORDS) if (c.body.includes(w)) s += 3;
    const ex = extractApplications(c.body);
    if (ex.records.length) s += 4 + Math.min(ex.records.length, 5);
    // 零记录的候选至少要有 URL 语义分（applic/apply/my/center 等之一），否则多为配置类噪音
    const minUrlSem = ex.records.length ? 0 : 3;
    if (s >= 6 && urlSem >= minUrlSem) scored.push({ ...c, _s: s });
  }
  return scored.sort((a, b) => b._s - a._s);
}

function buildSpec(site, c, cfg) {
  let urlMatch = '';
  try {
    const u = new URL(c.url);
    urlMatch = u.pathname.split('/').filter(Boolean).slice(-2).join('/');
  } catch { /* keep '' */ }
  return {
    site,
    name: cfg.label,
    url: c.url,
    method: c.method,
    body: c.method === 'POST' ? c.body : null,
    headers: c.headers,
    statusPageUrl: c.pageUrl,
    urlMatch,
  };
}

// 终端抓包向导（原流程，Web 控制台见 web.mjs）
export async function capture(site) {
  const rec = await startRecording(site, console.log);
  const cfg = rec.cfg;
  console.log(`\n=== ${cfg.label} 抓包向导 ===`);
  console.log(`1) 在弹出的浏览器里登录。${cfg.loginNote}`);
  console.log('2) 登录后打开「我的投递 / 投递进度 / 我的申请」页面，等它加载完成');
  console.log('3) 回到终端按回车识别接口；选错了按 n 重扫');
  try {
    while (true) {
      const ans = await prompt('\n浏览器操作完成后按回车（q 放弃退出）> ');
      if (ans.toLowerCase() === 'q') break;
      const cands = rec.scan();
      if (!cands.length) { console.log('未识别到候选接口——确认已登录且目标页面加载完成（新开窗口也会被记录）。'); continue; }
      cands.slice(0, 3).forEach((c, i) => {
        const ex = extractApplications(c.body);
        console.log(`\n[${i + 1}] ${c.method} ${c.url}`);
        console.log(`    来源页面: ${c.pageUrl}`);
        console.log(`    http ${c.status}，识别到投递记录 ${ex.records.length} 条`);
        if (ex.records.length) {
          console.log(table(ex.records.slice(0, 5),
            [{ key: 'job', title: '岗位', width: 36 }, { key: 'statusRaw', title: '原始状态', width: 20 }, { key: 'status', title: '归一', width: 10 }])
            .split('\n').map((l) => '    ' + l).join('\n'));
        }
      });
      const pick = await prompt('选择接口序号 [1]（回车=1，n=重扫）> ');
      if (pick.toLowerCase() === 'n') continue;
      const chosen = cands[(parseInt(pick, 10) || 1) - 1];
      if (!chosen) continue;

      const r = await rec.pick(chosen);
      if (r.spec.mode === 'api') {
        console.log('\n接口直连回放成功 → API 模式（已验证，后续查询不再开页面）');
      } else {
        console.log(`\nAPI 直连不可用（http ${r.replayStatus}${r.replayError ? '，' + r.replayError : ''}，多为签名/风控）→ 页面模式：查询时自动打开页面截获同一接口`);
      }
      console.log(`已保存 → ${capturedFile(site)}`);
      console.log(`现在可以运行: node src/cli.mjs status ${site}`);
      break;
    }
  } finally {
    await rec.close();
  }
}
