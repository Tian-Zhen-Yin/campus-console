import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SITES, SITE_KEYS, saveSiteOverride, saveCustomSite, deleteCustomSite, getRawCustom } from './config.mjs';
import { openLoginSession } from './login.mjs';
import { HOME, profileDir, capturedFile, metaFile, outFile, dashboardFile, historyFile, rawFile } from './paths.mjs';
import { readJson, writeJson } from './util.mjs';
import { readApps, importFromText } from './apps.mjs';
import { status } from './status.mjs';
import { keepalive } from './keepalive.mjs';
import { report } from './report.mjs';
import { readFeishuConfig, feishuTest, feishuConfigFile } from './feishu.mjs';
import { readMailConfig, readMailConfigs, saveMailConfigs, pollMail, testMailConnection, readMailLog, PROVIDER_NOTES } from './mail.mjs';
import { startRecording, attachRecorder } from './capture.mjs';
import { extractApplications } from './extract.mjs';
import { chromium } from 'playwright';
import { writeTrackerSync } from './trackerSync.mjs';
import { notify } from './notify.mjs';
import { applyToRecords, setCorrection, isValidStatus } from './corrections.mjs';

// 允许本机 http 页面（如校招投递管理 localhost:8735）直连控制台 API；服务只绑定 127.0.0.1，不对外
function localOrigin(origin) {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return origin;
  } catch (_) {}
  return null;
}

// 本地控制台：node src/cli.mjs ui → http://127.0.0.1:7788
// 只绑定本机回环；同一时刻只跑一个浏览器任务；登录/抓包在网页上点按钮确认。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 校招投递管理（台账前端）由控制台同源托管在 /tracker/ 下：单一入口、直连 API 免跨域、插件桥接（127.0.0.1 已在白名单）不变
// 台账静态目录：环境变量 TRACKER_DIR > 包内 tracker/（完整版安装包自带）> 开发机工作目录（仅本机开发环境存在）
const BUNDLED_TRACKER = path.resolve(__dirname, '..', 'tracker');
// 开发机台账路径走 gitignore 的 dev-local.mjs（公开仓库/安装包中不存在，自动跳过）
let DEV_TRACKER = null;
try { DEV_TRACKER = (await import('./dev-local.mjs')).DEV_TRACKER || null; } catch (_) {}
let TRACKER_DIR = process.env.TRACKER_DIR || null;
  if (!TRACKER_DIR && fs.existsSync(path.join(BUNDLED_TRACKER, 'index.html'))) TRACKER_DIR = BUNDLED_TRACKER;
  if (!TRACKER_DIR) {
    try { TRACKER_DIR = (await import('./dev-local.mjs')).DEV_TRACKER || null; } catch (_) {}
  }
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip', '.wasm': 'application/wasm',
};
function serveTracker(res, urlPath) {
  // 去掉 /tracker 前缀与全部前导斜杠，空路径落到 index.html；用 resolve 后的前缀判断防目录穿越
  let rel = decodeURIComponent(urlPath).replace(/^\/tracker\/?/, '').replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  const root = path.resolve(TRACKER_DIR);
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
  res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(fs.readFileSync(file));
}
const events = [];
const log = (m) => {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`;
  events.push(line);
  if (events.length > 400) events.shift();
  console.log(m);
};

let busy = null; // { kind, logs, done, error, result }
const sessions = new Map(); // id -> { id, site, kind, label, ...rec/fin }
let lastInspection = null;
const resident = new Map(); // site -> { site, label, ctx, page, confirmed, openedAt }
let nextId = 1;

const guard = () => {
  if (busy && !busy.done) return `有任务正在执行（${busy.kind}），等它结束再操作`;
  if (sessions.size) return `有浏览器会话未完成（${[...sessions.values()].map((s) => `${s.label}·${s.kind}`).join('、')}），先完成或放弃`;
  return null;
};

// 后台邮件轮询的单飞守卫：与浏览器查询互不影响（独立 IMAP 连接），只防自己叠自己
let mailPollRunning = false;
function kickMailPoll() {
  if (mailPollRunning || !readMailConfigs().length) return;
  mailPollRunning = true;
  pollMail({})
    .then((r) => {
      if (!r || !r.fresh || !r.fresh.length) return;
      const boxes = (r.accounts || []).map(a => `${a.user}${a.error ? '（失败）' : ''}`).join('、');
      log(`📬 随查询拉取邮件：新增招聘相关 ${r.fresh.length} 封（${boxes}）`);
    })
    .catch(() => {})
    .finally(() => { mailPollRunning = false; });
}

function runJob(kind, fn) {
  if (busy && !busy.done) return { error: 'busy' };
  if (sessions.size) return { error: 'session-open' }; // 浏览器会话占用 profile 时禁止并发查询
  const job = { kind, logs: [], done: false, startedAt: Date.now() };
  busy = job;
  const orig = { log: console.log, err: console.error };
  const tee = (orig2) => (...a) => {
    const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    job.logs.push(s);
    orig2(...a);
  };
  console.log = tee(orig.log);
  console.error = tee(orig.err);
  (async () => {
    try {
      job.result = await fn(job);
      log(`✅ ${kind} 完成`);
    } catch (e) {
      job.error = String(e?.message || e);
      job.logs.push('出错: ' + job.error);
      log(`❌ ${kind} 失败: ${job.error}`);
    } finally {
      console.log = orig.log;
      console.error = orig.err;
      job.done = true;
      job.finishedAt = Date.now();
      setTimeout(() => { if (busy === job) busy = null; }, 8000);
    }
  })();
  return { started: true };
}

async function openSession(kind, site) {
  if (busy && !busy.done) throw new Error('有任务正在执行，稍后再试');
  if (resident.has(site)) throw new Error(`${SITES[site].label} 已有常驻浏览器在运行，查询会直接用它；先「关闭常驻」再登录/抓包`);
  if ([...sessions.values()].some((s) => s.site === site)) throw new Error(`${SITES[site].label} 已有未完成的浏览器会话，先完成或放弃`);
  const id = String(nextId++);
  const s = kind === 'login' ? await openLoginSession(site, log) : await startRecording(site, log);
  const sess = { id, site, kind, label: SITES[site].label, lastScan: [], ...s };
  sessions.set(id, sess);
  log(`🖥 ${sess.label} ${kind === 'login' ? '登录' : '抓包'}会话已打开（Chrome 窗口已弹出）`);
  return sess;
}

// ===== 常驻浏览器（单实例共享）=====
// 一个独立 Chrome 进程（detached，脱离本服务生命周期），所有站点各占一个标签页；
// 不同域名的登录天然互不干扰，共用一个浏览器即可。服务重启后通过固定端口 CDP 重连，登录态不丢。
const SHARED_PORT = Number(process.env.RESIDENT_PORT) || 9350;
const SHARED_DIR = path.join(HOME, 'resident-browser');
let shared = null; // { browser, ctx }

async function probeCDP(port) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return (await res.json()).webSocketDebuggerUrl || null;
  } catch { return null; }
}

const siteCore = (site) => { try { return new URL(SITES[site].entry).hostname.split('.').slice(-2).join('.'); } catch { return ''; } };
function tabForSite(site) {
  if (!shared) return null;
  const core = siteCore(site);
  return shared.ctx.pages().find((p) => {
    try { const h = new URL(p.url()).hostname; return h === core || h.endsWith('.' + core); } catch { return false; }
  }) || null;
}

// 跨平台查找 Chrome/Edge 可执行文件（常驻浏览器需要真实二进制路径）
function findChromeBin() {
  const candidates = process.platform === 'win32'
    ? [
        process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].filter(Boolean)
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

async function ensureShared() {
  if (shared) return shared;
  const s = await tryAttachShared();
  if (s) return s;
  const chromeBin = findChromeBin();
  if (!chromeBin) throw new Error('未找到 Chrome / Edge，无法开启常驻浏览器');
  if (!fs.existsSync(chromeBin)) throw new Error('未找到 Chrome，无法开启常驻浏览器');
  const { execFile } = await import('node:child_process');
  const { sleep } = await import('./util.mjs');
  const child = execFile(chromeBin, [
    `--remote-debugging-port=${SHARED_PORT}`,
    `--user-data-dir=${SHARED_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
    '--disable-blink-features=AutomationControlled',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  let ws = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    ws = await probeCDP(SHARED_PORT);
    if (ws) break;
  }
  if (!ws) throw new Error('常驻浏览器启动超时');
  const browser = await chromium.connectOverCDP(ws);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('CDP 已连上但没有可用上下文');
  shared = { browser, ctx };
  log('🟢 常驻浏览器（独立进程）已启动——所有站点共用这一个窗口，每个站点一个标签页');
  return shared;
}

// 只尝试附着已运行的常驻浏览器（绝不启动新进程）——巡检等只读场景用
async function tryAttachShared() {
  if (shared) return shared;
  const ws = await probeCDP(SHARED_PORT);
  if (!ws) return null;
  const browser = await chromium.connectOverCDP(ws);
  const ctx = browser.contexts()[0];
  if (!ctx) return null;
  shared = { browser, ctx };
  return shared;
}

async function openResident(site) {
  if (busy && !busy.done) throw new Error('有任务正在执行，稍后再试');
  if (resident.has(site)) throw new Error(`${SITES[site].label} 的常驻标签页已打开`);
  const s = await ensureShared();
  let page = tabForSite(site);
  if (!page) {
    page = await s.ctx.newPage();
    await page.goto(SITES[site].entry, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  } else {
    await page.goto(SITES[site].entry, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  resident.set(site, { site, label: SITES[site].label, page, confirmed: false, openedAt: Date.now() });
  log(`🟢 ${SITES[site].label} 标签页已在常驻浏览器中打开——请完成登录后回来点「登录完成」`);
}

// 控制台重启后重连存活的常驻浏览器（登录态不丢）
async function restoreResidents() {
  const ws = await probeCDP(SHARED_PORT);
  if (!ws) { log('ℹ️ 未发现运行中的常驻浏览器'); return; }
  const browser = await chromium.connectOverCDP(ws);
  const ctx = browser.contexts()[0];
  if (!ctx) return;
  shared = { browser, ctx };
  let n = 0;
  for (const site of SITE_KEYS) {
    const page = tabForSite(site);
    if (page) {
      resident.set(site, { site, label: SITES[site].label, page, confirmed: true, openedAt: Date.now() });
      log(`🟢 ${SITES[site].label} 已重连（登录态保持）`);
      n++;
    }
  }
  if (!n) log('ℹ️ 常驻浏览器在运行，但没有识别到已登录的站点标签页');
}

async function closeResidentTab(r) {
  try { if (!r.page.isClosed()) await r.page.close(); } catch { /* 尽力而为 */ }
  resident.delete(r.site);
}

async function closeSharedBrowser() {
  if (!shared) return;
  try {
    const s = await shared.browser.newBrowserCDPSession();
    await s.send('Browser.close');
  } catch {
    await shared.browser.close().catch(() => {});
  }
  shared = null;
  resident.clear();
  log('🟢 常驻浏览器已关闭（所有站点登录态随之失效）');
}

// ===== 巡检 =====
// 轻量体检：登录态（标签页存活/跳转 + 配置了校验接口的站点做接口级确认）、
// 接口定义、最近查询、常驻浏览器进程、邮箱连接。除快手接口级校验外不产生站点请求。
async function buildInspection() {
  const s = await tryAttachShared();
  const items = [];
  for (const k of SITE_KEYS) {
    const cfg = SITES[k];
    const spec = readJson(capturedFile(k));
    const out = readJson(outFile(k));
    const r = resident.get(k);
    let page = r && !r.page.isClosed() ? r.page : (s ? tabForSite(k) : null);
    let session = { level: 'none', detail: '未接入' };
    if (page) {
      const url = page.url();
      if (/login|signin|passport|havana/i.test(url)) {
        session = { level: 'dead', detail: '标签页已跳转登录页（会话失效，重新常驻登录即可）' };
      } else {
        session = { level: 'ok', detail: '标签页存活，未跳登录页' };
      }
      if (cfg.residentCheck) {
        try {
          const res = await page.evaluate(async (p) => {
            try {
              const resp = await fetch(p, { headers: { accept: 'application/json' } });
              return { status: resp.status, body: await resp.json().catch(() => null) };
            } catch { return { status: -1, body: null }; }
          }, cfg.residentCheck).catch(() => ({ status: -1, body: null }));
          const okLogin = res.status === 200 && res.body && Number(res.body.code) === 0;
          session = okLogin
            ? { level: 'ok', detail: '接口级登录校验通过' }
            : { level: 'dead', detail: `接口级校验未通过（http ${res.status}）——重新常驻登录即可` };
        } catch (e) {
          session = { level: 'warn', detail: '校验执行失败: ' + (e?.message || e) };
        }
      }
    } else if (fs.existsSync(profileDir(k))) {
      session = { level: 'warn', detail: '有历史会话存档，常驻未开，无法确认有效性' };
    }
    items.push({
      site: k, label: cfg.label, session,
      spec: spec ? `${spec.mode}模式${spec.verified ? '（已验证）' : ''}` : (cfg.seeds ? '有预置' : '未抓包'),
      last: out ? { at: out.at, count: (out.records || []).length } : null,
    });
  }
  let mail = { level: 'none', detail: '未配置' };
  if (readMailConfig()) {
    const r = await testMailConnection();
    mail = r.ok
      ? { level: 'ok', detail: `IMAP 连接正常（收件箱 ${r.count} 封）` }
      : { level: 'dead', detail: '连接失败：' + (r.error || '').slice(0, 80) };
  }
  return {
    at: new Date().toISOString(),
    browserAlive: await probeCDP(SHARED_PORT).then(Boolean).catch(() => false),
    items, mail,
  };
}

function buildState() {
  const feishu = readFeishuConfig();
  const laDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  return {
    now: Date.now(),
    home: HOME,
    sites: Object.keys(SITES).map((k) => {
      const cfg = SITES[k];
      const spec = readJson(capturedFile(k));
      const meta = readJson(metaFile(k));
      const out = readJson(outFile(k));
      return {
        key: k,
        label: cfg.label,
        risk: cfg.risk,
        riskLevel: cfg.risk.startsWith('高') ? 'high' : cfg.risk.startsWith('中') ? 'mid' : 'low',
        builtin: !cfg.custom,
        hasProfile: fs.existsSync(profileDir(k)),
        hasSpec: !!spec,
        hasSeeds: !!cfg.seeds,
        spec: spec ? { mode: spec.mode, verified: !!spec.verified, url: spec.url, capturedAt: spec.capturedAt } : null,
        last: out ? { at: out.at, via: out.via, records: applyToRecords(k, out.records) } : null,
        heartbeat: meta ? { intervalMin: meta.intervalMin, lastBeatAt: meta.lastBeatAt } : { intervalMin: (cfg.heartbeat || {}).startMin || 720, lastBeatAt: 0 },
      entry: cfg.entry,
      };
    }),
    apps: readApps(),
    feishu: {
      configured: !!feishu,
      webhookMasked: feishu ? feishu.webhook.replace(/^(https:\/\/[^/]+\/).*/i, '$1…') : '',
      hasSecret: !!(feishu && feishu.secret),
    },
    dashboard: fs.existsSync(dashboardFile()) ? { mtimeMs: fs.statSync(dashboardFile()).mtimeMs } : null,
    platform: process.platform,
    services: process.platform === 'win32'
      ? {
          console: winTaskExists('CampusConsole-Autostart'),
          schedule: ['CampusSchedule-0930', 'CampusSchedule-1430', 'CampusSchedule-2000'].every((t) => winTaskExists(t)),
        }
      : {
          // 与实际安装的 plist 同名：console=服务常驻（KeepAlive），schedule=查询+邮件定时
          console: fs.existsSync(path.join(laDir, 'com.ats-status.console.plist')),
          schedule: fs.existsSync(path.join(laDir, 'com.ats-status.schedule.plist')),
        },
    busy: busy ? { kind: busy.kind, logs: busy.logs, done: busy.done, error: busy.error } : null,
    sessions: [...sessions.values()].map((s) => ({ id: s.id, site: s.site, kind: s.kind, label: s.label })),
    residents: [...resident.values()].map((r) => ({ site: r.site, label: r.label, confirmed: r.confirmed, openedAt: r.openedAt, pageUrl: (r.page && !r.page.isClosed() && r.page.url()) || '' })),
    mail: (() => {
      const accounts = readMailConfigs();
      const mask = (u) => String(u).replace(/^(.{3}).*(@.*)$/, '$1****$2');
      const recent = readMailLog(15);
      return {
        configured: accounts.length > 0,
        accounts: accounts.map(a => ({ user: a.user, userMasked: mask(a.user), provider: a.provider })),
        userMasked: accounts[0] ? mask(accounts[0].user) : '',
        recent, lastAt: recent[0]?.at || null,
      };
    })(),
    lastInspection,
    events: events.slice(-60),
  };
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('请求体不是合法 JSON')); } });
    req.on('error', reject);
  });
}

function winTaskExists(name) {
  try { execSync(`schtasks /Query /TN "${name}" >nul 2>&1`, { shell: true }); return true; } catch { return false; }
}

async function route(req, res, url) {
  const p = url.pathname;
  const allowOrigin = localOrigin(req.headers.origin);
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    if (allowOrigin) res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET') {
    // 台账即首页：日常使用的界面；工程面板收进 /console/
    if (p === '/console' || p === '/console/') return send(res, 200, fs.readFileSync(path.join(__dirname, 'web-ui.html')), 'text/html; charset=utf-8');
    if (p === '/tracker' || p.startsWith('/tracker/')) { res.writeHead(302, { location: p.replace(/^\/tracker\/?/, '/') || '/' }); return res.end(); }
    if (p === '/guide') {
      const f = path.join(__dirname, '..', 'docs', 'guide.html');
      return send(res, 200, fs.readFileSync(f), 'text/html; charset=utf-8');
    }
    if (p.startsWith('/guide-img/')) {
      // 使用指南的界面截图：docs/guide-img/ 下的静态文件（防目录穿越）
      const rel = decodeURIComponent(p).replace(/^\/guide-img\//, '');
      const root = path.resolve(__dirname, '..', 'docs', 'guide-img');
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(file), STATIC_TYPES[path.extname(file)] || 'application/octet-stream');
    }
    if (p === '/dashboard') {
      const f = dashboardFile();
      if (!fs.existsSync(f)) return send(res, 404, '<meta charset="utf-8">面板还没生成，先点「生成面板」或跑 report', 'text/html; charset=utf-8');
      return send(res, 200, fs.readFileSync(f), 'text/html; charset=utf-8');
    }
    if (p === '/api/state') return json(res, 200, buildState());
    if (p === '/api/tracker-sync') {
      // 供台账直连拉取最新状态包（基于当前 out/*.json 即时生成，不触发查询）
      try { return json(res, 200, writeTrackerSync({ quiet: true })); }
      catch (e) { return json(res, 500, { error: String(e?.message || e) }); }
    }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    return serveTracker(res, p);
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  const body = await readBody(req);

  switch (p) {
    case '/api/sites/save': {
      const label = String(body.label || '').trim();
      const entry = String(body.entry || '').trim();
      const loginNote = String(body.loginNote || '').trim().slice(0, 200);
      const riskMap = { low: '低', mid: '中', high: '高' };
      const risk = riskMap[body.risk] || '中';
      const startMin = Math.max(60, Math.min(2880, Math.round((Number(body.startHours) || 12) * 60)));
      if (!label) return json(res, 400, { error: '需要站点名称' });
      let u;
      try { u = new URL(entry); } catch { return json(res, 400, { error: '入口 URL 无效（需 http/https）' }); }
      if (!['http:', 'https:'].includes(u.protocol)) return json(res, 400, { error: '入口 URL 需以 http(s) 开头' });
      const ov = { label, entry, risk, startMin, floorMin: Math.max(60, Math.floor(startMin / 2)), ...(loginNote ? { loginNote } : {}) };
      const key = String(body.key || '').trim();
      if (key && SITES[key]) {
        if (SITES[key].custom) {
          const raw = getRawCustom(key) || { key };
          saveCustomSite({ ...raw, ...ov });
          log(`✏️ 自定义站点已更新：${label}`);
        } else {
          saveSiteOverride(key, ov);
          log(`✏️ 内置站点覆盖已保存：${label}`);
        }
        return json(res, 200, { ok: true, key });
      }
      // 新增：生成唯一 key
      let nk = 'c' + Date.now().toString(36);
      while (SITES[nk]) nk = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);
      saveCustomSite({ key: nk, label, entry, loginNote: loginNote || undefined, risk, startMin, floorMin: ov.floorMin });
      log(`🟢 新增自定义站点：${label}（${entry}）`);
      return json(res, 200, { ok: true, key: nk });
    }
    case '/api/sites/delete': {
      const key = String(body.key || '').trim();
      const merged = SITES[key] ? { label: SITES[key].label, custom: SITES[key].custom } : null;
      if (!merged) return json(res, 404, { error: '站点不存在' });
      if (!merged.custom) return json(res, 400, { error: '内置站点不可删除（可编辑入口/保活参数）' });
      // 顺手清理该站数据：会话 profile / 接口定义 / 查询结果 / 保活元数据
      const r = resident.get(key);
      if (r) { try { if (!r.page.isClosed()) await r.page.close(); } catch { /* ignore */ } resident.delete(key); }
      for (const f of [profileDir(key), capturedFile(key), outFile(key), historyFile(key), metaFile(key), rawFile(key)]) {
        fs.rmSync(f, { recursive: true, force: true });
      }
      deleteCustomSite(key);
      log(`🗑 已删除自定义站点：${merged.label}（含会话与数据）`);
      return json(res, 200, { ok: true });
    }
    case '/api/inspect': {
      const ok = runJob('inspection', async () => {
        lastInspection = await buildInspection();
        const bad = lastInspection.items.filter((i) => i.session.level === 'dead');
        const warn = lastInspection.items.filter((i) => i.session.level === 'warn');
        console.log(`🔎 巡检完成：正常 ${lastInspection.items.filter((i) => i.session.level === 'ok').length}，存疑 ${warn.length}，失效 ${bad.length}${lastInspection.mail.level === 'ok' ? '，邮箱正常' : lastInspection.mail.level === 'dead' ? '，邮箱连接失败' : ''}`);
        if (bad.length) for (const i of bad) console.log(`  ⚠️ ${i.label}: ${i.session.detail}`);
      });
      if (!ok.started) return json(res, 409, { error: '有任务进行中，稍后再试' });
      return json(res, 200, { ok: true });
    }
    case '/api/status': {
      const site = body.site || null;
      // 定时任务三时点只打 /api/status：顺手后台拉一次邮件，邀约安排才能自动出现（失败不影响查询）
      kickMailPoll();
      const ok = runJob(site ? `status:${site}` : 'status:all', async () => {
        const one = async (k, autoOpen) => {
          const r = resident.get(k);
          let page = r ? r.page : null;
          if (page && page.isClosed()) { page = null; resident.delete(k); }
          if (!page && shared) page = tabForSite(k);
          if (!page && autoOpen && shared) {
            page = await shared.ctx.newPage();
            await page.goto(SITES[k].entry, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
          }
          if (!page && !fs.existsSync(profileDir(k))) { log(`${SITES[k].label}: 未登录，跳过（先常驻登录）`); return; }
          const opts = page ? { page, raw: true } : { raw: true };
          const out = await status(k, opts);
          if (out && out.ok === false && out.reason === 'no-spec') log(`⚠️ ${SITES[k].label}: 该站点还没有可用接口——请在常驻窗口打开「我的申请」页后点「抓包」识别一次`);
        };
        if (site) await one(site, true);
        else for (const k of SITE_KEYS) await one(k, false);
      });
      if (!ok.started) return json(res, 409, { error: ok.error === 'session-open' ? '有浏览器会话未完成（登录/抓包），先完成或放弃再查' : busy?.kind + ' 进行中' });
      return json(res, 200, { ok: true });
    }
    case '/api/records/correct': {
      const site = String(body.site || '');
      const job = String(body.job || '');
      if (!SITES[site] || !job) return json(res, 400, { error: '参数缺失（site/job）' });
      try {
        if (body.reset) {
          setCorrection(site, job, null);
          log(`✏️ ${SITES[site].label}「${job}」已恢复官网状态`);
        } else {
          if (!isValidStatus(body.status)) return json(res, 400, { error: '未知状态码' });
          const fix = setCorrection(site, job, String(body.status));
          log(`✏️ ${SITES[site].label}「${job}」人工修正为「${fix.statusRaw}」`);
        }
        try { writeTrackerSync({ quiet: true }); } catch (_) {}
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: String(e?.message || e) }); }
    }
    case '/api/mail/config': {
      const provider = ['163', 'qq', 'gmail'].includes(body.provider) ? body.provider : '163';
      const user = String(body.user || '').trim();
      const pass = String(body.pass || '').trim();
      const mask = (u) => String(u).replace(/^(.{3}).*(@.*)$/, '$1****$2');
      if (body.remove) {
        if (!user) return json(res, 400, { error: '需要邮箱账号' });
        const rest = readMailConfigs().filter(a => a.user !== user);
        saveMailConfigs(rest);
        log(`📬 已移除邮箱监控：${mask(user)}（剩 ${rest.length} 个）`);
        return json(res, 200, { ok: true, count: rest.length });
      }
      if (!user) return json(res, 400, { error: '需要邮箱账号' });
      const accounts = readMailConfigs();
      const existing = accounts.find(a => a.user === user);
      const accountPass = pass || (existing && existing.pass);
      if (!accountPass) return json(res, 400, { error: '需要授权码' });
      const meta = PROVIDER_NOTES[provider] || {};
      const next = [
        ...accounts.filter(a => a.user !== user),
        { provider, user, pass: accountPass, host: meta.host || 'imap.163.com', port: 993, secure: true },
      ];
      saveMailConfigs(next);
      log(`📬 邮箱监控已保存：${mask(user)}（共 ${next.length} 个邮箱）`);
      return json(res, 200, { ok: true, count: next.length });
    }
    case '/api/mail/test': {
      const accounts = readMailConfigs();
      const target = body.user ? accounts.find(a => a.user === body.user) : accounts[0];
      const r = await testMailConnection(target);
      if (r.unconfigured) return json(res, 400, { error: '未配置邮箱' });
      log(r.ok ? `📬 邮箱连接测试成功（收件箱 ${r.count} 封）` : `⚠️ 邮箱连接失败: ${r.error || ''}`);
      return json(res, 200, r);
    }
    case '/api/mail/poll': {
      const ok = runJob('mail:poll', async () => {
        const r = await pollMail({});
        if (r.unconfigured) { log('⚠️ 邮箱未配置'); return; }
        for (const a of r.accounts || []) {
          if (a.error) log(`⚠️ ${a.user} 拉取失败: ${a.error}`);
          else log(`📬 ${a.user}：扫描 ${a.scanned} 封，新增招聘相关 ${(a.fresh || []).length} 封`);
        }
        if (r.fresh.length) {
          const { execFile: ef2 } = await import('node:child_process');
          await notify('📬 招聘邮件', `收到 ${r.fresh.length} 封招聘相关邮件`);
          const { pushMailNote } = await import('./feishu.mjs');
          await pushMailNote(r.fresh);
        }
      });
      if (!ok.started) return json(res, 409, { error: '有任务进行中，稍后再试' });
      return json(res, 200, { ok: true });
    }
    case '/api/report': {
      const ok = runJob('report', () => report({}));
      if (!ok.started) return json(res, 409, { error: ok.error === 'session-open' ? '有浏览器会话未完成，先完成或放弃' : busy?.kind + ' 进行中' });
      return json(res, 200, { ok: true });
    }
    case '/api/keepalive': {
      const ok = runJob('keepalive', () => keepalive({ once: true, ignoreQuiet: !!body.ignoreQuiet }));
      if (!ok.started) return json(res, 409, { error: ok.error === 'session-open' ? '有浏览器会话未完成，先完成或放弃' : busy?.kind + ' 进行中' });
      return json(res, 200, { ok: true });
    }
    case '/api/import': {
      const r = importFromText(String(body.text || ''));
      if (r.empty) return json(res, 400, { error: '没解析到记录（JSON 数组，或 CSV：公司,岗位,状态,投递时间,链接）' });
      log(`📥 手工列表导入：新增 ${r.added}，共 ${r.total}`);
      return json(res, 200, r);
    }
    case '/api/feishu': {
      const webhook = String(body.webhook || '').trim();
      if (webhook && !/^https:\/\/[a-z.]*feishu\.cn\//i.test(webhook)) return json(res, 400, { error: 'webhook 应该是 open.feishu.cn 的机器人地址' });
      const secret = String(body.secret || '').trim();
      if (!webhook && !secret) { try { fs.rmSync(feishuConfigFile()); } catch { /* 没有就算了 */ } log('飞书推送配置已清除'); return json(res, 200, { ok: true, cleared: true }); }
      writeJson(feishuConfigFile(), secret ? { webhook, secret } : { webhook });
      log('飞书推送配置已保存');
      return json(res, 200, { ok: true });
    }
    case '/api/feishu/test': {
      const r = await feishuTest();
      return json(res, 200, r);
    }
    case '/api/login': {
      try { await openSession('login', String(body.site || '')); }
      catch (e) { return json(res, 409, { error: e.message }); }
      return json(res, 200, { ok: true });
    }
    case '/api/login/confirm': {
      const s = sessions.get(String(body.id || ''));
      if (!s || s.kind !== 'login') return json(res, 404, { error: '会话不存在' });
      const n = await s.finish();
      sessions.delete(s.id);
      log(`✅ ${s.label} 登录完成（${n} 条 cookie 已保存）`);
      return json(res, 200, { ok: true, cookies: n });
    }
    case '/api/capture/scan': {
      const s = sessions.get(String(body.id || ''));
      if (!s || s.kind !== 'capture') return json(res, 404, { error: '会话不存在' });
      const cands = s.scan();
      s.lastScan = cands;
      log(`🔍 ${s.label} 识别到 ${cands.length} 个候选接口`);
      return json(res, 200, {
        candidates: cands.slice(0, 5).map((c, i) => {
          const ex = extractApplications(c.body);
          return { index: i, method: c.method, url: c.url, pageUrl: c.pageUrl, status: c.status, records: ex.records.slice(0, 5) };
        }),
      });
    }
    case '/api/capture/pick': {
      const s = sessions.get(String(body.id || ''));
      if (!s || s.kind !== 'capture') return json(res, 404, { error: '会话不存在' });
      const chosen = s.lastScan[Number(body.index) || 0];
      if (!chosen) return json(res, 400, { error: '请先「识别候选接口」' });
      const r = await s.pick(chosen);
      sessions.delete(s.id);
      log(`✅ ${s.label} 接口已保存（${r.spec.mode} 模式${r.spec.verified ? '，已验证' : ''}）`);
      return json(res, 200, { ok: true, mode: r.spec.mode, verified: !!r.spec.verified, records: r.records.length, url: r.spec.url });
    }
    case '/api/capture/abort':
    case '/api/login/abort': {
      const s = sessions.get(String(body.id || ''));
      if (!s) return json(res, 404, { error: '会话不存在' });
      if (s.kind === 'login') await s.finish(); else await s.close();
      sessions.delete(s.id);
      log(`✖ 已放弃 ${s.label} 的${s.kind === 'login' ? '登录' : '抓包'}会话`);
      return json(res, 200, { ok: true });
    }
    case '/api/resident': {
      try { await openResident(String(body.site || '')); }
      catch (e) { return json(res, 409, { error: e.message }); }
      return json(res, 200, { ok: true });
    }
    case '/api/resident/confirm': {
      const r = resident.get(String(body.site || ''));
      if (!r) { log('⚠️ confirm：常驻浏览器不存在（页面可能是旧的，请刷新控制台页面）'); return json(res, 404, { error: '常驻浏览器不存在——请刷新控制台页面后重走「常驻登录」' }); }
      const cfg = SITES[r.site];
      // 有校验接口的站点：用她页面自己的身份发一次同源请求，登录没真正完成就不允许确认
      if (cfg.residentCheck) {
        const page = r.page;
        if (!page) { log('⚠️ confirm：浏览器里没有打开的页面'); return json(res, 409, { error: '常驻浏览器里没有打开的页面' }); }
        const cur = page.url();
        if (!/kuaishou\.cn/.test(cur)) {
          log(`⚠️ confirm：页面不在招聘站 ${cur}`);
          return json(res, 409, { error: `当前页面不在招聘站（${cur.slice(0, 80)}）——请在该窗口里完成登录` });
        }
        const check = await page.evaluate(async (p) => {
          try {
            const res = await fetch(p, { headers: { accept: 'application/json' } });
            return { status: res.status, body: await res.json().catch(() => null) };
          } catch (e) { return { status: -1, body: null, err: String(e) }; }
        }, cfg.residentCheck).catch((e) => ({ status: -1, body: null, err: String(e) }));
        const okLogin = check.status === 200 && check.body && Number(check.body.code) === 0;
        if (!okLogin) {
          const why = `登录校验未通过（页面在 ${cur.slice(0, 90)}；http ${check.status}${check.body && check.body.message ? '，' + check.body.message : ''}${check.err ? '，' + check.err : ''}）——请在常驻窗口里登录到能看到「我的投递」列表，再点「登录完成」`;
          log(`⚠️ ${r.label} ${why}`);
          return json(res, 409, { error: why });
        }
        r.confirmed = true;
        const u = check.body.result || {};
        log(`✅ ${r.label} 常驻浏览器就绪，登录校验通过（${u.number || u.phone || u.id || 'user'}）`);
        return json(res, 200, { ok: true, user: u.number || u.id || null });
      }
      r.confirmed = true;
      log(`✅ ${r.label} 常驻浏览器已就绪`);
      return json(res, 200, { ok: true });
    }
    case '/api/resident/close': {
      const r = resident.get(String(body.site || ''));
      if (!r) return json(res, 404, { error: '常驻标签页不存在' });
      await closeResidentTab(r);
      log(`🟡 ${r.label} 常驻标签页已关闭（浏览器与其他站点登录不受影响）`);
      return json(res, 200, { ok: true });
    }
    case '/api/resident/browser/close': {
      await closeSharedBrowser();
      return json(res, 200, { ok: true });
    }
    case '/api/capture': {
      const site = String(body.site || '');
      const r = resident.get(site);
      if (r) {
        // 挂到常驻浏览器上录制：不开新浏览器，直接录她登录着的窗口
        const id = String(nextId++);
        const rec = attachRecorder(site, shared.ctx, log);
        const sess = { id, site, kind: 'capture', label: SITES[site].label, lastScan: [], scan: rec.scan, pick: rec.pick, close: rec.detachAll };
        sessions.set(id, sess);
        log(`🖥 ${sess.label} 抓包已挂到常驻浏览器——请在常驻窗口里打开「我的申请/我的投递」页，加载完成后回来点「识别候选接口」`);
        return json(res, 200, { ok: true, resident: true });
      }
      try { await openSession('capture', site); }
      catch (e) { return json(res, 409, { error: e.message }); }
      return json(res, 200, { ok: true });
    }
    default:
      return json(res, 404, { error: 'not found' });
  }
}

export function startServer({ port = Number(process.env.PORT) || 7788, host = '127.0.0.1', openBrowser = true } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    route(req, res, url).catch((e) => json(res, 500, { error: String(e?.message || e) }));
  });
  return new Promise((resolve) => {
    server.listen(port, host, async () => {
      await restoreResidents().catch(() => {});
      const url = `http://${host}:${port}`;
      log(`控制台已启动 → ${url}（只绑定本机，数据不出电脑）`);
      if (openBrowser) {
        if (process.platform === 'darwin') execFile('open', [url]);
        else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true });
        else execFile('xdg-open', [url]);
      }
      resolve(server);
    });
    server.on('error', (e) => {
      console.error(`端口 ${port} 启动失败（${e.message}）。换个端口：PORT=7890 node src/cli.mjs ui`);
      resolve(null);
    });
  });
}
