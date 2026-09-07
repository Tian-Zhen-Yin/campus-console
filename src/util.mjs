import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
export const appendJsonl = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(v) + '\n'); };
export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

// 中文字符按 2 列宽对齐
const wide = (s) => [...String(s)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
export function pad(s, n) { s = String(s ?? ''); return s + ' '.repeat(Math.max(0, n - wide(s))); }

export function table(rows, cols) {
  const head = cols.map((c) => pad(c.title, c.width)).join('  ');
  const line = cols.map((c) => '-'.repeat(c.width)).join('  ');
  return [head, line, ...rows.map((r) => cols.map((c) => pad(r[c.key] ?? '', c.width)).join('  '))].join('\n');
}

// 判断响应体里是否出现「投递/状态」类中文词（用于识别候选接口）
export const STATUS_WORDS = ['投递', '简历', '面试', '笔试', 'offer', 'Offer', '不匹配', '已查看', '筛选', '录用', '申请', '进度', '候选人'];

// 剥掉 JSONP 壳：mtop 等网关返回 callback({...}) 形式，取内部 JSON（校验合法才返回）
export function unwrapJsonp(body) {
  if (!body) return body;
  const t = String(body).trim();
  if (!/^[a-zA-Z_$][\w$]*\s*\(\s*[\{"[]/.test(t)) return body;
  const start = t.indexOf('(');
  const end = t.lastIndexOf(')');
  if (end <= start) return body;
  const inner = t.slice(start + 1, end);
  try { JSON.parse(inner); return inner; } catch { return body; }
}
