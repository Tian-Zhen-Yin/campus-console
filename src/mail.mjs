import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { HOME } from './paths.mjs';

// 邮箱监控：通过 IMAP 拉取招聘相关邮件（官方授权访问，无任何风控风险）。
// 配置 ~/.ats-status/mail.json（控制台「邮箱监控」卡片可保存）：
//   { "provider": "qq|163|gmail", "host": "...", "port": 993, "secure": true,
//     "user": "邮箱", "pass": "授权码（不是登录密码）" }
// 拉取近 N 天邮件 → 识别招聘相关（发件人域名 + 主题关键词）→ 去重后存档 out/mail.jsonl

export const mailConfigFile = () => path.join(HOME, 'mail.json');
export const mailSeenFile = () => path.join(HOME, 'mail-seen.json');
export const mailLogFile = () => path.join(HOME, 'out', 'mail.jsonl');

const PROVIDERS = {
  qq: { host: 'imap.qq.com', port: 993, secure: true, note: 'QQ邮箱：设置→账户→开启IMAP/SMTP服务→生成授权码' },
  163: { host: 'imap.163.com', port: 993, secure: true, note: '163邮箱：设置→POP3/SMTP/IMAP→开启IMAP→获取授权码' },
  gmail: { host: 'imap.gmail.com', port: 993, secure: true, note: 'Gmail：开启两步验证后生成应用专用密码' },
};

// ===== 多邮箱账号 =====
// 新格式 { accounts: [...] }；旧的单账号 mail.json 读取时自动当作一个账号（首次保存即迁移为新格式）
function normalizeAccount(a) {
  const p = PROVIDERS[a.provider] || {};
  return a.user && a.pass ? { ...p, ...a } : null;
}

export function readMailConfigs() {
  try {
    const c = JSON.parse(fs.readFileSync(mailConfigFile(), 'utf8'));
    const list = Array.isArray(c.accounts) ? c.accounts : [c];
    return list.map(normalizeAccount).filter(Boolean);
  } catch { return []; }
}

export function saveMailConfigs(accounts) {
  const stable = accounts.map(({ user, pass, provider, host, port, secure }) => ({ user, pass, provider, host, port, secure }));
  fs.writeFileSync(mailConfigFile(), JSON.stringify({ accounts: stable }, null, 2));
}

// 兼容旧调用（report.mjs 等）：返回第一个账号
export function readMailConfig() {
  return readMailConfigs()[0] || null;
}

export const PROVIDER_NOTES = PROVIDERS;

// 招聘方发件域名/名称 → 公司标签
const RECRUITER = [
  [/mokahr\.com|莫卡|Moka/i, 'Moka 系（携程/知乎等）'],
  [/beisen\.com|italent|北森/i, '北森系（贝壳/得物等）'],
  [/alibaba\.com|alibaba-inc|taobao/i, '阿里巴巴'],
  [/bytedance/i, '字节跳动'],
  [/meituan\.com|sankuai|dianping/i, '美团'],
  [/xiaohongshu|xhscdn/i, '小红书'],
  [/kuaishou/i, '快手'],
  [/nowcoder/i, '牛客（笔试平台）'],
  [/tencent\.com|w.hr\./i, '腾讯'],
  [/bilibili/i, 'B站'],
  [/jd\.com|jdhr/i, '京东'],
  [/pinduoduo/i, '拼多多'],
  [/netease\.com|leihuoran|163\.com.*(招聘|校招)/i, '网易'],
  [/didiglobal|didichuxing/i, '滴滴'],
  [/shopee|sea\.com/i, 'Shopee'],
  [/bigo/i, 'BIGO'],
  [/shein/i, 'SHEIN'],
  [/oppo/i, 'OPPO'],
  [/vivo/i, 'vivo'],
  [/honor\.(com|cn)/i, '荣耀'],
  [/xiaomi|mi\.com/i, '小米'],
  [/nvidia|nvdia/i, 'NVIDIA'],
  [/microsoft/i, '微软'],
  [/amazon/i, '亚马逊'],
];

// 主题关键词 → 事件类型（与投递状态共用徽章体系）
const KIND = [
  [/offer|录用|入职意向/i, 'OFFER'],
  [/面试|面谈|interview/i, 'INTERVIEW'],
  [/笔试|测评|在线考试|written|exam/i, 'EXAM'],
  [/感谢信|不合适|未能通过|很遗憾|未通过|无法进入/i, 'REJECTED'],
  [/人才池|人才库/i, 'TALENT'],
  [/筛选|评估|简历已通过/i, 'SCREENING'],
  [/投递成功|已收到您的简历|申请已提交|投递已收到|已成功投递/i, 'APPLIED'],
];

// 系统噪声（邮箱自身的安全提醒/会员营销等），永不入选
const NOISE = /登录|安全提醒|新设备|验证码|会员|升级|广告|账单|物流|快递|续费|冻结|举报|反馈|满意度|订阅.*邮件/i;

// 返回 { company, kind } 或 null（与招聘无关）
export function classifyMail({ fromAddr, fromName, subject }) {
  const hay = `${fromAddr} ${fromName} ${subject}`;
  if (NOISE.test(hay)) return null;
  let company = null;
  for (const [re, label] of RECRUITER) {
    if (re.test(hay)) { company = label; break; }
  }
  let kind = null;
  for (const [re, k] of KIND) {
    if (re.test(subject)) { kind = k; break; }
  }
  // 必须有事件关键词才入选（纯资讯/系统邮件忽略）；公司名允许由主题补充
  if (!kind) return null;
  if (!company) company = companyFromSubject(subject) || '未知来源';
  return { company, kind };
}

function companyFromSubject(subject) {
  for (const [re, label] of RECRUITER) if (re.test(subject)) return label;
  return null;
}

function readSeen() {
  try { return JSON.parse(fs.readFileSync(mailSeenFile(), 'utf8')); } catch { return {}; }
}
function writeSeen(seen) {
  const keys = Object.keys(seen);
  if (keys.length > 3000) {
    const keep = {};
    for (const k of keys.slice(-1500)) keep[k] = seen[k];
    fs.writeFileSync(mailSeenFile(), JSON.stringify(keep));
    return;
  }
  fs.writeFileSync(mailSeenFile(), JSON.stringify(seen));
}

export function readMailLog(limit = 30) {
  try {
    const lines = fs.readFileSync(mailLogFile(), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export async function testMailConnection(account) {
  const cfg = account || readMailConfigs()[0];
  if (!cfg) return { ok: false, unconfigured: true };
  const client = new ImapFlow({ ...imapOpts(cfg), logger: false });
  try {
    await client.connect();
    const mb = await client.mailboxOpen('INBOX');
    await client.logout();
    return { ok: true, count: mb.exists };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).replace(/auth|password/gi, '凭证') };
  }
}

const imapOpts = (cfg) => ({
  host: cfg.host || PROVIDERS[cfg.provider]?.host || 'imap.163.com',
  port: cfg.port || 993,
  secure: cfg.secure !== false,
  auth: { user: cfg.user, pass: cfg.pass },
  logger: false,
});

// bodyParts {key:'text'} 返回的是未解码的原始 MIME 文本（含 boundary/头/QP·Base64 编码体），
// 中文正文在 QP 下完全不可读——这里按结构挑出 text/plain（退而求 text/html）并按编码还原成明文
export function decodeMimeText(raw) {
  const text = String(raw || '');
  const charsetDecode = (bytes, charset) => {
    const cs = /gb(2312|k|18030)/i.test(charset || '') ? 'gbk' : 'utf-8';
    try { return new TextDecoder(cs, { fatal: false }).decode(bytes); } catch (_) { return bytes.toString('utf8'); }
  };
  const decodeBody = (body, cte, charset) => {
    if (/base64/i.test(cte)) return charsetDecode(Buffer.from(body.replace(/\s+/g, ''), 'base64'), charset);
    if (/quoted-printable/i.test(cte)) {
      const clean = body.replace(/=\r?\n/g, '');
      const bytes = [];
      for (let i = 0; i < clean.length; i += 1) {
        if (clean[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(clean.slice(i + 1, i + 3))) {
          bytes.push(parseInt(clean.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(clean.charCodeAt(i) & 0xff);
      }
      return charsetDecode(Buffer.from(bytes), charset);
    }
    return body; // 7bit/8bit：已是明文
  };
  const boundary = text.match(/boundary="?([^"\r\n;]+)"?/i);
  if (boundary) {
    const parts = text.split(`--${boundary[1]}`);
    let html = null;
    for (const part of parts) {
      const headEnd = part.indexOf('\r\n\r\n') >= 0 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
      if (headEnd < 0) continue;
      const head = part.slice(0, headEnd);
      const body = part.slice(headEnd).replace(/^\r?\n/, '');
      const type = (head.match(/Content-Type:\s*([^;\r\n]+)/i) || [])[1] || '';
      const cte = (head.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i) || [])[1] || '';
      const charset = (head.match(/charset="?([^";\r\n]+)/i) || [])[1] || 'utf-8';
      if (/text\/plain/i.test(type)) return decodeBody(body, cte, charset);
      if (/text\/html/i.test(type)) html = decodeBody(body, cte, charset);
    }
    if (html) return html;
  }
  // 单部件邮件：整封按头里声明的编码解
  const cte = (text.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i) || [])[1] || '';
  const charset = (text.match(/charset="?([^";\r\n]+)/i) || [])[1] || 'utf-8';
  const bodyStart = text.search(/\r\n\r\n|\n\n/);
  return bodyStart >= 0 ? decodeBody(text.slice(bodyStart).replace(/^\r?\n/, ''), cte, charset) : text;
}

// 从邮件正文提取笔试/面试安排 → { kind, round, iso, place } | null
// 只在「日期+时间」都识别得到时才产出：写错安排时间比不写更糟，宁缺毋滥
export function extractScheduleTip(text, now = new Date()) {
  const body = String(text || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ');
  const kind = /笔试|测评|在线考试|机试|written\s*test|exam/i.test(body) ? '笔试'
    : /面试|面谈|interview|[一二三]面|终面|初面|hr\s*面/i.test(body) ? '面试' : null;
  if (!kind) return null;
  const roundMatch = body.match(/hr\s*面|三面|二面|一面|终面|初面|笔试|测评|在线考试/i);
  const round = roundMatch ? roundMatch[0] : kind;

  let date = null, dateIdx = -1, hadYear = false;
  const m1 = body.match(/(20\d{2})\s*[年./\-]\s*(\d{1,2})\s*[月./\-]\s*(\d{1,2})\s*[日号]?/);
  const m2 = body.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  const m3 = body.match(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/);
  if (m1) { date = { y: +m1[1], mo: +m1[2], d: +m1[3] }; dateIdx = m1.index; hadYear = true; }
  else if (m2) { date = { y: now.getFullYear(), mo: +m2[1], d: +m2[2] }; dateIdx = m2.index; }
  else if (m3) { date = { y: now.getFullYear(), mo: +m3[1], d: +m3[2] }; dateIdx = m3.index; }
  if (!date || date.mo < 1 || date.mo > 12 || date.d < 1 || date.d > 31) return null;

  // 时间优先取日期后 80 字内的第一个时刻（通常同一行），否则全文第一个
  const windowText = dateIdx >= 0 ? body.slice(dateIdx, dateIdx + 80) : body;
  let hh = null, mm = '00';
  let tm = windowText.match(/(\d{1,2})[:：](\d{2})/);
  if (tm) { hh = +tm[1]; mm = tm[2]; }
  else {
    tm = windowText.match(/(上午|下午|晚上|中午|早上)?\s*(\d{1,2})\s*[点时]\s*(?:(\d{1,2})\s*分|半)?/);
    if (tm) {
      hh = +tm[2];
      if ((tm[1] === '下午' || tm[1] === '晚上') && hh < 12) hh += 12;
      if (tm[3]) mm = String(tm[3]);
      else if (tm[0].includes('半')) mm = '30';
    }
  }
  if (hh === null || hh > 23 || +mm > 59) return null;
  const pad = (v) => String(v).padStart(2, '0');

  // 没写年份且日期已过去 15 天以上 → 视为明年的安排
  let dt = new Date(`${date.y}-${pad(date.mo)}-${pad(date.d)}T${pad(hh)}:${pad(+mm)}:00`);
  if (!hadYear && dt.getTime() < now.getTime() - 15 * 86400000) {
    dt = new Date(`${date.y + 1}-${pad(date.mo)}-${pad(date.d)}T${pad(hh)}:${pad(+mm)}:00`);
  }
  if (Number.isNaN(dt.getTime()) || dt.getTime() < now.getTime() - 12 * 3600000) return null;

  const placeMatch = windowText.match(/腾讯会议|飞书会议|钉钉会议|Zoom|会议室[^\s，。；,;]{0,12}/i);
  return {
    kind,
    round,
    iso: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(+mm)}`,
    place: placeMatch ? placeMatch[0] : ''
  };
}

// 拉取单个邮箱：识别招聘相关（INTERVIEW/EXAM 读正文提时间）→ 去重 → 存档
async function pollAccount(account, { days, limit }) {
  const client = new ImapFlow({ ...imapOpts(account), logger: false });
  await client.connect();
  const mails = [];
  const lock = await client.getMailboxLock('INBOX');
  let freshRows = [];
  try {
    const since = new Date(Date.now() - days * 86400000);
    for await (const msg of client.fetch({ since }, { envelope: true, internalDate: true, uid: true })) {
      const env = msg.envelope || {};
      const from = (env.from && env.from[0]) || {};
      mails.push({
        at: (msg.internalDate || env.date || new Date()).toISOString(),
        fromAddr: from.address || '',
        fromName: from.name || '',
        subject: env.subject || '',
        uid: msg.uid,
      });
      if (mails.length >= limit) break;
    }
    const seen = readSeen();
    for (const m of mails.slice().reverse()) { // 新的在前处理
      const key = `${account.user}|${m.uid}|${m.subject}`; // 账号前缀：不同邮箱的 uid 互不相干
      if (seen[key]) continue;
      seen[key] = m.at;
      const cls = classifyMail(m);
      if (!cls) continue;
      freshRows.push({ at: m.at, ...cls, subject: m.subject.slice(0, 120), from: m.fromAddr.slice(0, 80), uid: m.uid });
    }
    // 面试/笔试邀约读正文提取安排时间；其它类型只存档主题（不值得为它多花流量）
    for (const row of freshRows) {
      if (row.kind !== 'INTERVIEW' && row.kind !== 'EXAM') continue;
      try {
        for await (const msg of client.fetch({ uid: row.uid }, { uid: true, bodyParts: [{ key: 'text' }] })) {
          const part = msg.bodyParts && msg.bodyParts.get('text');
          if (!part) continue;
          const tip = extractScheduleTip(`${row.subject}\n${decodeMimeText(part.toString('utf8'))}`);
          if (tip) { row.tip = tip; break; }
        }
      } catch (_) { /* 正文读不到就只存档主题 */ }
    }
    writeSeen(seen);
  } finally {
    lock.release();
  }
  await client.logout().catch(() => {});

  fs.mkdirSync(path.dirname(mailLogFile()), { recursive: true });
  for (const { uid, ...entry } of freshRows) {
    fs.appendFileSync(mailLogFile(), JSON.stringify(entry) + '\n');
  }
  return { user: account.user, scanned: mails.length, fresh: freshRows };
}

// 拉取全部已配置邮箱（传 account 则只拉这一个）；单账号失败不影响其它
export async function pollMail(opts = {}) {
  const { days = 45, limit = 400 } = opts;
  const accounts = opts.account ? [opts.account] : readMailConfigs();
  if (!accounts.length) return { ok: false, unconfigured: true };
  const results = [];
  for (const account of accounts) {
    try {
      results.push(await pollAccount(account, { days, limit }));
    } catch (e) {
      results.push({ user: account.user, scanned: 0, fresh: [], error: String(e?.message || e).replace(/auth|password/gi, '凭证') });
    }
  }
  return {
    ok: true,
    scanned: results.reduce((sum, r) => sum + (r.scanned || 0), 0),
    fresh: results.flatMap(r => r.fresh || []),
    accounts: results,
  };
}
