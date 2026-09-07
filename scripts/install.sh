#!/bin/bash
# 校招投递管理 · 完整版一键安装（Mac）
# 做四件事：检查环境 → 安装依赖 → 注册常驻服务与定时任务 → 打开台账
# 用法：bash scripts/install.sh          （正常安装）
#       bash scripts/install.sh --dry-run（只检查不安装）
set -u
# 中文文案紧贴变量的写法要求 UTF-8 locale：C locale 下 bash 会把全角标点字节并进变量名
export LANG="${LANG:-en_US.UTF-8}"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$HOME/.ats-status"
PLIST_DIR="$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node || true)"

say()  { echo "▸ $*"; }
ok()   { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; exit 1; }
run()  { if [ "$DRY_RUN" = "1" ]; then echo "  [dry-run] $*"; else eval "$*"; fi; }

echo "━━━ 校招投递管理 · 完整版安装 ━━━"
[ "$(uname)" = "Darwin" ] || fail "本安装脚本只支持 macOS"
[ -n "$NODE_BIN" ] || fail "未找到 Node.js——请先安装（brew install node 或 https://nodejs.org）"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node 版本过旧（$("$NODE_BIN" -v)），需要 ≥ 18"
ok "Node $("$NODE_BIN" -v)"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -f "$CHROME" ] && ok "Chrome 已安装" || say "⚠ 未找到 Chrome——官网登录窗口依赖 Chrome，请先安装；内置浏览器兜底可能需要额外下载"

say "项目位置：$REPO_DIR"
[ -f "$REPO_DIR/package.json" ] || fail "请在仓库目录结构中运行（scripts/install.sh）"

say "安装依赖（npm install）……"
run "cd \"$REPO_DIR\" && npm install --no-fund --no-audit --loglevel=error"
ok "依赖就绪"

if [ ! -f "$CHROME" ]; then
  say "预下载内置浏览器（约 150MB，仅在无 Chrome 时需要）……"
  run "cd \"$REPO_DIR\" && npx playwright install chromium"
fi

say "注册常驻服务（com.ats-status.console）……"
mkdir -p "$HOME_DIR/out"
# 清理游离的旧控制台进程：端口被残留实例占用会让正式服务崩溃循环（EADDRINUSE）
PORT_PIDS="$(lsof -ti tcp:7788 -sTCP:LISTEN 2>/dev/null || true)"
for pid in $PORT_PIDS; do
  if ps -p "$pid" -o command= | grep -q "cli.mjs ui"; then
    say "发现游离的旧控制台进程（pid ${pid}），先结束它……"
    run "kill $pid"
  fi
done
CONSOLE_PLIST="$PLIST_DIR/com.ats-status.console.plist"
run "launchctl bootout gui/$(id -u)/com.ats-status.console 2>/dev/null"
run "sleep 1"
run "cat > \"$CONSOLE_PLIST\" <<PLIST
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>com.ats-status.console</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string><string>src/cli.mjs</string><string>ui</string><string>--no-open</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME_DIR/out/console.stdout.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/out/console.stderr.log</string>
</dict></plist>
PLIST
launchctl bootstrap gui/$(id -u) \"$CONSOLE_PLIST\" || { sleep 2; launchctl bootstrap gui/$(id -u) \"$CONSOLE_PLIST\"; }"

say "注册定时任务（工作日 9:30 / 14:30 / 20:00 自动查询 + 检查邮箱）……"
SCHEDULE_PLIST="$PLIST_DIR/com.ats-status.schedule.plist"
run "launchctl bootout gui/$(id -u)/com.ats-status.schedule 2>/dev/null"
run "cat > \"$SCHEDULE_PLIST\" <<PLIST
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>com.ats-status.schedule</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/curl</string><string>-s</string><string>-X</string><string>POST</string>
    <string>-H</string><string>content-type: application/json</string>
    <string>-d</string><string>{}</string>
    <string>--max-time</string><string>600</string>
    <string>http://127.0.0.1:7788/api/status</string>
  </array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer><key>Weekday</key><integer>1</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer><key>Weekday</key><integer>2</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer><key>Weekday</key><integer>3</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer><key>Weekday</key><integer>4</integer></dict>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer><key>Weekday</key><integer>5</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>30</integer><key>Weekday</key><integer>1</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>30</integer><key>Weekday</key><integer>2</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>30</integer><key>Weekday</key><integer>3</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>30</integer><key>Weekday</key><integer>4</integer></dict>
    <dict><key>Hour</key><integer>14</integer><key>Minute</key><integer>30</integer><key>Weekday</key><integer>5</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>1</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>2</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>3</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>4</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer><key>Weekday</key><integer>5</integer></dict>
  </array>
</dict></plist>
PLIST
launchctl bootstrap gui/$(id -u) \"$SCHEDULE_PLIST\""

if [ "$DRY_RUN" = "1" ]; then
  echo "━━━ dry-run 结束：以上为将执行的变更 ━━━"; exit 0
fi

say "等待服务启动……"
for i in $(seq 1 15); do
  curl -s -m 2 http://127.0.0.1:7788/api/state >/dev/null 2>&1 && break
  sleep 1
done
curl -s -m 2 http://127.0.0.1:7788/api/state >/dev/null 2>&1 \
  && ok "服务已启动" \
  || { echo "  ✗ 服务未响应，日志：$HOME_DIR/out/console.stderr.log"; exit 1; }

open "http://127.0.0.1:7788/"
echo "━━━ 安装完成 ━━━"
echo "  台账（日常用）      http://127.0.0.1:7788/"
echo "  控制台（偶尔维护）  http://127.0.0.1:7788/console/"
echo "  使用指南            http://127.0.0.1:7788/guide"
echo "  下一步：在台账「自动跟进」里接入你投过的公司（扫码一次即可）"
