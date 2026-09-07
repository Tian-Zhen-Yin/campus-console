// 人工修正覆盖层：官网抓取的状态偶有识别错误，允许用户在控制台手动改。
// 修正存独立文件（不写回抓取结果），下次自动抓取不会冲掉；删除修正即恢复官网原状。
import fs from 'node:fs';
import { correctionsFile } from './paths.mjs';

const STATUS_LABELS = {
  APPLIED: '已投递', VIEWED: '已查看', SCREENING: '筛选中', TEST: '笔试',
  INTERVIEW1: '面试中', INTERVIEW2: '复试', HRFACE: 'HR面', OFFER: 'Offer',
  CLOSED: '已结束', REJECTED: '不合适', TALENT: '人才池', UNKNOWN: '未知',
};

export const STATUS_CHOICES = Object.entries(STATUS_LABELS).map(([code, label]) => ({ code, label }));

export function readCorrections() {
  try { return JSON.parse(fs.readFileSync(correctionsFile(), 'utf8')).corrections || {}; }
  catch { return {}; }
}

export function isValidStatus(code) {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, code);
}

// 设置/删除一条修正；key = site|job（与状态包的匹配键一致）
export function setCorrection(site, job, status) {
  const all = readCorrections();
  const key = `${site}|${job}`;
  if (status === null) {
    delete all[key];
  } else {
    if (!isValidStatus(status)) throw new Error(`未知状态码 ${status}`);
    all[key] = { status, statusRaw: STATUS_LABELS[status], at: new Date().toISOString() };
  }
  fs.mkdirSync(correctionsFile().replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  fs.writeFileSync(correctionsFile(), JSON.stringify({ corrections: all }, null, 2));
  return all[key] || null;
}

// 对单站抓取记录应用修正（返回新数组，不改原对象）
export function applyToRecords(site, records) {
  const all = readCorrections();
  if (!records || !Array.isArray(records)) return records;
  return records.map((r) => {
    const fix = all[`${site}|${r.job}`];
    return fix ? { ...r, status: fix.status, statusRaw: fix.statusRaw, corrected: true } : r;
  });
}
