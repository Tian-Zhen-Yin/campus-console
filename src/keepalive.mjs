import fs from 'node:fs';
import { SITES } from './config.mjs';
import { launch } from './session.mjs';
import { profileDir, capturedFile, metaFile } from './paths.mjs';
import { readJson, writeJson, nowIso, pad, sleep } from './util.mjs';
import { replayApi, looksAuthFail } from './replay.mjs';

// 保活策略：宁可掉线重登，不可高频触封。
//  - 每站点默认 12h 一次，±40% 抖动，杜绝整点节拍器模式
//  - 静默时段（08:00–23:30 之外）零流量
//  - 高风险站点（阿里/小红书）掉线后不自动加密，直接等人工重登；
//    低风险站点掉线后间隔减半试探，下限 3h——如果到了下限还掉线，
//    说明是短时/绝对过期，应该放弃保活（要查时再登录），而不是继续加密。
//  - 页面模式站点（或未 capture）的保活是整页访问：站点自己的 JS 自然续期
//    cookie，流量形态与真人打开页面无异；绝不裸打带签名的接口。

const QUIET_OPEN = 8 * 60;        // 08:00（本地分钟）
const QUIET_CLOSE = 23 * 60 + 30; // 23:30
const JITTER = 0.4;

const minutesNow = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const inQuietWindow = () => { const m = minutesNow(); return m < QUIET_OPEN || m > QUIET_CLOSE; };
const minUntilOpen = () => ((QUIET_OPEN - minutesNow()) % 1440 + 1440) % 1440;
const jittered = (min) => Math.max(1, Math.round(min * (1 + JITTER * (Math.random() * 2 - 1))));

function loadMeta(site, cfg) {
  const m = readJson(metaFile(site)) || {};
  if (!m.intervalMin || m.intervalMin > cfg.heartbeat.startMin) m.intervalMin = cfg.heartbeat.startMin;
  return m;
}

// 单站点一次保活动作，返回 'ok' | 'auth' | 'fail'
async function beat(site) {
  const cfg = SITES[site];
  const spec = readJson(capturedFile(site));
  const ctx = await launch(site, { headless: true });
  try {
    if (spec && spec.mode === 'api') {
      const r = await replayApi(ctx, spec);
      if (looksAuthFail(r)) return 'auth';
      return r.ok ? 'ok' : 'fail';
    }
    const page = ctx.pages()[0] || (await ctx.newPage());
    const target = (spec && spec.statusPageUrl) || cfg.entry;
    try { await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch { /* 超时也可能已加载 */ }
    const low = page.url().toLowerCase();
    if (/login|signin|passport|havana/.test(low) && !(cfg.entry || '').toLowerCase().includes('login')) return 'auth';
    return 'ok';
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function keepalive(opts = {}) {
  const keys = Object.keys(SITES).filter((k) => fs.existsSync(profileDir(k)));
  if (!keys.length) { console.log('还没有任何已登录站点（先 login / capture）。'); return; }
  do {
    if (inQuietWindow() && !opts.ignoreQuiet) {
      if (opts.once) {
        console.log(`[${nowIso()}] 静默时段（08:00–23:30 之外不产生流量），本轮跳过。`);
        return;
      }
      const wait = minUntilOpen() + Math.random() * 90;
      console.log(`[${nowIso()}] 静默时段，约 ${Math.round(wait / 60 * 10) / 10} 小时后继续`);
      await sleep(wait * 60_000);
      continue;
    }
    console.log(`\n[${nowIso()}] 保活轮询：${keys.map((k) => SITES[k].label).join('、')}`);
    let nextDueMin = Infinity;
    for (const k of keys) {
      const cfg = SITES[k];
      const meta = loadMeta(k, cfg);
      const since = (Date.now() - (meta.lastBeatAt || 0)) / 60000;
      if (since < meta.intervalMin) {
        console.log(`  ${pad(cfg.label, 8)} 未到间隔（还差 ${Math.round(meta.intervalMin - since)} 分钟），跳过`);
        nextDueMin = Math.min(nextDueMin, meta.intervalMin - since);
        continue;
      }
      const res = await beat(k);
      meta.lastBeatAt = Date.now();
      if (res === 'auth') {
        meta.intervalMin = Math.max(cfg.heartbeat.floorMin, Math.floor(meta.intervalMin / 2));
        const capped = meta.intervalMin === cfg.heartbeat.floorMin && cfg.heartbeat.floorMin === cfg.heartbeat.startMin;
        console.log(`  ${pad(cfg.label, 8)} !! 会话失效 → 请重新 login（保活间隔 ${capped ? '保持' : '调整为'} ${meta.intervalMin} 分钟${capped ? '，高风险站点不自动加密' : ''}）`);
      } else {
        console.log(`  ${pad(cfg.label, 8)} ${res === 'ok' ? 'ok' : '网络失败，下次再试'} · 间隔 ${meta.intervalMin} 分钟`);
      }
      writeJson(metaFile(k), meta);
      nextDueMin = Math.min(nextDueMin, meta.intervalMin);
      await sleep(20_000 + Math.random() * 40_000); // 站点之间错开
    }
    if (opts.once) break;
    const wait = jittered(Math.min(Math.max(nextDueMin, 15), opts.interval || 720));
    console.log(`下一轮：约 ${Math.round(wait)} 分钟后`);
    await sleep(wait * 60_000);
  } while (true);
}
