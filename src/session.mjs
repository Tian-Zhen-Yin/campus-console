import fs from 'node:fs';
import { chromium } from 'playwright';
import { profileDir } from './paths.mjs';

// 用持久化 profile（cookie + localStorage + 指纹材料）启动浏览器，
// 登录态跨进程复用。优先真实 Chrome 通道（指纹更像真人），失败回退内置 chromium。
export async function launch(site, { headless = true } = {}) {
  const dir = profileDir(site);
  fs.mkdirSync(dir, { recursive: true });
  const base = {
    headless,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: ['--disable-blink-features=AutomationControlled'],
  };
  // 渠道优先级：Chrome → Edge（Windows 系统自带）→ 内置 chromium
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launchPersistentContext(dir, { ...base, channel });
    } catch (e) {
      console.warn(`${channel} 通道启动失败，尝试下一渠道:`, e.message);
    }
  }
  try {
    return await chromium.launchPersistentContext(dir, base);
  } catch (e) {
    throw new Error(`浏览器启动失败（${e.message}）。若内置 chromium 未安装，请运行: npx playwright install chromium`);
  }
}
