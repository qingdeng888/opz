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
 *     "type": "none",               // none | http | socks5 | http_pool | socks5_pool
 *     "host": "",
 *     "port": 0,
 *     "username": "",
 *     "password": "",
 *     "pool": []                    // 代理池(仅 http_pool / socks5_pool 使用)
 *   },
 *   "freeModels": [],                // 免费模型白名单(空则回退内置默认,热加载)
 *   "upstreamKey": ""                // opencode.ai API Key(sk-xxx),网关转发时带 Authorization;留空则不带
 * }
 *
 * 代理池条目(pool[])与单个代理结构一致,type 恒为 http 或 socks5。
 * 面板导入格式每行一个:
 *   http://user:password@ip:port
 *   socks5://user:password@ip:port
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
  proxy: { type: 'none', host: '', port: 0, username: '', password: '', pool: [] },
  freeModels: [],
  upstreamKey: '',
};

const PROXY_TYPES = ['http', 'socks5', 'none', 'http_pool', 'socks5_pool'];

// 非法/缺省代理归一为 none,并保证字段齐全
function normalizeProxy(p) {
  const src = (p && typeof p === 'object') ? p : {};
  const type = PROXY_TYPES.includes(src.type) ? src.type : 'none';
  const port = Math.min(65535, Math.max(1, parseInt(src.port) || 0));
  return {
    type,
    host: String(src.host || '').trim(),
    port: port > 1 ? port : 0,
    username: String(src.username || ''),
    password: String(src.password || ''),
    pool: normalizeProxyPool(src.pool),
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

// ---- 代理池 ----

// 尝试解码用户名/密码中的百分号编码,失败则保留原文
function decodeUserInfo(s) {
  if (!s) return '';
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 解析单行代理:http://user:pass@ip:port / socks5://user:pass@ip:port */
function parseProxyLine(line) {
  const s = String(line || '').trim();
  const m = s.match(/^(http|socks5):\/\/(.*)$/i);
  if (!m) return null;
  const type = m[1].toLowerCase();
  let rest = m[2];
  let username = '', password = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const cred = rest.slice(0, at);
    const ci = cred.indexOf(':');
    if (ci >= 0) { username = cred.slice(0, ci); password = cred.slice(ci + 1); }
    else { username = cred; }
    rest = rest.slice(at + 1);
  }
  let host = rest, port = 0;
  // [IPv6]:port 或 host:port;纯 IPv6 不带端口视为非法(缺端口)
  const bracket = host.match(/^\[(.+)\]:(\d+)$/);
  if (bracket) { host = bracket[1]; port = parseInt(bracket[2], 10); }
  else {
    const lc = host.lastIndexOf(':');
    if (lc > 0 && /^\d+$/.test(host.slice(lc + 1))) {
      port = parseInt(host.slice(lc + 1), 10);
      host = host.slice(0, lc);
    }
  }
  host = host.trim();
  if (!host || !(port >= 1 && port <= 65535)) return null;
  return {
    type,
    host,
    port,
    username: decodeUserInfo(username),
    password: decodeUserInfo(password),
  };
}

// 池条目去重指纹(不含密码,密码不同视为同一条目)
function poolKey(e) {
  return `${e.type}|${e.host}|${e.port}|${e.username}`;
}

/** 归一化代理池:接受字符串行或结构化对象,过滤非法/重复 */
function normalizeProxyPool(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    let entry = null;
    if (item && typeof item === 'object') {
      const type = item.type === 'socks5' ? 'socks5' : 'http';
      const port = Math.min(65535, Math.max(1, parseInt(item.port) || 0));
      const host = String(item.host || '').trim();
      if (host && port >= 1) {
        entry = {
          type,
          host,
          port,
          username: String(item.username || ''),
          password: String(item.password || ''),
        };
      }
    } else {
      entry = parseProxyLine(item);
    }
    if (!entry) continue;
    const key = poolKey(entry);
    if (!seen.has(key)) { seen.add(key); out.push(entry); }
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
  return { ...DEFAULT_CONFIG, proxy: { ...DEFAULT_CONFIG.proxy, pool: [] }, freeModels: [] };
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
      pool: (cfg.proxy.pool || []).map(e => ({
        ...e,
        password: e.password ? '********' : '',
      })),
    },
    freeModels: normalizeFreeModels(cfg.freeModels),
    upstreamKey: cfg.upstreamKey ? cfg.upstreamKey.slice(0, 8) + '***' + cfg.upstreamKey.slice(-4) : '',
    // 会话 ID 不加密但也不在前端展示(仅回传做占位)
    // 不回传 adminPassword(前端不展示,也无法从配置读取)
  };
}

module.exports = {
  load, save, genApiKey, ensureAdminPassword,
  normalizeProxy, normalizeFreeModels, normalizeProxyPool, parseProxyLine, sanitize,
  CONFIG_FILE, USAGE_FILE, INFO_FILE,
};
