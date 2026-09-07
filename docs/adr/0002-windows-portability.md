# Windows 移植与分发：便携运行时 + 双通道安装 + 公开仓库

控制台此前仅支持 macOS（launchd 常驻、osascript 通知、Apple 脚本安装）。为覆盖 Windows 用户，我们决定：**不重写 UI、不引入 Electron**，将引擎层（纯 JS，Playwright/IMAP/状态包全部跨平台）适配到 Windows，分发采用「小包 + 首启自动补齐运行时」——安装包约 15MB（源码 + node_modules + 内嵌台账 + 脚本），首次安装时自动从 nodejs.org 官方地址下载便携版 Node 到包内 `runtime\`，免管理员、不改注册表。安装入口双通道：PowerShell 一行命令（`irm | iex`，不落地文件、完全避开 SmartScreen）为主，zip 内 `.bat` 双击为辅（一次 SmartScreen 批准）。

浏览器自动化优先 Chrome 通道、回退系统 Edge（Windows 必带）；常驻语义为登录自启（ONLOGON 计划任务），进程崩溃不自动拉起（v1 取舍：不为个人工具引入 NSSM 服务包装）。跨平台验证依靠公开 GitHub 仓库的 Windows Actions 冒烟（启动/静态/API/计划任务/Edge 通道），真实官网登录联调由用户在真机收尾。

## Considered Options

- **Electron/Tauri 封装**：否决——签名成本与 .pkg 相同（99 美元/年），UI 已是网页，重写纯属增重。
- **Homebrew/winget 作为运行时分发**：否决——对零技术用户是二次门槛（需先装包管理器）。
- **全内置便携 Node（零联网）**：否决——包体从约 15MB 涨到 45MB，换来的只是首次安装免一次 30MB 下载。
- **强守护进程（NSSM）**：否决——个人工具崩溃后手动重启成本可接受。

## Consequences

- Windows 交付包与 Mac 包同版本号、平台标签区分；两侧安装脚本各自独立（install.sh / install.ps1）。
- 公开发布的源码仓库必须**无本机绝对路径、无历史泄露**：开发机路径走 gitignore 的 `dev-local.mjs`，公开仓库以单条初始提交建立。
