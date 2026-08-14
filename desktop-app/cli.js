#!/usr/bin/env node
/**
 * cli.js - Zen Free Gateway 命令行入口(无头/Linux 部署)
 *
 * 用法:
 *   node cli.js                        # 启动网关
 *   ZEN_DATA_DIR=/path node cli.js     # 自定义数据目录
 *   ZEN_PROXY=http:127.0.0.1:7890 node cli.js   # 环境变量指定代理
 *   node cli.js --print-config         # 打印当前配置(敏感项脱敏)
 *   node cli.js --reload               # 重新加载配置(打印脱敏摘要)
 *
 * 首次启动自动生成 API Key 与管理面板密码,写入配置并打印。
 */

const path = require('path');
const fs = require('fs');
const { Gateway, FIXED_MODEL } = require('./gateway');
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

// 定位"程序目录":编译后的单文件二进制用可执行文件所在目录,源码用 __dirname
function getProgramDir() {
  try {
    const exeBase = path.basename(process.execPath);
    if (exeBase !== 'node' && exeBase !== 'bun' && exeBase !== 'nodejs') {
      return path.dirname(process.execPath);
    }
  } catch {}
  return __dirname;
}

// 解析 ZEN_PROXY 环境变量:http:host:port / socks5:host:port / 可带 user:pass@
function parseProxyEnv(s) {
  const m = String(s || '').match(/^(http|socks5):(.+)$/);
  if (!m) return null;
  const type = m[1];
  let rest = m[2];
  let username = '', password = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const cred = rest.slice(0, at);
    const ai = cred.indexOf(':');
    if (ai >= 0) { username = cred.slice(0, ai); password = cred.slice(ai + 1); }
    else { username = cred; }
    rest = rest.slice(at + 1);
  }
  let host = rest, port = 0;
  const m2 = host.match(/^(.*):(\d+)$/);
  if (m2) { host = m2[1]; port = parseInt(m2[2], 10); }
  return config.normalizeProxy({ type, host, port, username, password });
}

// 首启初始化:API Key / 管理密码 / 环境变量覆盖
function applyEnvAndInit(cfg) {
  let changed = false;

  if (process.env.ZEN_HOST) { cfg.host = process.env.ZEN_HOST; changed = true; }
  if (process.env.ZEN_PORT) { cfg.port = parseInt(process.env.ZEN_PORT, 10); changed = true; }
  if (process.env.ZEN_ADMIN_PASSWORD) { cfg.adminPassword = process.env.ZEN_ADMIN_PASSWORD; changed = true; }
  if (process.env.ZEN_PROXY) {
    const p = parseProxyEnv(process.env.ZEN_PROXY);
    if (p) {
      cfg.proxy = p;
      changed = true;
      log('info', `[init] 使用环境变量代理: ${p.type}://${p.username ? p.username + '@' : ''}${p.host}:${p.port || '(默认)'}`);
    } else {
      log('warn', '[init] ZEN_PROXY 格式无效,应为 http:host:port / socks5:host:port(可带 user:pass@)');
    }
  }

  // ZEN_FREE_MODELS:逗号分隔的免费模型白名单,覆盖内置默认(仅供首启/初始部署)
  if (process.env.ZEN_FREE_MODELS) {
    const fm = config.normalizeFreeModels(process.env.ZEN_FREE_MODELS.split(','));
    if (fm.length) {
      cfg.freeModels = fm;
      changed = true;
      log('info', `[init] 免费模型白名单(env): ${fm.join(', ')}`);
    }
  }

  if (!cfg.apiKey) {
    cfg.apiKey = config.genApiKey();
    changed = true;
    log('info', `[init] 生成 API Key: ${cfg.apiKey}`);
  }
  if (!cfg.adminPassword) {
    config.ensureAdminPassword(cfg);
    changed = true;
    log('info', `[init] 生成管理面板密码: ${cfg.adminPassword}`);
  }

  if (changed) config.save(cfg);
  return cfg;
}

async function startGateway(cfg) {
  if (gateway) { await gateway.stop(); gateway = null; }
  gateway = new Gateway(cfg, log);
  const port = await gateway.start();
  if (port !== cfg.port) {
    cfg.port = port;
    config.save(cfg);
    log('info', `[config] 端口已保存为 ${port}`);
  }
  return port;
}

async function bootstrap() {
  let cfg = applyEnvAndInit(config.load());

  const port = await startGateway(cfg);
  const host = cfg.host || '0.0.0.0';
  const displayHost = host === '0.0.0.0' ? getLocalIP() : host;
  const panelUrl = `http://${displayHost}:${port}`;

  console.log('┌──────────────────────────────────────────────┐');
  console.log('│          Zen Free Gateway 已启动              │');
  console.log('├──────────────────────────────────────────────┤');
  console.log(`│ 管理面板: ${panelUrl.padEnd(28)}│`);
  console.log(`│ 面板密码: ${String(cfg.adminPassword).padEnd(28)}│`);
  console.log(`│ API 端点: ${(panelUrl + '/v1').padEnd(28)}│`);
  console.log(`│ API Key:  ${String(cfg.apiKey).padEnd(28)}│`);
  console.log(`│ 模型:     ${FIXED_MODEL.padEnd(28)}│`);
  console.log(`│ 出站:     ${String(gateway.proxyLabel()).padEnd(28)}│`);
  console.log('└──────────────────────────────────────────────┘');
  log('info', `[gateway] 配置目录: ${config.CONFIG_FILE}`);

  // 写入连接信息文件(含面板密码,注意保护该文件)
  // 候选为「目录」,信息文件固定名为 info.txt
  const infoCandidates = [
    getProgramDir(),
    process.cwd(),
    path.dirname(config.CONFIG_FILE),
  ];
  const info = [
    'Zen Free Gateway 连接信息(敏感,请勿泄露)',
    '=========================',
    `管理面板:  ${panelUrl}`,
    `面板密码:  ${cfg.adminPassword}`,
    `Base URL:  ${panelUrl}/v1`,
    `API Key:   ${cfg.apiKey}`,
    `Model:     ${FIXED_MODEL}`,
    `数据目录:  ${config.CONFIG_FILE}`,
    `生成时间:  ${new Date().toISOString()}`,
    '',
  ].join('\n');
  for (const cand of infoCandidates) {
    try {
      fs.mkdirSync(cand, { recursive: true });
      fs.writeFileSync(path.join(cand, 'info.txt'), info, 'utf8');
      log('ok', `[gateway] 连接信息已写入: ${path.join(cand, 'info.txt')}`);
      break;
    } catch {}
  }

  log('info', '[ctrl] Ctrl+C 停止');
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--print-config') {
    const cfg = config.load();
    console.log(JSON.stringify(config.sanitize(cfg), null, 2));
    return;
  }
  if (arg === '--reload') {
    const cfg = config.load();
    console.log('== 当前配置(脱敏)==');
    console.log(JSON.stringify(config.sanitize(cfg), null, 2));
    return;
  }
  if (arg && arg.startsWith('-')) {
    console.error('未知参数: ' + arg);
    console.error('用法: node cli.js [--print-config|--reload]');
    process.exit(1);
  }

  await bootstrap();

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log('info', `[ctrl] 收到 ${sig},正在停止...`);
    if (gateway) { try { await gateway.stop(); } catch {} }
    log('ok', '[ctrl] 已停止,再见');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
