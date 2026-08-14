#!/usr/bin/env bash
#
# Zen Free Gateway - 一键启动脚本(Linux/macOS)
#
# 用法:
#   ./start.sh           启动网关(前台,Ctrl+C 停止)
#   ./start.sh status    查看运行状态
#   ./start.sh reload    重新加载配置(打印脱敏摘要)
#   ./start.sh config    打印当前配置
#
# 环境变量(可选):
#   ZEN_DATA_DIR      数据目录,默认 <项目>/desktop-app/.zen-data
#   ZEN_PORT          网关端口,默认 9527
#   ZEN_ADMIN_PASSWORD 管理面板密码(首次启动时写入配置)
#   ZEN_PROXY         代理,格式 http:host:port 或 socks5:host:port
#   ZEN_FREE_MODELS   免费模型白名单(逗号分隔),覆盖内置默认
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/desktop-app"

# ---- 数据目录(默认项目内,自包含便于搬运)----
export ZEN_DATA_DIR="${ZEN_DATA_DIR:-$APP_DIR/.zen-data}"
mkdir -p "$ZEN_DATA_DIR"

# ---- 前置检查 ----
command -v node >/dev/null 2>&1 || { echo "✗ 未找到 node,请先安装 Node.js >= 20"; exit 1; }
node -e "const [mj,mn]=process.versions.node.split('.').map(Number);if(mj<20){console.error('✗ 需要 Node.js >= 20,当前 '+process.versions.node);process.exit(1)}" || exit 1

cd "$APP_DIR"

case "${1:-start}" in
  start)
    echo "▶ 启动 Zen Free Gateway ..."
    echo "  数据目录: $ZEN_DATA_DIR"
    exec node cli.js
    ;;
  status)
    PORT="${ZEN_PORT:-9527}"
    echo "== 网关 =="
    if curl -s --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo "✔ 网关运行中 ($PORT)"
      curl -s --max-time 3 "http://127.0.0.1:$PORT/health"; echo
    else
      echo "✗ 网关未运行"
    fi
    ;;
  reload)
    echo "▶ 重新加载配置 ..."
    exec node cli.js --reload
    ;;
  config)
    echo "== 当前配置 =="
    node cli.js --print-config
    ;;
  *)
    echo "未知命令: $1"
    echo "用法: $0 [start|status|reload|config]"
    exit 1
    ;;
esac
