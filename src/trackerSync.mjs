// 把 out/<site>.json 汇总为「校招投递管理」可读的官方状态包 out/tracker-sync.json
// 任何一次 status 查询成功后自动调用（见 status.mjs）；也可 node src/cli.mjs tracker-sync 手动执行
// 全量快照、幂等：管理器端重复导入同一包不会产生重复记录；先写临时文件再原子改名
import fs from 'node:fs';
import path from 'node:path';
import { SITES } from './config.mjs';
import { HOME, outFile } from './paths.mjs';
import { readJson } from './util.mjs';
import { readMailLog } from './mail.mjs';
import { applyToRecords } from './corrections.mjs';

// 匹配辅助：管理器台账里可能用简称（如「字节」「阿里」），别名表负责对上
const COMPANY_ALIASES = {
  bytedance: ['字节跳动', '字节', 'ByteDance'],
  alibaba: ['阿里巴巴', '阿里', 'Alibaba'],
  meituan: ['美团', '美团点评'],
  kuaishou: ['快手', '快手科技'],
  ctrip: ['携程', 'Trip.com'],
  xiaohongshu: ['小红书', 'RedNote', 'RED']
};
// 归一化状态码里已带语义的（tracker 端有原文兜底识别，这里只列已知集合）
const KNOWN_STATUS = ['CLOSED', 'REJECTED', 'TALENT', 'OFFER', 'SCREENING', 'TEST', 'INTERVIEW1', 'INTERVIEW2', 'HRFACE'];

export function trackerSyncPath() {
  return path.join(HOME, 'out', 'tracker-sync.json');
}

export function buildTrackerSyncPayload() {
  const updates = [];
  for (const site of Object.keys(SITES)) {
    const data = readJson(outFile(site));
    if (!data || !Array.isArray(data.records)) continue;
    for (const record of applyToRecords(site, data.records)) {
      if (!record?.job) continue;
      let status = String(record.status || '').toUpperCase();
      const statusRaw = String(record.statusRaw ?? record.status ?? '');
      // 快手等站点可能出现只有时间戳没有状态的记录：状态归为 UNKNOWN，原文照留
      if (!KNOWN_STATUS.includes(status)) {
        status = /^20\d{2}[-/.年]/.test(statusRaw) ? 'UNKNOWN' : (status || 'UNKNOWN');
      }
      updates.push({
        site,
        company: SITES[site].label,
        companyAliases: COMPANY_ALIASES[site] || [],
        job: String(record.job),
        dept: String(record.dept || ''),
        city: Array.isArray(record.city) ? record.city.join('、') : String(record.city || ''),
        statusRaw,
        status,
        appliedAt: String(record.appliedAt || ''),
        fetchedAt: data.at || new Date().toISOString()
      });
    }
  }
  return {
    schemaVersion: 1,
    kind: 'autumn-tracker-status-sync',
    generatedAt: new Date().toISOString(),
    updates,
    mailTips: buildMailTips()
  };
}

// 邮件邀约的建议键：内容哈希（mail.jsonl 里没有稳定 uid 可用）
const tipKey = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `mail|${(h >>> 0).toString(16)}`;
};

// 邮件里提取到的笔试/面试安排（未来一周左右 actionable），随状态包一起发给台账
export function buildMailTips(now = new Date()) {
  const tips = [];
  const seenTip = new Set();
  for (const m of readMailLog(200)) {
    if (!m || !m.tip || !m.tip.iso) continue;
    const key = tipKey(`${m.company}|${m.subject}|${m.at}`);
    if (seenTip.has(key)) continue;
    seenTip.add(key);
    if (new Date(m.tip.iso).getTime() < now.getTime() - 12 * 3600000) continue; // 已过期的邀约不再建议
    tips.push({
      key, company: m.company, subject: m.subject,
      kind: m.tip.kind, round: m.tip.round, iso: m.tip.iso, place: m.tip.place || '', at: m.at
    });
    if (tips.length >= 20) break;
  }
  return tips;
}

export function writeTrackerSync({ quiet = false } = {}) {
  const payload = buildTrackerSyncPayload();
  const target = trackerSyncPath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
  fs.renameSync(tmp, target);
  if (!quiet) console.log(`状态包已更新 → ${target}（${payload.updates.length} 条）`);
  return payload;
}
