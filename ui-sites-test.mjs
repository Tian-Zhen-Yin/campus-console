import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => d.accept());
await page.goto('http://127.0.0.1:7788/');
await page.waitForTimeout(800);
// 1. 点添加站点卡片 → 表单弹出
await page.locator('.card.site:has-text("添加站点")').click();
await page.waitForTimeout(300);
await page.fill('#sfLabel', 'B站');
await page.fill('#sfEntry', 'https://careers.bilibili.com/');
await page.selectOption('#sfRisk', 'low');
await page.screenshot({ path: '/tmp/sites-form.png' });
// 2. 保存 → 卡片应出现
await page.locator('button:has-text("保存")').click();
await page.waitForTimeout(800);
const hasCard = await page.locator('.card.site:has-text("B站")').count();
console.log('新增后卡片出现:', hasCard > 0 ? '✅' : '❌');
// 3. 编辑：改名为哔哩哔哩
await page.locator('.card.site:has-text("B站")').locator('button:has-text("编辑")').click();
await page.waitForTimeout(300);
await page.fill('#sfLabel', '哔哩哔哩');
await page.locator('#siteOverlay button:has-text("保存")').click();
await page.waitForTimeout(800);
const renamed = await page.locator('.card.site:has-text("哔哩哔哩")').count();
console.log('改名后卡片出现:', renamed > 0 ? '✅' : '❌');
// 4. 删除（自动接受 confirm 弹窗）
page.once('dialog', (d) => d.accept());
await page.locator('.card.site:has-text("哔哩哔哩")').locator('button:has-text("删除")').click();
await page.waitForTimeout(800);
const gone = await page.locator('.card.site:has-text("哔哩哔哩")').count();
console.log('删除后卡片消失:', gone === 0 ? '✅' : '❌');
console.log('pageerror:', errors.length ? errors : '无');
await browser.close();
