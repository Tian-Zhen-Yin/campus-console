#!/bin/bash
# 打包「校招投递管理 · 完整版 Windows」（在 Mac 上执行，产物跨平台）
# 产物：dist/校招投递管理-完整版-Windows-v<版本>.zip
# 内容：控制台源码 + node_modules（纯 JS 跨平台）+ 内嵌台账 + Windows 安装/启动脚本
#       不含 node.exe——首次安装由 install.ps1 自动从 nodejs.org 下载便携版（免管理员）
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-3.3.1}"
TRACKER_REPO="${TRACKER_REPO:-$(git config --get campus.trackerRepo)}"
STAGE_ROOT="$(mktemp -d)/校招投递管理-完整版-Windows-v$VERSION"

echo "▸ 组装包内容 → $STAGE_ROOT"
mkdir -p "$STAGE_ROOT"

# 控制台源码 + 依赖（node_modules 为纯 JS，跨平台直接复制；排除本机开发回退与产物）
mkdir -p "$STAGE_ROOT/ats-status"
rsync -a \
  --exclude node_modules/.bin \
  --exclude dev-local.mjs \
  --exclude .git --exclude dist --exclude '.tmp*' \
  --exclude '*.raw.json' \
  "$REPO_DIR/src" "$REPO_DIR/scripts" "$REPO_DIR/docs" \
  "$REPO_DIR/node_modules" \
  "$REPO_DIR/package.json" "$REPO_DIR/INSTALL.md" \
  "$STAGE_ROOT/ats-status/"

# 内嵌台账
mkdir -p "$STAGE_ROOT/ats-status/tracker"
rsync -a --exclude .git --exclude downloads --exclude download.html \
  "$TRACKER_REPO/index.html" "$TRACKER_REPO/manifest.webmanifest" "$TRACKER_REPO/service-worker.js" \
  "$TRACKER_REPO/icons" "$TRACKER_REPO/ocr" "$TRACKER_REPO/docs" "$TRACKER_REPO/使用说明.txt" \
  "$STAGE_ROOT/ats-status/tracker/"

# Windows 安装器与日常脚本（.bat 为 CRLF 编码的薄壳，双击即调对应 ps1）
write_bat() {
  printf '@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%%~dp0ats-status\\scripts\\win\\%s" %%*\r\n' "$2" > "$STAGE_ROOT/$1"
}
write_bat '安装.bat'   'install.ps1'
write_bat '启动.bat'   'start.ps1'
write_bat '卸载.bat'   'uninstall.ps1'

# Windows 必读说明
cat > "$STAGE_ROOT/必读-Windows.txt" <<'EOF'
必读｜Windows 版第一次安装
==========================

1. 解压本文件夹到一个不会随便移动/删除的位置
2. 双击「安装.bat」——Windows 可能弹出蓝色 SmartScreen 提示：
   点「更多信息」→「仍要运行」（这是对未签名脚本的统一检查，仅此一次）
3. 首次安装会自动下载便携版 Node 运行时（约 30MB，来自 nodejs.org 官方地址，
   免安装、免管理员），之后自动启动台账页面 http://127.0.0.1:7788/
4. 日常使用直接开台账页面（建议收藏）；「启动.bat」可随时手动启动服务

卸载：双击「卸载.bat」移除计划任务，再删除本文件夹与 %USERPROFILE%\.ats-status
EOF

echo "▸ 压缩 zip……"
mkdir -p "$REPO_DIR/dist"
STAGE_PARENT="$(dirname "$STAGE_ROOT")"
( cd "$STAGE_ROOT" && rm -f "$REPO_DIR/dist/校招投递管理-完整版-Windows-v$VERSION.zip" && zip -qr "$REPO_DIR/dist/校招投递管理-完整版-Windows-v$VERSION.zip" . )
ls -lh "$REPO_DIR/dist/校招投递管理-完整版-Windows-v$VERSION.zip"
echo "▸ 完成：$REPO_DIR/dist/校招投递管理-完整版-Windows-v$VERSION.zip"
