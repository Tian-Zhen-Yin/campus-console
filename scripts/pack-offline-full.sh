#!/bin/bash
# 打包「校招投递管理 · 完整版」（Mac）：控制台代码 + 内嵌台账 + 双击安装器
# 产物：dist/校招投递管理-完整版-Mac-v<版本>.zip
# 用法：bash scripts/pack-offline-full.sh [版本号]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-3.3.1}"
TRACKER_REPO="${TRACKER_REPO:-$(git config --get campus.trackerRepo)}"
STAGE_ROOT="$(mktemp -d)/校招投递管理-完整版-Mac-v$VERSION"

echo "▸ 组装包内容 → $STAGE_ROOT"
mkdir -p "$STAGE_ROOT"

# 控制台源码（不含依赖/仓库/临时物）
mkdir -p "$STAGE_ROOT/ats-status"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude '.tmp*' \
  --exclude '*.raw.json' "$REPO_DIR/src" "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" \
  "$REPO_DIR/README.md" "$REPO_DIR/INSTALL.md" "$REPO_DIR/scripts" "$REPO_DIR/docs" "$STAGE_ROOT/ats-status/"

# 台账（控制台托管于 / 的静态站点）
mkdir -p "$STAGE_ROOT/ats-status/tracker"
rsync -a --exclude .git --exclude downloads --exclude download.html \
  "$TRACKER_REPO/index.html" "$TRACKER_REPO/manifest.webmanifest" "$TRACKER_REPO/service-worker.js" \
  "$TRACKER_REPO/icons" "$TRACKER_REPO/ocr" "$TRACKER_REPO/docs" "$TRACKER_REPO/使用说明.txt" \
  "$STAGE_ROOT/ats-status/tracker/"

# 顶层双击安装器、必读说明与文档
cat > "$STAGE_ROOT/安装.command" <<'EOF'
#!/bin/bash
cd "$(dirname "$0")"
bash ats-status/scripts/install.sh
read -n 1 -s -r -p "安装结束，按任意键关闭本窗口…"
EOF
chmod +x "$STAGE_ROOT/安装.command"
cp "$REPO_DIR/docs/必读-安装说明.txt" "$STAGE_ROOT/必读-安装说明.txt"
cp "$REPO_DIR/INSTALL.md" "$STAGE_ROOT/安装说明.md"

echo "▸ 压缩 zip……"
# zip 顶层直接是包内容（不再套一层中文目录）：解压即平铺，安装器路径无中文层级
STAGE_PARENT="$(dirname "$STAGE_ROOT")"
( cd "$STAGE_ROOT" && rm -f "$REPO_DIR/dist/校招投递管理-完整版-Mac-v$VERSION.zip" && zip -qr "$REPO_DIR/dist/校招投递管理-完整版-Mac-v$VERSION.zip" . )
ls -lh "$REPO_DIR/dist/校招投递管理-完整版-Mac-v$VERSION.zip"
echo "▸ 完成：$REPO_DIR/dist/校招投递管理-完整版-Mac-v$VERSION.zip"
