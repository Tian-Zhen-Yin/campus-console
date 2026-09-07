import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { HOME } from './paths.mjs';
import { SITES } from './config.mjs';

// 飞书群自定义机器人推送（可选）。配置 ~/.ats-status/feishu.json：
//   { "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx", "secret": "签名密钥，没开就删掉这行" }
// 没有该文件 = 未接入，工具行为不变（纯本地）。

export const feishuConfigFile = () => path.join(HOME, 'feishu.json');

export function readFeishuConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(feishuConfigFile(), 'utf8'));
    return c && c.webhook ? c : null;
  } catch { return null; }
}

// 飞书自定义机器人签名：HMAC-SHA256(key = timestamp\nsecret)，空正文，base64
function sign(secret, timestamp) {
  return crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
}

async function postCard(card) {
  const cfg = readFeishuConfig();
  if (!cfg) return { skipped: true };
  const body = { msg_type: 'interactive', card };
  if (cfg.secret) {
    const ts = Math.floor(Date.now() / 1000);
    body.timestamp = String(ts);
    body.sign = sign(cfg.secret, ts);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(cfg.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const ok = res.ok && /"code"\s*:\s*0/.test(text);
    return { ok, detail: ok ? '' : text.slice(0, 200) };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const note = (text) => ({ tag: 'note', elements: [{ tag: 'plain_text', content: text }] });

export async function feishuTest() {
  if (!readFeishuConfig()) {
    console.log(`未接入飞书。三步开通：
1. 建个飞书群 → 设置 → 群机器人 → 添加「自定义机器人」，复制 webhook（建议开启签名校验）
2. 写入 ${feishuConfigFile()}：
   { "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx", "secret": "签名密钥（没开就不写这行）" }
3. 再跑一次: node src/cli.mjs feishu-test`);
    return { ok: false, unconfigured: true };
  }
  const card = {
    header: { template: 'green', title: { tag: 'plain_text', content: '✅ ats-status 接入成功' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '之后投递状态有变化，会推到这里。' } },
      note(`测试于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`),
    ],
  };
  const r = await postCard(card);
  console.log(r.ok ? '测试卡片已发送，去飞书群里看看。' : `发送失败: ${r.detail}`);
  return r;
}

// 把变化清单推成一张卡片。changes: [{ where, key, from, to }]
export async function pushChanges(changes) {
  if (!changes.length || !readFeishuConfig()) return;
  const lines = changes.slice(0, 10).map((c) =>
    `**${c.where}** ${c.key}：${c.from || '（新增）'} → **${c.to}**`);
  if (changes.length > 10) lines.push(`…等共 ${changes.length} 处变化`);

  const involved = [...new Set(changes.map((c) => c.where))]
    .map((w) => Object.values(SITES).find((s) => s.label === w))
    .filter(Boolean)
    .slice(0, 3);
  const elements = [
    { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
    { tag: 'hr' },
  ];
  if (involved.length) {
    elements.push({
      tag: 'action',
      actions: involved.map((s) => ({
        tag: 'button', text: { tag: 'plain_text', content: `打开${s.label}` }, url: s.entry, type: 'default',
      })),
    });
  }
  elements.push(note(`${new Date().toLocaleString('zh-CN', { hour12: false })} · ats-status · 面板: ~/.ats-status/out/dashboard.html`));

  const r = await postCard({
    header: { template: 'orange', title: { tag: 'plain_text', content: `🍂 校招投递有更新（${changes.length} 处）` } },
    elements,
  });
  if (!r.ok) console.error(`飞书推送失败: ${r.detail}`);
  return r;
}

// 招聘相关邮件的通知卡片
export async function pushMailNote(mails) {
  if (!mails || !mails.length || !readFeishuConfig()) return { skipped: true };
  const lines = mails.slice(0, 8).map((m) => `**${m.company}** ${m.subject}`);
  if (mails.length > 8) lines.push(`…等共 ${mails.length} 封`);
  const card = {
    header: { template: 'blue', title: { tag: 'plain_text', content: `📬 收到招聘相关邮件（${mails.length} 封）` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      note(`${new Date().toLocaleString('zh-CN', { hour12: false })} · ats-status 邮箱监控`),
    ],
  };
  const r = await postCard(card);
  if (!r.ok) console.error(`飞书邮件推送失败: ${r.detail}`);
  return r;
}
