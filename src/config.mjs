import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './paths.mjs';

// 六家站点配置。seeds 来自 2026-09 对 JS bundle / 接口的实测：
//  - 快手: bundle main.56697014.js, $basePath="/recruit/e" + "/api/v1/user/apply/position"
//  - 小红书: bundle main.9332a1b.js, /websiterecruit/apply/getApplyHistory(POST, 未登录401"请登录")
//  - 携程: careers.ctrip.com 页面直挂 Moka 双租户(校招 trip / 海外社招 tripoverseas)
//  - 阿里: talent.alibaba.com 淘系统一登录(Havana), API 走 mtop 网关(带签名→页面模式回放)
//  - 字节/美团: API 在懒加载 chunk 中, 由 capture 流程运行时识别
//
// 频率策略（原则：宁可掉线重登，不可高频触封）：
//  - heartbeat.startMin/floorMin：保活间隔分钟数。初始都从 720(12h) 起步；
//    floorMin 是掉线后自动降频的下限。floor = start 表示「永不加密，掉线即人工重登」。
//  - 阿里(实测 baxia 反爬)、小红书(实测 redcaptcha)为高风险站点，禁用自动加密。
const TEL = /apm|monitor|sentry|tracker|beacon|captcha|analytics|\/sec\/v1|collect\/report|burdock/i;

export const SITES = {
  bytedance: {
    label: '字节跳动',
    entry: 'https://jobs.bytedance.com/',
    loginNote: '手机号+短信验证码，或飞书/抖音扫码；登录后打开「个人中心-我的投递」',
    statusHints: ['user', 'center', 'my', 'apply', 'deliver', 'progress', 'candidate'],
    exclude: [TEL],
    risk: '中',
    heartbeat: { startMin: 720, floorMin: 360 },
  },
  alibaba: {
    label: '阿里巴巴',
    entry: 'https://talent.alibaba.com/',
    loginNote: '淘宝/阿里统一账户（Havana）登录，可能跳 taobao 登录页；校招在 /campus 下。API 走 mtop 网关，识别后自动改用页面模式回放',
    statusHints: ['my', 'apply', 'progress', 'center', 'deliver', 'process', 'mtop'],
    exclude: [TEL],
    risk: '高（登录页实测 baxia 反爬 + mtop 签名网关）',
    heartbeat: { startMin: 720, floorMin: 720 },
  },
  meituan: {
    label: '美团',
    entry: 'https://zhaopin.meituan.com/web/home',
    loginNote: '美团 App 扫码或手机验证码；登录后打开「我的投递/投递进度」',
    statusHints: ['my', 'apply', 'deliver', 'progress', 'center', 'process'],
    exclude: [TEL],
    risk: '中',
    heartbeat: { startMin: 720, floorMin: 360 },
  },
  ctrip: {
    label: '携程',
    entry: 'https://app.mokahr.com/campus-recruitment/trip/117988#/jobs',
    extraEntries: ['https://hire-r1.mokahr.com/apply/tripoverseas/100000877#/jobs'],
    loginNote: 'Moka 托管：页面内注册/登录（手机号+短信验证码），登录后进「个人中心/我的申请」。海外社招是另一个租户（hire-r1），两边账号不互通，需分别 capture',
    statusHints: ['apply', 'candidate', 'personal', 'center', 'my', 'progress'],
    exclude: [TEL, /udesk/],
    risk: '低（Moka 多租户 SaaS，候选人侧宽容）',
    heartbeat: { startMin: 720, floorMin: 180 },
  },
  xiaohongshu: {
    label: '小红书',
    entry: 'https://job.xiaohongshu.com/campus',
    loginNote: '手机号+验证码或扫码；未登录会跳 /login?redirectUrl=/campus。校招主入口 /campus，登录后打开「我的投递/投递状态」',
    statusHints: ['apply', 'candidate', 'websiterecruit', 'my'],
    exclude: [TEL, /redcaptcha/],
    risk: '高（bundle 实测 redcaptcha 风控）',
    heartbeat: { startMin: 720, floorMin: 720 },
    seeds: [
      {
        name: '投递历史（预置）',
        url: 'https://job.xiaohongshu.com/websiterecruit/apply/getApplyHistory',
        method: 'POST', body: '{}',
        urlMatch: 'apply/getApplyHistory',
        statusPageUrl: 'https://job.xiaohongshu.com/campus',
      },
      {
        name: '投递状态（预置）',
        url: 'https://job.xiaohongshu.com/websiterecruit/apply/getApplyStatus',
        method: 'GET',
        urlMatch: 'apply/getApplyStatus',
        statusPageUrl: 'https://job.xiaohongshu.com/campus',
      },
    ],
  },
  kuaishou: {
    label: '快手',
    entry: 'https://campus.kuaishou.cn/recruit/campus/e/#/campus/my-apply',
    extraEntries: ['https://zhaopin.kuaishou.cn/'],
    // 常驻登录确认时的登录态校验接口（同源 fetch，带页面自身 cookie）
    residentCheck: '/recruit/campus/e/api/users/user/info',
    loginNote: '手机号+短信。校招主入口 campus.kuaishou.cn，社招 zhaopin.kuaishou.cn；cookie 按域名隔离——两边都投就在两边各登一次（同一浏览器 profile）',
    statusHints: ['apply', 'my', 'center', 'user', 'campus'],
    exclude: [TEL],
    risk: '低（裸 API，未见验证码）',
    heartbeat: { startMin: 720, floorMin: 180 },
    seeds: [
      {
        name: '校招投递列表（预置）',
        url: 'https://campus.kuaishou.cn/recruit/campus/e/api/v1/apply/record/list?pageSize=0',
        method: 'GET',
        urlMatch: 'campus/e/api/v1/apply/record/list',
        statusPageUrl: 'https://campus.kuaishou.cn/recruit/campus/e/#/campus/my-apply',
      },
      {
        name: '社招投递列表（预置）',
        url: 'https://zhaopin.kuaishou.cn/recruit/e/api/v1/user/apply/position',
        method: 'GET',
        urlMatch: 'recruit/e/api/v1/user/apply/position',
        statusPageUrl: 'https://zhaopin.kuaishou.cn/',
      },
    ],
  },
};

// ===== 自定义站点与覆盖层 =====
// 内置六家保持调优参数不可删；用户可新增自定义站点（完整 CRUD），
// 也可对内置站点做覆盖（改名称/入口/保活等）。全部存 ~/.ats-status/custom-sites.json。
const CUSTOM_FILE = path.join(HOME, 'custom-sites.json');
function readCustomFile() {
  try {
    const d = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
    return { sites: Array.isArray(d.sites) ? d.sites : [], overrides: d.overrides || {} };
  } catch { return { sites: [], overrides: {} }; }
}
function writeCustomFile(d) {
  fs.mkdirSync(path.dirname(CUSTOM_FILE), { recursive: true });
  fs.writeFileSync(CUSTOM_FILE, JSON.stringify(d, null, 2));
}
function applyOverride(site, ov) {
  const s = { ...site };
  if (ov.label) s.label = ov.label;
  if (ov.entry) s.entry = ov.entry;
  if (ov.loginNote) s.loginNote = ov.loginNote;
  if (ov.startMin) s.heartbeat = { startMin: ov.startMin, floorMin: ov.floorMin || ov.startMin };
  if (ov.risk) s.risk = ov.risk;
  return s;
}
function compileCustom(c) {
  return {
    label: c.label,
    entry: c.entry,
    loginNote: c.loginNote || '登录后打开「我的投递 / 申请记录」页面',
    statusHints: Array.isArray(c.statusHints) && c.statusHints.length ? c.statusHints : ['apply', 'my', 'center', 'record'],
    exclude: [TEL],
    risk: c.risk || '中',
    heartbeat: { startMin: c.startMin || 720, floorMin: c.floorMin || Math.floor((c.startMin || 720) / 2) },
    custom: true,
  };
}
(function mergeCustomSites() {
  const { sites = [], overrides = {} } = readCustomFile();
  for (const [key, ov] of Object.entries(overrides)) {
    if (SITES[key]) Object.assign(SITES[key], applyOverride(SITES[key], ov));
  }
  for (const c of sites) {
    if (!SITES[c.key]) SITES[c.key] = compileCustom(c);
    else Object.assign(SITES[c.key], compileCustom(c));
  }
})();
export function saveSiteOverride(key, ov) {
  const d = readCustomFile();
  d.overrides = d.overrides || {};
  d.overrides[key] = { ...(d.overrides[key] || {}), ...ov };
  if (SITES[key]) Object.assign(SITES[key], applyOverride(SITES[key], d.overrides[key]));
  writeCustomFile(d);
}
export function saveCustomSite(c) {
  const d = readCustomFile();
  d.sites = (d.sites || []).filter((s) => s.key !== c.key);
  d.sites.push(c);
  writeCustomFile(d);
  if (!SITES[c.key]) SITES[c.key] = compileCustom(c);
  else Object.assign(SITES[c.key], compileCustom(c));
}
export function deleteCustomSite(key) {
  const d = readCustomFile();
  d.sites = (d.sites || []).filter((s) => s.key !== key);
  if (d.overrides) delete d.overrides[key];
  writeCustomFile(d);
  delete SITES[key];
}
export function getRawCustom(key) {
  return readCustomFile().sites.find((s) => s.key === key) || null;
}

export const SITE_KEYS = Object.keys(SITES);
