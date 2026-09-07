import fs from 'node:fs';
import { notify } from './notify.mjs';
import { applyToRecords } from './corrections.mjs';
import { SITES, SITE_KEYS } from './config.mjs';
import { outFile, historyFile, dashboardFile, reportStateFile } from './paths.mjs';
import { readJson, writeJson, nowIso } from './util.mjs';
import { readApps } from './apps.mjs';
import { pushChanges, pushMailNote } from './feishu.mjs';
import { pollMail, readMailConfig } from './mail.mjs';

// 聚合报告：把各站点最近一次抓取（out/<site>.json）与手工列表（apps.json）
// 合成一份总览面板（out/dashboard.html），并与上次报告对比状态变化。
// 有变化时走 macOS 通知；launchd 定时里 status --all 之后接一句 report 即可。

export const STATUS_META = {
  APPLIED:   { label: '已投递',  cls: 'applied' },
  VIEWED:    { label: '已查看',  cls: 'viewed' },
  SCREENING: { label: '筛选中',  cls: 'screening' },
  EXAM:      { label: '笔试',    cls: 'exam' },
  INTERVIEW: { label: '面试中',  cls: 'interview' },
  OFFER:     { label: 'Offer',   cls: 'offer' },
  TALENT:    { label: '人才池',  cls: 'talent' },
  REJECTED:  { label: '流程结束', cls: 'rejected' },
  CLOSED:    { label: '已关闭',  cls: 'closed' },
  UNKNOWN:   { label: '未知',    cls: 'unknown' },
};
const ORDER = ['OFFER', 'INTERVIEW', 'EXAM', 'SCREENING', 'VIEWED', 'TALENT', 'APPLIED', 'REJECTED', 'CLOSED', 'UNKNOWN'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cn = (at) => { try { return new Date(at).toLocaleString('zh-CN', { hour12: false }); } catch { return String(at || ''); } };



function loadSiteData(site) {
  const cfg = SITES[site];
  const out = readJson(outFile(site));
  const hasProfile = fs.existsSync(outFile(site)); // 数据存在即接入过
const records = Array.isArray(out?.records) ? applyToRecords(site, out.records) : [];
  const timeline = [];
  const f = historyFile(site);
  if (fs.existsSync(f)) {
    const prev = new Map();
    for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      for (const r of e.records || []) {
        if (!r.job) continue;
        const before = prev.get(r.job);
        if (before == null) timeline.push({ at: e.at, site, label: cfg.label, job: r.job, type: 'added', to: r.statusRaw });
        else if (before !== r.statusRaw) timeline.push({ at: e.at, site, label: cfg.label, job: r.job, type: 'change', from: before, to: r.statusRaw });
        prev.set(r.job, r.statusRaw);
      }
    }
  }
  return { site, label: cfg.label, hasData: hasProfile && records.length >= 0 && out, at: out?.at, via: out?.via, records, timeline };
}

export async function report(opts = {}) {
  // 配置了邮箱的话，顺带拉取一轮招聘相关邮件
  let mailFresh = [];
  try {
    if (readMailConfig()) {
      const mr = await pollMail({ days: 45 });
      if (mr.ok && mr.fresh.length) {
        mailFresh = mr.fresh;
        console.log(`\n📬 新招聘相关邮件 ${mr.fresh.length} 封`);
        for (const m of mr.fresh.slice(0, 5)) console.log(`  [${m.company}] ${m.subject}`);
        notify(`📬 收到招聘相关邮件 ${mr.fresh.length} 封`, mr.fresh.map((m) => `${m.company} ${m.subject}`).join('；').slice(0, 150));
        await pushMailNote(mr.fresh).catch(() => {});
      }
    }
  } catch (e) {
    console.log('邮箱拉取失败:', e?.message || e);
  }

  const sites = SITE_KEYS.map(loadSiteData);
  const manual = readApps().map((e) => ({
    company: e.company || '（未填公司）', job: e.job, statusRaw: e.statusRaw || '已投递',
    status: e.status, appliedAt: e.appliedAt || '', link: e.link || '',
  }));

  // 全量时间线（各站 + 合并），新的在前
  const timeline = sites.flatMap((s) => s.timeline).sort((a, b) => String(b.at).localeCompare(String(a.at)));

  // 与上次报告对比 → 变化清单
  const cur = {
    sites: Object.fromEntries(sites.map((s) => [s.site, Object.fromEntries(s.records.map((r) => [r.job, r.statusRaw]))])),
    manual: Object.fromEntries(manual.map((e) => [`${e.company}|${e.job}`, e.statusRaw])),
  };
  const prevState = readJson(reportStateFile());
  const changes = [];
  for (const [siteKey, jobs] of Object.entries(cur.sites)) {
    const prevJobs = prevState?.sites?.[siteKey];
    if (!prevJobs) continue;
    for (const [job, to] of Object.entries(jobs)) {
      const from = prevJobs[job];
      if (from != null && from !== to) changes.push({ where: SITES[siteKey]?.label || siteKey, key: job, from, to });
    }
  }
  for (const [key, to] of Object.entries(cur.manual)) {
    const from = prevState?.manual?.[key];
    if (from != null && from !== to) changes.push({ where: `手工/${key.split('|')[0]}`, key: key.split('|')[1], from, to });
  }
  writeJson(reportStateFile(), { at: nowIso(), ...cur });

  const html = renderHtml({ generatedAt: nowIso(), sites, manual, timeline, changes });
  fs.mkdirSync(String(dashboardFile()).replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(dashboardFile(), html);

  // 终端摘要
  const total = sites.reduce((n, s) => n + s.records.length, 0) + manual.length;
  console.log(`\n=== 总览（${total} 条投递：自动 ${total - manual.length} + 手工 ${manual.length}）===`);
  for (const s of sites) {
    if (!s.records.length) continue;
    console.log(`  ${s.label}（${cn(s.at)}，via ${s.via || '?'}）`);
    for (const r of s.records) console.log(`    ${r.job}  →  ${r.statusRaw}`);
  }
  if (changes.length) {
    console.log('\n状态变化:');
    for (const c of changes) console.log(`  [${c.where}] ${c.key}: ${c.from} → ${c.to}`);
    notify('校招投递有更新', changes.map((c) => `${c.where} ${c.key}: ${c.to}`).join('；').slice(0, 180));
    await pushChanges(changes); // 配了 ~/.ats-status/feishu.json 才会真正发出
  }
  console.log(`\n面板已生成 → ${dashboardFile()}${opts.open ? '（已打开）' : '，用浏览器打开即可'}`);

  if (opts.open) {
    const { execFile: ef } = await import('node:child_process');
    ef('open', [dashboardFile()]);
  }
  return { total, changes };
}

function badge(status) {
  const m = STATUS_META[status] || STATUS_META.UNKNOWN;
  return `<span class="b b-${m.cls}">${m.label}</span>`;
}

function renderHtml({ generatedAt, sites, manual, timeline, changes }) {
  const all = [
    ...sites.flatMap((s) => s.records.map((r) => ({ company: s.label, ...r, src: `${s.label}（自动）`, at: s.at }))),
    ...manual.map((e) => ({ ...e, src: '手工登记', at: e.addedAt })),
  ];
  const byStatus = {};
  for (const r of all) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  const stats = ORDER.filter((k) => byStatus[k]).map((k) => `<div class="chip"><span class="b b-${STATUS_META[k].cls}">${STATUS_META[k].label}</span><strong>${byStatus[k]}</strong></div>`).join('');

  const rows = all.map((r) => `
    <tr>
      <td>${esc(r.company)}</td>
      <td class="job">${esc(r.job)}${r.dept ? `<span class="dim"> · ${esc(r.dept)}</span>` : ''}</td>
      <td>${esc(r.city || '—')}</td>
      <td>${badge(r.status)}</td>
      <td class="dim">${esc(r.statusRaw)}</td>
      <td class="dim">${r.at ? cn(r.at) : '—'}</td>
    </tr>`).join('');

  const tl = timeline.slice(0, 60).map((e) => `
    <li><span class="t">${cn(e.at)}</span> <strong>${esc(e.label)}</strong> ${esc(e.job)}
      ${e.type === 'added' ? `<span class="dim">首次记录 → ${esc(e.to)}</span>` : `<span class="dim">${esc(e.from)} →</span> ${esc(e.to)}`}
    </li>`).join('') || '<li class="dim">暂无记录</li>';

  const health = SITE_KEYS.map((k) => {
    const s = sites.find((x) => x.site === k);
    const ok = s && s.records.length;
    return `<tr><td>${esc(s.label)}</td><td>${ok ? `${s.records.length} 条` : '—'}</td><td class="dim">${s.at ? cn(s.at) : '未接入'}</td><td class="dim">${esc(s.via || '')}</td>
      <td class="dim">${ok ? '' : `node src/cli.mjs login ${k} → capture ${k}`}</td></tr>`;
  }).join('');

  const changeBox = changes.length
    ? `<div class="box warn"><strong>较上次报告有 ${changes.length} 处变化</strong><ul>${changes.map((c) => `<li>[${esc(c.where)}] ${esc(c.key)}: ${esc(c.from)} → ${esc(c.to)}</li>`).join('')}</ul></div>`
    : '<div class="box">较上次报告无变化</div>';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>校招投递总览</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; background: #f6f7f9; color: #1f2937; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
  .chip { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 8px 14px; display: flex; align-items: center; gap: 8px; }
  .chip strong { font-size: 18px; }
  .box { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 16px; font-size: 13px; margin-bottom: 18px; }
  .box.warn { border-color: #f59e0b; background: #fffbeb; }
  .box ul { margin: 6px 0 0; padding-left: 18px; }
  h2 { font-size: 15px; margin: 26px 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; font-size: 13px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #f1f2f4; vertical-align: top; }
  th { background: #f9fafb; color: #4b5563; font-weight: 600; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  .job { font-weight: 500; }
  .dim { color: #6b7280; }
  .b { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; color: #fff; white-space: nowrap; }
  .b-applied { background: #64748b; } .b-viewed { background: #0891b2; } .b-screening { background: #2563eb; }
  .b-exam { background: #7c3aed; } .b-interview { background: #d97706; } .b-offer { background: #059669; }
  .b-talent { background: #0d9488; }
  .b-rejected { background: #dc2626; } .b-closed { background: #9ca3af; } .b-unknown { background: #94a3b8; }
  ul.tl { list-style: none; padding: 0; margin: 0; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; }
  ul.tl li { padding: 9px 14px; border-bottom: 1px solid #f1f2f4; font-size: 13px; }
  ul.tl li:last-child { border-bottom: none; }
  ul.tl .t { color: #9ca3af; margin-right: 8px; font-variant-numeric: tabular-nums; }
</style></head><body><div class="wrap">
  <h1>校招投递总览</h1>
  <div class="sub">生成于 ${cn(generatedAt)} · 数据仅存本机（~/.ats-status/），刷新方法：node src/cli.mjs status --all &amp;&amp; node src/cli.mjs report</div>
  <div class="chips">${stats || '<span class="dim">暂无数据</span>'}</div>
  ${changeBox}
  <h2>状态时间线</h2>
  <ul class="tl">${tl}</ul>
  <h2>投递明细（${all.length} 条）</h2>
  <table><thead><tr><th>公司</th><th>岗位</th><th>地点</th><th>状态</th><th>原始状态</th><th>数据时间</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="dim">暂无投递记录</td></tr>'}</tbody></table>
  <h2>站点接入状态</h2>
  <table><thead><tr><th>站点</th><th>记录数</th><th>最近同步</th><th>模式</th><th>接入命令</th></tr></thead><tbody>${health}</tbody></table>
</div></body></html>`;
}
