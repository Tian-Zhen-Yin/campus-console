// 一次性补丁：站点接入支持 新增/修改/删除（控制台 UI 部分）
// 运行：node patch-sites.mjs（成功后自删）
import fs from "node:fs";
const f = "src/web-ui.html";
let s = fs.readFileSync(f, "utf8");
let step = 0;
const must = (cond, msg) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } step++; console.log("ok" + step + " " + msg); };

// 1) 卡片：查状态按钮后插入 编辑/删除
const a1 = "        <button class=\"act\" ${locked ? 'disabled' : ''} onclick=\"act('/api/status',{site:'${s.key}'})\">查状态</button>";
must(s.includes(a1), "锚点1：查状态按钮");
const b1 = a1 + "\n        <button class=\"act\" style=\"margin-left:auto\" onclick=\"openSiteForm('${s.key}')\" title=\"编辑名称/入口/保活等\">编辑</button>" +
  "\n        ${s.builtin ? \"\" : `<button class=\"act warn\" onclick=\"deleteSite('${s.key}','${esc(s.label)}')\" title=\"删除该自定义站点（含会话与数据）\">删除</button>`}";
s = s.replace(a1, b1);
must(true, "卡片编辑/删除按钮");

// 2) 站点网格尾部：添加站点卡片
const a2 = "      ${rows}\n      <div class=\"row\">";
must(s.includes(a2), "锚点2：卡片 rows 行");
s = s.replace(a2, "      ${rows}\n      <div class=\"row\">");
const a3 = "    </div>`;\n  }).join('');\n}";
let count3 = s.split(a3).length - 1;
must(count3 === 1, "锚点3：renderSites 结尾（唯一性 " + count3 + "）");
s = s.replace(a3, "    </div>`;\n  }).join('') + `\n    <div class=\"card site\" style=\"display:flex;align-items:center;justify-content:center;min-height:120px;border-style:dashed;cursor:pointer;color:#64748b\" onclick=\"openSiteForm('')\">\n      <div style=\"text-align:center\"><div style=\"font-size:26px;line-height:1\">＋</div><div style=\"margin-top:6px\">添加站点</div></div>\n    </div>`;\n}");
must(true, "添加站点卡片");

// 3) 表单弹层 HTML（挂在 toast 后）
const a4 = "<div class=\"toast\" id=\"toast\"></div>";
must(s.includes(a4), "锚点4：toast 元素");
const form = a4 + "\n\n<div id=\"siteOverlay\" style=\"display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:60;align-items:center;justify-content:center\">\n" +
"  <div style=\"background:#fff;border-radius:12px;padding:18px 20px;width:460px;max-width:92vw;max-height:88vh;overflow:auto\">\n" +
"    <strong id=\"sfTitle\">添加站点</strong>\n" +
"    <input type=\"hidden\" id=\"sfKey\" value=\"\"><input type=\"hidden\" id=\"sfBuiltin\" value=\"0\">\n" +
"    <label class=\"f\">站点名称 *</label>\n    <input type=\"text\" id=\"sfLabel\" placeholder=\"例如：B站\">\n" +
"    <label class=\"f\">入口 URL *</label>\n    <input type=\"text\" id=\"sfEntry\" placeholder=\"https://careers.xxx.com/\">\n" +
"    <label class=\"f\">风险等级</label>\n    <select id=\"sfRisk\">\n      <option value=\"low\">低风险</option>\n      <option value=\"mid\" selected>中风险</option>\n      <option value=\"high\">高风险</option>\n    </select>\n" +
"    <label class=\"f\">保活间隔（小时，起始；会话短的站点可调小）</label>\n    <input type=\"text\" id=\"sfStart\" value=\"12\">\n" +
"    <label class=\"f\">登录/操作提示（可选）</label>\n    <input type=\"text\" id=\"sfNote\" placeholder=\"登录后打开「我的投递」页…\">\n" +
"    <div class=\"row\" style=\"margin-top:12px\">\n      <button class=\"act pri\" onclick=\"saveSiteForm()\">保存</button>\n" +
"      <button class=\"act\" onclick=\"closeSiteForm()\">取消</button>\n" +
"      <button class=\"act warn\" id=\"sfDelete\" style=\"display:none;margin-left:auto\" onclick=\"deleteSiteFromForm()\">删除此站点</button>\n" +
"    </div>\n  </div>\n</div>";
s = s.replace(a4, form);
must(true, "表单弹层");

// 4) JS 函数
const a5 = "async function confirmLogin(id)";
must(s.includes(a5), "锚点5：confirmLogin 位置");
const fns = "function openSiteForm(key) {\n" +
"  api('/api/state', undefined).then((st) => {\n" +
"    const s = key ? (st.sites || []).find((x) => x.site === key) : null;\n" +
"    document.getElementById('sfKey').value = key || '';\n" +
"    document.getElementById('sfBuiltin').value = s && s.builtin ? '1' : '0';\n" +
"    document.getElementById('sfTitle').textContent = s ? (s.builtin ? '编辑内置站点：' + s.label : '编辑站点：' + s.label) : '添加站点';\n" +
"    document.getElementById('sfLabel').value = s ? s.label : '';\n" +
"    document.getElementById('sfEntry').value = s && s.entry ? s.entry : '';\n" +
"    document.getElementById('sfRisk').value = s ? s.riskLevel : 'mid';\n" +
"    document.getElementById('sfStart').value = s && s.heartbeat ? String(Math.round(s.heartbeat.startMin / 60)) : '12';\n" +
"    document.getElementById('sfNote').value = s && s.loginNote ? s.loginNote : '';\n" +
"    document.getElementById('sfDelete').style.display = s && !s.builtin ? '' : 'none';\n" +
"    document.getElementById('siteOverlay').style.display = 'flex';\n" +
"  });\n" +
"}\n" +
"function closeSiteForm() { document.getElementById('siteOverlay').style.display = 'none'; }\n" +
"async function saveSiteForm() {\n" +
"  try {\n" +
"    await api('/api/sites/save', { key: document.getElementById('sfKey').value, builtin: document.getElementById('sfBuiltin').value === '1', label: document.getElementById('sfLabel').value.trim(), entry: document.getElementById('sfEntry').value.trim(), risk: document.getElementById('sfRisk').value, startHours: Number(document.getElementById('sfStart').value) || 12, loginNote: document.getElementById('sfNote').value.trim() });\n" +
"    closeSiteForm(); toast('已保存');\n" +
"  } catch (e) { toast(e.message); }\n" +
"  await refresh();\n" +
"}\n" +
"async function deleteSite(key, label) {\n" +
"  if (!confirm('确认删除站点「' + label + '」？其会话与数据将一并清除。')) return;\n" +
"  try { await api('/api/sites/delete', { key }); toast('已删除'); } catch (e) { toast(e.message); }\n" +
"  await refresh();\n" +
"}\n" +
"async function deleteSiteFromForm() {\n" +
"  const key = document.getElementById('sfKey').value;\n" +
"  const label = document.getElementById('sfLabel').value;\n" +
"  if (!confirm('确认删除站点「' + label + '」？')) return;\n" +
"  try { await api('/api/sites/delete', { key }); closeSiteForm(); toast('已删除'); } catch (e) { toast(e.message); }\n" +
"  await refresh();\n" +
"}\n" +
a5;
s = s.replace(a5, fns);
must(true, "JS 函数");

fs.writeFileSync(f, s);
console.log("=== 补丁完成 ===");
