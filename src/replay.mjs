import { launch } from './session.mjs';

// 用已保存的浏览器会话直连接口重放（API 模式）
export async function replayApi(ctx, spec) {
  const headers = { ...(spec.headers || {}) };
  try {
    let resp;
    const data = spec.body != null && spec.body !== '' ? maybeJson(spec.body) : undefined;
    if (String(spec.method).toUpperCase() === 'POST') {
      resp = await ctx.request.post(spec.url, { headers, data, timeout: 25000 });
    } else {
      resp = await ctx.request.get(spec.url, { headers, timeout: 25000 });
    }
    const text = await resp.text();
    return { ok: resp.ok(), status: resp.status(), text };
  } catch (e) {
    return { ok: false, status: -1, text: '', error: String(e?.message || e) };
  }
}

function maybeJson(s) {
  if (typeof s !== 'string') return s;
  const t = s.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.parse(t); } catch { return s; }
  }
  return s;
}

// 判定响应/正文是否为「会话失效」类失败
export function looksAuthFail(r) {
  if ([401, 403].includes(r.status)) return true;
  const t = r.text || '';
  if (!t) return false;
  return /请登录|未登录|请先登录|登录已过期|登录失效|not\s*login|unauthor|forbidden|"code"\s*:\s*(401|403)\b/i.test(t);
}

// 业务包络失败（HTTP 200 但 success:false / code!=0）
export function envelopeFail(text) {
  if (!text) return false;
  return /"success"\s*:\s*false/.test(text) || /"code"\s*:\s*(?!0\b|200\b)\d+/.test(text);
}
