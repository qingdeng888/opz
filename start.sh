#!/usr/bin/env bash
#
# Zen Free Gateway - 一键启动脚本(Linux/macOS)
#
# 用法:
#   ./start.sh           启动网关(前台,Ctrl+C 停止)
#   ./start.sh status    查看运行状态
#   ./start.sh reset     手动重置(清冷却/重拉订阅/重启 mihomo)
#   ./start.sh config    打印当前配置
#
# 环境变量(可选):
#   ZEN_DATA_DIR   数据目录,默认 <项目>/desktop-app/.zen-data
#   ZEN_PORT       网关端口,默认 9527
#   ZEN_SUB_URL    机场订阅 URL(首次启动时写入配置)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/desktop-app"

# ---- 数据目录(默认项目内,自包含便于搬运)----
export ZEN_DATA_DIR="${ZEN_DATA_DIR:-$APP_DIR/.zen-data}"
mkdir -p "$ZEN_DATA_DIR"

# ---- 网关端口 ----
if [ -n "${ZEN_PORT:-}" ]; then
  # 写入配置(若存在)
  if [ -f "$ZEN_DATA_DIR/config.json" ]; then
    node -e "const fs=require('fs');const p='$ZEN_DATA_DIR/config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));c.port=$ZEN_PORT;fs.writeFileSync(p,JSON.stringify(c,null,2));" 2>/dev/null || true
  fi
fi

# ---- 首次运行:写入订阅 URL ----
if [ -n "${ZEN_SUB_URL:-}" ] && [ ! -f "$ZEN_DATA_DIR/config.json" ]; then
  node -e "
    const fs=require('fs');
    const p='$ZEN_DATA_DIR/config.json';
    const c={subscriptionUrl:'$ZEN_SUB_URL',apiKey:'',port:${ZEN_PORT:-9527},mihomoExe:''};
    fs.writeFileSync(p,JSON.stringify(c,null,2));
  "
fi

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
    echo "== mihomo =="
    if curl -s --max-time 3 "http://127.0.0.1:19090/version" >/dev/null 2>&1; then
      echo "✔ mihomo 运行中 ($(curl -s --max-time 3 http://127.0.0.1:19090/version))"
    else
      echo "✗ mihomo 未运行"
    fi
    ;;
  reset)
    echo "▶ 手动重置 ..."
    exec node cli.js --reset
    ;;
  config)
    echo "== 当前配置 =="
    node cli.js --print-config
    ;;
  *)
    echo "未知命令: $1"
    echo "用法: $0 [start|status|reset|config]"
    exit 1
    ;;
esac
