#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { SITES, SITE_KEYS } from './config.mjs';
import { HOME, ensureDirs, profileDir, capturedFile, metaFile } from './paths.mjs';
import { pad, readJson } from './util.mjs';
import { login } from './login.mjs';
import { capture } from './capture.mjs';
import { status } from './status.mjs';
import { keepalive } from './keepalive.mjs';
import { report } from './report.mjs';
import { writeTrackerSync } from './trackerSync.mjs';
import { importApps, listApps } from './apps.mjs';
import { feishuTest } from './feishu.mjs';

const [, , cmd, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const opt = (name) => flags.has(name);
const optVal = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

function requireSite(s) {
  if (!s || !SITES[s]) {
    console.error(`站点必须是: ${SITE_KEYS.join(' | ')}`);
    process.exit(1);
  }
}

function usage() {
  console.log(`用法: node src/cli.mjs <命令> [站点] [选项]
站点: ${SITE_KEYS.join(' | ')}

命令:
  ui                   启动本地控制台（浏览器图形界面，推荐入口；--no-open 不弹窗）
  sites                列出各站点配置与会话/接口就绪状态
  login <site>         打开浏览器人工登录一次（扫码/短信），保存会话
  capture <site>       抓包向导：登录后打开「我的投递」页，自动识别状态接口
  status <site|--all>  查询当前投递状态（--headed 显示浏览器，--raw 存原始返回）
  report [--open]      聚合各站最新数据 + 手工列表，生成总览面板 dashboard.html（有变化时 macOS 通知）
  tracker-sync        手动刷新「校招投递管理」状态包（查状态成功后已自动刷新）
  feishu-test          测试飞书群机器人推送（配置见 ~/.ats-status/feishu.json）
  import <file|-|>     导入手工投递列表（JSON 数组或 CSV：公司,岗位,状态,投递时间,链接；空=读管道）
  apps                 查看手工投递列表
  keepalive            心跳保活（--once 单轮，--interval N 分钟）
  doctor <site>        查看站点会话与接口详情
  forget <site>        清除该站点会话与已保存接口`);
}

ensureDirs();
  try {
    switch (cmd) {
      case 'ui': {
        const { startServer } = await import('./web.mjs');
        await startServer({ openBrowser: !opt('--no-open') });
        break;
      }
      case 'sites':
    case undefined: {
      for (const k of SITE_KEYS) {
        const c = SITES[k];
        const hasProfile = fs.existsSync(profileDir(k));
        const hasSpec = fs.existsSync(capturedFile(k));
        const hb = c.heartbeat;
        const hbs = `保活 ${Math.round(hb.startMin / 60)}h${hb.floorMin < hb.startMin ? `（掉线下限 ${Math.round(hb.floorMin / 60)}h）` : '（固定）'}`;
        console.log(`${pad(k, 14)} ${pad(c.label, 6)} 会话:${hasProfile ? '✓' : '—'} 接口:${hasSpec ? '✓' : (c.seeds ? '预置' : '—')} ${pad(hbs, 22)} 风险:${c.risk}`);
      }
      if (!cmd) console.log('\n(提示: 输入 node src/cli.mjs 查看完整命令)');
      break;
    }
    case 'login':
      requireSite(args[0]);
      await login(args[0]);
      break;
    case 'capture':
      requireSite(args[0]);
      await capture(args[0]);
      break;
    case 'status': {
      const o = { headed: opt('--headed'), raw: opt('--raw') };
      if (opt('--all')) {
        for (const k of SITE_KEYS) {
          if (fs.existsSync(path.join(HOME, 'resident', `${k}.json`))) { console.log(`${k}: 常驻浏览器运行中，请在控制台里查询（避免浏览器 profile 冲突）`); continue; }
          if (!fs.existsSync(profileDir(k))) { console.log(`${k}: 未登录（先 login）`); continue; }
          await status(k, o);
        }
      } else {
        requireSite(args[0]);
        await status(args[0], o);
      }
      break;
    }
    case 'report':
      await report({ open: opt('--open') });
      break;
    case 'tracker-sync':
      writeTrackerSync();
      break;
    case 'feishu-test':
      await feishuTest();
      break;
    case 'import':
      await importApps(args[0]);
      break;
    case 'apps':
      await listApps();
      break;
    case 'keepalive':
      await keepalive({ once: opt('--once'), ignoreQuiet: opt('--ignore-quiet'), interval: parseInt(optVal('--interval'), 10) || undefined });
      break;
    case 'doctor': {
      requireSite(args[0]);
      const k = args[0];
      const c = SITES[k];
      console.log(`站点: ${k} (${c.label})  风险:${c.risk}`);
      console.log(`入口: ${c.entry}`);
      console.log(`保活: 起始 ${Math.round(c.heartbeat.startMin / 60)}h/次${c.heartbeat.floorMin < c.heartbeat.startMin ? `，掉线后间隔减半、下限 ${Math.round(c.heartbeat.floorMin / 60)}h` : '，掉线不减频（高风险站点：掉线即人工重登）'}；静默时段 08:00–23:30 之外零流量`);
      if (c.extraEntries) console.log(`其他入口: ${c.extraEntries.join(', ')}`);
      console.log(`会话 profile: ${fs.existsSync(profileDir(k)) ? '存在 ✓' : '不存在（先 login）'}`);
      const meta = readJson(metaFile(k));
      if (meta) console.log(`保活状态: 间隔 ${meta.intervalMin} 分钟，上次 ${meta.lastBeatAt ? new Date(meta.lastBeatAt).toLocaleString('zh-CN') : '从未'}`);
      const spec = readJson(capturedFile(k));
      if (spec) {
        console.log(`已保存接口: ${spec.method} ${spec.url}`);
        console.log(`  模式: ${spec.mode}${spec.verified ? '（已验证）' : ''}  抓取时间: ${spec.capturedAt}`);
        console.log(`  页面回退: ${spec.statusPageUrl}`);
      } else {
        console.log(`已保存接口: 无${c.seeds ? `（有 ${c.seeds.length} 个预置候选，status 会自动尝试）` : '（先 capture）'}`);
      }
      break;
    }
    case 'forget': {
      requireSite(args[0]);
      for (const dir of [profileDir(args[0])]) fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(capturedFile(args[0]), { force: true });
      console.log(`已清除 ${args[0]} 的会话与接口。`);
      break;
    }
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error('出错:', e?.message || e);
  process.exit(1);
}
