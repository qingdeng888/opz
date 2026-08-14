/**
 * config.js - 配置管理(无订阅、无 mihomo)
 *
 * config.json 结构:
 * {
 *   "apiKey": "zen-xxxx",          // 对外暴露的 API Key(用户自定义或自动生成)
 *   "adminPassword": "",            // 管理面板密码,空则首启自动生成
 *   "port": 9527,                   // 网关端口
 *   "host": "0.0.0.0",              // 监听地址
 *   "proxy": {                      // 出站代理
 *     "type": "none",               // none | http | socks5
 *     "host": "",
 *     "port": 0,
 *     "username": "",
 *     "password": ""
 *   },
 *   "freeModels": []                // 免费模型白名单(空则回退内置默认,热加载)
 * }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 运行数据目录:
//   - 优先 $ZEN_DATA_DIR(便于搬运)
//   - 回退 ~/.config/zen-gateway
function getUserDataDir() {
  if (process.env.ZEN_DATA_DIR) return process.env.ZEN_DATA_DIR;
  return path.join(os.homedir(), '.config', 'zen-gateway');
}
const USER_DATA = getUserDataDir();
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
const USAGE_FILE = path.join(USER_DATA, 'usage.json');
const INFO_FILE = path.join(USER_DATA, 'info.txt');

const DEFAULT_CONFIG = {
  apiKey: '',
  adminPassword: '',
  port: 9527,
  host: '0.0.0.0',
  proxy: { type: 'none', host: '', port: 0, username: '', password: '' },
  freeModels: [],
};

// 非法/缺省代理归一为 none,并保证字段齐全
function normalizeProxy(p) {
  const src = (p && typeof p === 'object') ? p : {};
  const type = ['http', 'socks5', 'none'].includes(src.type) ? src.type : 'none';
  const port = Math.min(65535, Math.max(1, parseInt(src.port) || 0));
  return {
    type,
    host: String(src.host || '').trim(),
    port: port > 1 ? port : 0,
    username: String(src.username || ''),
    password: String(src.password || ''),
  };
}

// 归一化免费模型列表:仅保留非空字符串,去首尾空白并去重
function normalizeFreeModels(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const s = String(item || '').trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const merged = { ...DEFAULT_CONFIG, ...c };
      merged.proxy = normalizeProxy(merged.proxy);
      merged.freeModels = normalizeFreeModels(merged.freeModels);
      return merged;
    }
  } catch (e) { console.error('load config error:', e.message); }
  return { ...DEFAULT_CONFIG, proxy: { ...DEFAULT_CONFIG.proxy }, freeModels: [] };
}

function save(cfg) {
  try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); } catch {}
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function genApiKey() {
  // 生成形如 zen-a1b2c3d4 的 key
  const rand = Math.random().toString(16).slice(2, 10);
  return 'zen-' + rand;
}

// 管理面板密码为空时自动生成(base64url,~9 字节熵)
function ensureAdminPassword(cfg) {
  if (!cfg.adminPassword) {
    cfg.adminPassword = crypto.randomBytes(9).toString('base64url');
  }
  return cfg.adminPassword;
}

// 对外输出时脱敏:密码不裸奔
function sanitize(cfg) {
  return {
    apiKey: cfg.apiKey,
    port: cfg.port,
    host: cfg.host,
    proxy: {
      ...cfg.proxy,
      password: cfg.proxy.password ? '********' : '',
    },
    freeModels: normalizeFreeModels(cfg.freeModels),
    // 不回传 adminPassword(前端不展示,也无法从配置读取)
  };
}

module.exports = { load, save, genApiKey, ensureAdminPassword, normalizeProxy, normalizeFreeModels, sanitize, CONFIG_FILE, USAGE_FILE, INFO_FILE };
