#!/usr/bin/env bash
#
# 构建 Zen Free Gateway 的单文件可执行程序(Debian 13 x86_64)
#
# 依赖:已安装 bun(https://bun.sh)
# 产物:desktop-app/dist/zen-gateway + desktop-app/dist/resources/
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/desktop-app"
DIST="$APP_DIR/dist"

command -v bun >/dev/null 2>&1 || { echo "✗ 未找到 bun,请先安装: curl -fsSL https://bun.sh/install | bash"; exit 1; }

echo "▶ 编译单文件可执行程序 ..."
cd "$APP_DIR"
mkdir -p "$DIST"
bun build --compile --external electron ./cli.js --outfile "$DIST/zen-gateway"

echo "▶ 复制 mihomo 资源目录(next to 二进制) ..."
cp -r resources "$DIST/"
rm -f "$DIST/resources/mihomo/mihomo.exe"   # 只保留 Linux 版内核

echo "▶ 运行说明: dist/README.md(构建时保留,不覆盖)"

echo "✔ 构建完成:"
du -sh "$DIST"
ls -la "$DIST"
