# ats-status

聚合查询 6 家公司招聘系统里的**个人投递状态**：字节跳动 / 阿里巴巴 / 美团 / 携程 / 小红书 / 快手。

设计原则（对自研招聘系统的现实约束）：登录无法无人值守（扫码/短信必须人工），所以**人工登录一次**，之后程序复用会话查询；状态接口各家私有，用**抓包向导**自动识别，而不是为每家逆向硬编码。

> 🖥 **推荐入口：`npm run ui`（或 `node src/cli.mjs ui`）→ 浏览器打开本地控制台 `http://127.0.0.1:7788`**。登录、抓包、查询、面板、导入、飞书配置全部在页面里点按钮完成（只绑定本机回环，数据不出电脑）。以下终端命令仍然全部可用，控制台是它们的图形外壳。
>
> 📖 **完整图文教程（含一键复制命令、接入进度清单、飞书接入、风险红线、FAQ）**：浏览器打开 [`docs/guide.html`](docs/guide.html)，控制台里点「使用指南」直达

## 工作原理

```
login    人工登录一次（弹真 Chrome，扫码/短信），会话存入持久 profile
capture  登录后打开「我的投递」页，工具记录全部 XHR，自动识别出状态接口并验证
status   无头回放：API 直连；若接口带签名/风控（如阿里 mtop），自动降级为
         打开状态页截获同一接口的响应（页面模式）。结果归一化 + 与上次对比
report   聚合各站 out/*.json + 手工列表 apps.json → 总览面板 dashboard.html；
         与上次报告对比，有变化时发 macOS 通知
keepalive 心跳保活（站点普遍是滑动过期 cookie），默认 45 分钟一轮 ±20% 抖动
```

## 快速开始

```bash
cd ats-status
npm i                # 已装可跳过
node src/cli.mjs sites          # 看就绪状态

# 每家站点一次性的两步（以快手为例）：
node src/cli.mjs login kuaishou     # 浏览器里完成登录，回终端按回车
node src/cli.mjs capture kuaishou   # 登录后打开「我的投递」页，回终端按回车识别

# 之后随时：
node src/cli.mjs status kuaishou    # 或 --all 查所有已登录站点
node src/cli.mjs status kuaishou --raw    # 失败时看探测细节（~/.ats-status/out/*.raw.json）

# 把手工维护的投递表导进来（六家之外的公司也有地方放），生成总览面板：
node src/cli.mjs import ~/Downloads/投递列表.csv
node src/cli.mjs report --open      # 生成并打开 dashboard.html，以后只看这一页
```

小红书/快手有**预置接口**（2026-09 实测），`login` 后直接 `status` 可能就能用，不必先 capture。

## 各站点情况（2026-09 实测）

| 站点 | 入口 | 登录方式 | 接口就绪度 |
|---|---|---|---|
| 快手 | zhaopin.kuaishou.cn | 手机号+短信 | **预置** `GET /recruit/e/api/v1/user/apply/position`（社招；校招需 capture） |
| 小红书 | job.xiaohongshu.com | 手机验证码/扫码 | **预置** `POST /websiterecruit/apply/getApplyHistory`（未登录实测 401“请登录”，接口存活） |
| 携程 | app.mokahr.com/campus-recruitment/trip/117988 | Moka：手机+短信 | 需 capture（Moka 标准结构，一次 capture 长期有效）。**海外社招是另一租户** hire-r1.mokahr.com/apply/tripoverseas，需单独 login+capture |
| 字节 | jobs.bytedance.com | 短信或飞书/抖音扫码 | 需 capture（API 在懒加载 chunk，运行时识别） |
| 美团 | zhaopin.meituan.com/web/home | App 扫码/短信 | 需 capture |
| 阿里 | talent.alibaba.com | 淘系统一账户（Havana） | 需 capture；API 走 mtop 签名网关，会自动用页面模式 |

> 携程同时存在 Workday 线路（部分国际业务）。若你的投递在 Workday 侧，此工具暂不覆盖。

## 频率设计与保活（核心原则：宁可掉线重登，不可高频触封）

掉线的代价是**一次人工登录**；封号的代价是**永久失去该渠道**（实名体系下难以挽回）。所有频率参数都按这个不对称性取值：

- **保活 12 小时/次起步**，±40% 随机抖动（杜绝整点节拍器这种机器人特征），站点之间随机错开。典型预算：每站点约 2 次页面访问/天 + 状态查询 ≤2 次/天 ≈ 一个频繁刷进度的真人。
- **静默时段**：08:00–23:30 之外零流量。凌晨的 API 调用与"睡觉的人类"不符，是高显著性异常。
- **掉线降频阶梯**：会话失效时，低风险站点间隔减半试探（12h→6h→3h 封底）；到了下限还掉线说明是短时/绝对过期，**正确做法是放弃保活、要查时再登录**，工具不会继续加密。
- **高风险站点禁用自动加密**：阿里（登录页实测挂 baxia 反爬 + mtop 签名网关）、小红书（bundle 实测 redcaptcha 风控）保活固定 12h，状态查询建议 ≤1 次/天；宁可频繁重登。
- **保活动作用页面访问实现**（打开状态页让站点自己的 JS 续期），流量形态与真人无异；绝不裸打带签名的接口（如 mtop）——畸形签名请求本身就是风控输入。
- 状态查询按需手动跑；若用定时器，建议 ≤2 次/天（见下）。

### 定时示例（macOS launchd）

```xml
<!-- ~/Library/LaunchAgents/com.ats-status.ka.plist —— 每 2 小时跑一轮（内部按各站点间隔自行节流） -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ats-status.ka</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-c</string>
    <string>cd /path/to/ats-status &amp;&amp; node src/cli.mjs keepalive --once</string>
  </array>
  <key>StartInterval</key><integer>7200</integer>
  <key>StandardOutPath</key><string>/tmp/ats-status.log</string>
  <key>StandardErrorPath</key><string>/tmp/ats-status.log</string>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/com.ats-status.ka.plist` 启用。状态查询想自动化的话，再复制一份 plist 改成每 12 小时执行 `node src/cli.mjs status --all; node src/cli.mjs report`（查完自动出总览面板，有变化发 macOS 通知）。

## 总览面板与手工列表

- `report` 把六家最新数据（`out/<site>.json`）和手工列表合成 `out/dashboard.html`：状态分布、
  变化提示、状态时间线、全部投递明细、各站点接入状态（未接入的直接给出 login/capture 命令）。
  数据内嵌在 HTML 里，浏览器打开即看、不依赖网络。
- 与上次 report 对比，任何一条状态变了就发 macOS 通知，并写进面板顶部的提示框。
- 手工列表存 `~/.ats-status/apps.json`，两种导入格式（`import <file>` 或管道，按 公司+岗位 去重）：

```csv
公司,岗位,状态,投递时间,链接
网易,服务端开发工程师,笔试通过,2026-08-28,
```

```json
[{"company":"腾讯","job":"后台开发","status":"已投递","appliedAt":"2026-09-03"}]
```

  状态写自然语言即可，自动归一为：已投递 / 已查看 / 筛选中 / 笔试 / 面试中 / Offer / 流程结束。
  之后想改就直接编辑 apps.json。

## 飞书推送（可选）

想在手机上收变化通知、或两个人一起盯进度：加一个飞书群机器人即可，三步开通。

1. 建个飞书群（就你们俩）→ 设置 → 群机器人 → 添加「自定义机器人」，复制 webhook 地址（建议开启签名校验）
2. 写入 `~/.ats-status/feishu.json`：

```json
{ "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx", "secret": "签名密钥（没开就删掉这行）" }
```

3. 测试：`node src/cli.mjs feishu-test`

之后 `report` 发现有变化，除 macOS 通知外会往群里推一张卡片：变化明细 + 涉及公司的入口按钮。
抓取引擎仍在本地 Mac，飞书只是通知层——不接飞书完全不影响使用；webhook 地址别外发（等于把通知权交出去）。

> 同样位置也可以换成其他推送渠道（Bark / Server酱 推微信、企业微信机器人、邮件），需要时再加。

## 文件位置（`ATS_STATUS_HOME` 可改，默认 `~/.ats-status/`）

- `profiles/<site>/` — 各站点浏览器持久会话（含 cookie/localStorage，**敏感**）
- `captured/<site>.json` — 识别出的状态接口定义
- `out/<site>.json` — 最近一次查询结果；`out/<site>.history.jsonl` — 历史轨迹（状态变化对比基于它）
- `apps.json` — 手工投递列表（import 导入或直接编辑）
- `out/dashboard.html` — 总览面板（report 生成）；`out/_report.last.json` — 上次报告对比基线

## 风险与边界

- 只做**只读查询自己的投递状态**；投递、改简历等写操作一律不支持。
- 自动化使用普遍违反招聘平台用户协议，本工具把流量压到"真人刷进度"量级（每站点每天约 2–4 次真实页面访问）来降低风险，但**不等于零风险**：请接受"账号可能作废"这一前提，不要把任何一家当成唯一渠道；如果某站点对你至关重要，直接人工查看它。
- 各站点风险定级与频率依据（2026-09 实测）：

| 站点 | 风险 | 实测依据 | 保活策略 |
|---|---|---|---|
| 阿里 | 高 | 登录页 baxia 反爬脚本 + mtop 签名网关 | 12h 固定，掉线不加密；状态 ≤1 次/天 |
| 小红书 | 高 | redcaptcha 验证码风控 | 12h 固定，掉线不加密 |
| 字节 / 美团 | 中 | 自研强风控，查状态是常态行为 | 12h 起，掉线减半至 6h 封底 |
| 快手 / 携程 | 低 | 快手裸 API 无验证码；Moka 多租户 SaaS 宽容 | 12h 起，掉线减半至 3h 封底 |

- 会话失效（改密码、异地登录、站点清理）→ 重新 `login` 即可；反复掉线的站点应放弃保活。
- 站点改版导致接口变化 → 重新 `capture`。
- 若查询触发验证码/风控页 → 该站点立即停止自动化，人工查看；不要重试。
