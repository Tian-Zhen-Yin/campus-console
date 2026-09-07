import fs from 'node:fs';
import { appsFile } from './paths.mjs';
import { readJson, writeJson, nowIso, pad } from './util.mjs';
import { normalizeStatus } from './extract.mjs';

// 手工投递列表：六家自动抓取之外的公司在这里登记。
// 文件即数据库（~/.ats-status/apps.json），想改直接编辑文件。

export function readApps() {
  const list = readJson(appsFile());
  return Array.isArray(list) ? list : [];
}

const KEYMAP = {
  company: ['company', '公司'],
  job: ['job', 'position', '岗位', '职位'],
  statusRaw: ['statusRaw', 'status', '状态', '当前状态'],
  appliedAt: ['appliedAt', '投递时间', '时间', 'date'],
  link: ['link', 'url', '链接', '入口'],
};
const pick = (obj, names) => { for (const n of names) { if (obj[n] != null && obj[n] !== '') return obj[n]; } return ''; };

function fromObject(o) {
  return {
    company: String(pick(o, KEYMAP.company) || ''),
    job: String(pick(o, KEYMAP.job) || ''),
    statusRaw: String(pick(o, KEYMAP.statusRaw) || '已投递'),
    appliedAt: String(pick(o, KEYMAP.appliedAt) || ''),
    link: String(pick(o, KEYMAP.link) || ''),
  };
}

function splitCsvLine(line) {
  return line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((s) => s.trim().replace(/^"|"$/g, ''));
}

export function parseList(text) {
  const t = text.trim();
  if (t.startsWith('[')) {
    const arr = JSON.parse(t);
    return arr.map((o) => fromObject(o)).filter((e) => e.job);
  }
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  let rows = lines.map(splitCsvLine);
  const header = rows[0].join(',');
  if (/公司|company/i.test(header) && /岗位|职位|job|position/i.test(header)) {
    const cols = rows.shift();
    const idx = (names) => cols.findIndex((c) => names.some((n) => c.toLowerCase() === n.toLowerCase()));
    const ci = { company: idx(KEYMAP.company), job: idx(KEYMAP.job), statusRaw: idx(KEYMAP.statusRaw), appliedAt: idx(KEYMAP.appliedAt), link: idx(KEYMAP.link) };
    return rows.map((r) => ({
      company: ci.company >= 0 ? r[ci.company] || '' : '',
      job: ci.job >= 0 ? r[ci.job] || '' : '',
      statusRaw: (ci.statusRaw >= 0 ? r[ci.statusRaw] : '') || '已投递',
      appliedAt: ci.appliedAt >= 0 ? r[ci.appliedAt] || '' : '',
      link: ci.link >= 0 ? r[ci.link] || '' : '',
    })).filter((e) => e.job);
  }
  // 无表头：按 公司,岗位,状态,投递时间,链接 顺序
  return rows.map((r) => ({
    company: r[0] || '', job: r[1] || '', statusRaw: r[2] || '已投递',
    appliedAt: r[3] || '', link: r[4] || '',
  })).filter((e) => e.job);
}

export function importFromText(text) {
  const incoming = parseList(text).map((e) => ({ ...e, status: normalizeStatus(e.statusRaw), addedAt: nowIso() }));
  if (!incoming.length) return { added: 0, total: readApps().length, empty: true };
  const existing = readApps();
  const seen = new Set(existing.map((e) => `${e.company}|${e.job}`));
  let added = 0;
  for (const e of incoming) {
    const k = `${e.company}|${e.job}`;
    if (seen.has(k)) continue;
    seen.add(k);
    existing.push(e);
    added++;
  }
  writeJson(appsFile(), existing);
  return { added, total: existing.length };
}

export async function importApps(source) {
  let text;
  if (!source || source === '-') {
    text = fs.readFileSync(0, 'utf8');
  } else {
    text = fs.readFileSync(source, 'utf8');
  }
  const { added, total, empty } = importFromText(text);
  if (empty) { console.log('没有解析到任何记录（需要 JSON 数组，或 CSV：公司,岗位,状态,投递时间,链接）。'); return; }
  console.log(`导入完成：新增 ${added} 条，去重后共 ${total} 条 → ${appsFile()}`);
  console.log('查看: node src/cli.mjs apps；修改: 直接编辑该文件；总览: node src/cli.mjs report');
}

export async function listApps() {
  const list = readApps();
  if (!list.length) {
    console.log(`手工列表为空。导入: node src/cli.mjs import <文件>（或 cat 列表.csv | node src/cli.mjs import）\n文件: ${appsFile()}`);
    return;
  }
  console.log(`手工投递列表（${list.length} 条）:`);
  for (const e of list) {
    console.log(`  ${pad(e.company, 10)} ${pad(e.job, 36)} ${pad(e.statusRaw, 18)} ${e.appliedAt || ''}`);
  }
}
