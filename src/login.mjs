import { SITES } from './config.mjs';
import { launch } from './session.mjs';
import { profileDir } from './paths.mjs';
import { prompt } from './util.mjs';

// 打开登录会话：弹真浏览器，人工登录后关闭即保存（持久 profile）。
// 终端 login 与 Web 控制台共用；Web 端用 finish() 代替终端回车。
export async function openLoginSession(site, log = () => {}) {
  const cfg = SITES[site];
  if (!cfg) throw new Error(`未知站点 ${site}`);
  const ctx = await launch(site, { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(cfg.entry, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  log(`已打开 ${cfg.label}：${cfg.entry}`);
  return {
    site,
    cfg,
    ctx,
    async finish() {
      const cookies = await ctx.cookies();
      await ctx.close().catch(() => {});
      return cookies.length;
    },
  };
}

// 终端一次性登录流程
export async function login(site) {
  const s = await openLoginSession(site, (m) => console.log(m));
  console.log(`\n=== ${s.cfg.label} 登录 ===`);
  console.log(`在浏览器中完成登录。${s.cfg.loginNote}`);
  await prompt('登录完成、能看到登录后的页面后，回到终端按回车 > ');
  const n = await s.finish();
  console.log(`会话已保存（${n} 条 cookie）→ ${profileDir(site)}`);
  console.log(`下一步建议: node src/cli.mjs capture ${site}   （或直接 status ${site} 试试预置接口）`);
}
