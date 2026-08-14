#!/usr/bin/env bash
#
# 构建 Zen Free Gateway 的单文件可执行程序(Debian 13 x86_64)
#
# 依赖:已安装 bun(https://bun.sh)
# 产物:desktop-app/dist/zen-gateway
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/desktop-app"
DIST="$APP_DIR/dist"

command -v bun >/dev/null 2>&1 || { echo "✗ 未找到 bun,请先安装: curl -fsSL https://bun.sh/install | bash"; exit 1; }

echo "▶ 编译单文件可执行程序 ..."
cd "$APP_DIR"
mkdir -p "$DIST"
bun build --compile ./cli.js --outfile "$DIST/zen-gateway"

echo "✔ 构建完成:"
du -sh "$DIST"
ls -la "$DIST"
