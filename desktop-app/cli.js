#!/usr/bin/env node
/**
 * cli.js - Zen Free Gateway 命令行入口(无头/Linux 部署)
 *
 * 替代 Electron 的 main.js:不创建窗口,直接在终端运行。
 * 复用 gateway.js / mihomo.js / config.js,核心逻辑与桌面版一致。
 *
 * 用法:
 *   node cli.js                 # 启动网关 + mihomo
 *   ZEN_DATA_DIR=/path node cli.js   # 自定义数据目录
 *   node cli.js --print-config  # 打印当前配置(隐藏订阅 URL)
 *   node cli.js --reset         # 手动重置(清冷却 + 重拉订阅 + 重启 mihomo)
 */

const path = require('path');
const fs = require('fs');
const { Gateway, FIXED_MODEL } = require('./gateway');
const mihomo = require('./mihomo');
const config = require('./config');

let gateway = null;

function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

// 获取本机局域网 IP(用于 0.0.0.0 监听时提示访问地址)
function getLocalIP() {
  try {
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
  } catch {}
  return '127.0.0.1';
}

// 定位"程序目录":
//   - 编译后的单文件二进制:进程可执行文件所在目录(process.execPath)
//   - 源码(node)运行:本脚本所在目录(__dirname)
function getProgramDir() {
  try {
    const exeBase = path.basename(process.execPath);
    if (exeBase !== 'node' && exeBase !== 'bun' && exeBase !== 'nodejs') {
      return path.dirname(process.execPath);
    }
  } catch {}
  return __dirname;
}

async function ensureMihomo(cfg) {
  const running = await mihomo.isRunning();
  if (!running) {
    log('info', '[mihomo] 未运行,启动中...');
    await mihomo.start(cfg.mihomoExe, log);
  } else {
    log('ok', '[mihomo] 已在运行');
  }
}

async function startGateway(cfg) {
  if (gateway) { await gateway.stop(); gateway = null; }
  gateway = new Gateway({ apiKey: cfg.apiKey, port: cfg.port, host: cfg.host || '0.0.0.0', USAGE_FILE: config.USAGE_FILE }, log);
  const port = await gateway.start();
  if (port !== cfg.port) {
    cfg.port = port;
    config.save(cfg);
    log('info', `[config] 端口已保存为 ${port}`);
  }
  return port;
}

async function bootstrap() {
  let cfg = config.load();
  // 环境变量覆盖(便于无头部署):
  if (process.env.ZEN_HOST) cfg.host = process.env.ZEN_HOST;
  if (process.env.ZEN_PORT) cfg.port = parseInt(process.env.ZEN_PORT, 10);
  if (!cfg.apiKey) {
    cfg.apiKey = config.genApiKey();
    config.save(cfg);
    log('info', `[init] 生成 API Key: ${cfg.apiKey}`);
  }

  try { fs.mkdirSync(config.MIHOMO_DATA_DIR, { recursive: true }); } catch {}

  if (cfg.subscriptionUrl) {
    try {
      log('info', '[sub] 刷新订阅...');
      const r = await config.refreshMihomoConfig(cfg.subscriptionUrl);
      log('ok', `[sub] 已刷新,${r.nodeCount} 个节点`);
    } catch (e) {
      log('error', '[sub] 刷新失败: ' + e.message);
    }
  } else if (!fs.existsSync(config.MIHOMO_CONFIG)) {
    const bundled = path.join(config.getBundledMihomoDir(), 'mihomo-zen.yaml');
    try {
      if (fs.existsSync(bundled)) {
        fs.copyFileSync(bundled, config.MIHOMO_CONFIG);
        log('ok', '[sub] 使用内置 mihomo 配置');
      } else {
        log('warn', '[sub] 未配置订阅 URL,且无内置配置,mihomo 不会启动');
      }
    } catch (e) {
      log('error', '[sub] 写入内置配置失败: ' + e.message);
    }
  }

  try {
    await ensureMihomo(cfg);
  } catch (e) {
    log('error', '[mihomo] 启动失败: ' + e.message);
  }

  const port = await startGateway(cfg);
  const host = cfg.host || '0.0.0.0';
  const displayHost = host === '0.0.0.0' ? getLocalIP() : host;
  log('ok', `[gateway] 已启动: http://${displayHost}:${port}`);
  log('ok', `[gateway] URL: http://${displayHost}:${port}/v1`);
  log('ok', `[gateway] Key: ${cfg.apiKey}`);
  log('ok', `[gateway] Model: ${FIXED_MODEL} (固定)`);
  log('info', `[gateway] 配置目录: ${config.CONFIG_FILE}`);
  // 写入连接信息文件,方便 systemd 后台运行后查看。
  // 优先放程序目录(二进制所在目录),不可写时依次回退:当前目录 -> 数据目录。
  const infoCandidates = [
    path.join(getProgramDir(), 'info.txt'),
    path.join(process.cwd(), 'info.txt'),
    path.join(path.dirname(config.CONFIG_FILE), 'info.txt'),
  ];
  let infoFile = null;
  try {
    const info = [
      'Zen Free Gateway 连接信息',
      '=========================',
      `端口:      ${port}`,
      `监听:      ${host}`,
      `Base URL:  http://${displayHost}:${port}/v1`,
      `API Key:   ${cfg.apiKey}`,
      `Model:     ${FIXED_MODEL}`,
      `数据目录:  ${config.CONFIG_FILE}`,
      `生成时间:  ${new Date().toISOString()}`,
      '',
    ].join('\n');
    for (const cand of infoCandidates) {
      try {
        fs.writeFileSync(cand, info, 'utf8');
        infoFile = cand;
        break;
      } catch {}
    }
    if (infoFile) {
      log('ok', `[gateway] 连接信息已写入: ${infoFile}`);
    } else {
      log('warn', '[gateway] 无法写入 info.txt(所有位置均失败)');
    }
  } catch (e) {
    log('warn', '[gateway] 写 info.txt 失败: ' + e.message);
  }
  log('info', '[ctrl] Ctrl+C 停止');
}

async function manualReset() {
  log('warn', '===== 手动重置开始 =====');
  const cfg = config.load();
  if (gateway) { gateway.pause(); log('info', '[reset] gateway 已暂停'); }
  if (gateway) { const n = gateway.resetCooldowns(); log('ok', `[reset] 清空 ${n} 个冷却记录`); }
  if (cfg.subscriptionUrl) {
    try {
      const r = await config.refreshMihomoConfig(cfg.subscriptionUrl);
      log('ok', `[reset] 订阅刷新,${r.nodeCount} 个节点`);
    } catch (e) { log('error', '[reset] 订阅刷新失败: ' + e.message); }
  }
  try {
    await mihomo.stop(log);
    await sleep(800);
    await ensureMihomo(cfg);
  } catch (e) { log('error', '[reset] mihomo 重启失败: ' + e.message); }
  try {
    if (fs.existsSync(config.LAST_NODE_FILE)) fs.unlinkSync(config.LAST_NODE_FILE);
    log('ok', '[reset] 已清除上次节点记录');
  } catch {}
  if (gateway) { gateway.resume(); log('ok', '[reset] gateway 已恢复'); }
  log('ok', '===== 手动重置完成 =====');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const arg = process.argv[2];
  if (arg === '--print-config') {
    const cfg = config.load();
    console.log(JSON.stringify({ ...cfg, subscriptionUrl: cfg.subscriptionUrl ? '***' : '' }, null, 2));
    return;
  }
  if (arg === '--reset') { await manualReset(); return; }
  if (arg && arg.startsWith('-')) {
    console.error('未知参数: ' + arg);
    console.error('用法: node cli.js [--print-config|--reset]');
    process.exit(1);
  }

  await bootstrap();

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log('info', `[ctrl] 收到 ${sig},正在停止...`);
    if (gateway) { try { await gateway.stop(); } catch {} }
    await mihomo.stop(log);
    log('ok', '[ctrl] 已停止,再见');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
