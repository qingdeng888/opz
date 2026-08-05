/**
 * config.js - 配置管理 + 订阅处理
 *
 * config.json 结构:
 * {
 *   "subscriptionUrl": "https://your-airport.example.com/api/v1/...",
 *   "apiKey": "zen-xxxx",           // 对外暴露的 API Key(用户自定义)
 *   "port": 0,                       // 0 = 自动选端口;>0 = 指定端口
 *   "mihomoExe": "D:\\Program Files\\Clash Verge\\verge-mihomo.exe"
 * }
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const { URL } = require('url');
const yaml = require('js-yaml');

// 运行数据目录:
//   - Electron 下用 userData(%APPDATA%),打包后 app.asar 内不可写
//   - 纯 Node/CLI 下用 $ZEN_DATA_DIR 或 ~/.config/zen-gateway
function getUserDataDir() {
  if (process.env.ZEN_DATA_DIR) return process.env.ZEN_DATA_DIR;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch {}
  return path.join(os.homedir(), '.config', 'zen-gateway');
}
const USER_DATA = getUserDataDir();
const CONFIG_FILE = path.join(USER_DATA, 'config.json');
const MIHOMO_CONFIG = path.join(USER_DATA, 'mihomo-zen.yaml');
const MIHOMO_DATA_DIR = path.join(USER_DATA, 'mihomo-data');
const LAST_NODE_FILE = path.join(USER_DATA, 'last-node.txt');
const USAGE_FILE = path.join(USER_DATA, 'usage.json');

// mihomo 内核可执行文件名:Windows 带 .exe,Linux/macOS 不带
function mihomoBinaryName() {
  return process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
}

// 内置 mihomo 内核目录
// 开发时:desktop-app/resources/mihomo;打包后:resources/mihomo(extraResources 拷贝)
function getBundledMihomoDir() {
  const name = mihomoBinaryName();
  const p = process.resourcesPath ? path.join(process.resourcesPath, 'mihomo') : '';
  try {
    if (p && fs.existsSync(path.join(p, name))) return p;
  } catch {}
  return path.join(__dirname, 'resources', 'mihomo');
}

// 定位内置 mihomo 可执行文件:优先打包后的 resources/mihomo,回退开发目录
function resolveMihomoExe() {
  return path.join(getBundledMihomoDir(), mihomoBinaryName());
}

const DEFAULT_CONFIG = {
  subscriptionUrl: '',
  apiKey: '',
  port: 9527,   // 固定默认端口,避免每次重启都变
  host: '0.0.0.0',  // 监听地址:0.0.0.0 = 外网可访问
  mihomoExe: '',  // 空 = 自动定位内置 mihomo.exe
};

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const merged = { ...DEFAULT_CONFIG, ...c };
      // mihomoExe 为空或指向的文件不存在时,自动回退到内置 mihomo.exe
      if (!merged.mihomoExe || !fs.existsSync(merged.mihomoExe)) {
        merged.mihomoExe = resolveMihomoExe();
      }
      return merged;
    }
  } catch (e) { console.error('load config error:', e.message); }
  return { ...DEFAULT_CONFIG, mihomoExe: resolveMihomoExe() };
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

// 拉取订阅(支持 clash 格式)
function fetchSubscription(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'clash-verge/v2.5' },
      timeout: 30000,
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          return reject(new Error(`HTTP ${resp.statusCode}`));
        }
        try {
          const parsed = yaml.load(data);
          if (!parsed.proxies || !Array.isArray(parsed.proxies)) {
            return reject(new Error('订阅里没有 proxies 字段'));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error('解析订阅失败(不是 Clash 格式): ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// 生成独立 mihomo 配置(端口 17897/19090,与 Clash Verge 隔离)
function buildMihomoConfig(sub) {
  const proxies = (sub.proxies || []).filter(p => p.name && p.type && !['Direct','Reject','Pass','Compatible'].includes(p.type));
  if (proxies.length === 0) throw new Error('没有可用节点');
  const names = proxies.map(p => p.name);

  return {
    'mixed-port': 17897,
    'allow-lan': false,
    'bind-address': '*',
    'mode': 'rule',
    'log-level': 'warning',
    'external-controller': '127.0.0.1:19090',
    'ipv6': false,
    'tcp-concurrent': true,
    'unified-delay': true,
    'tun': { enable: false },
    'dns': {
      'enable': true,
      'ipv6': false,
      'enhanced-mode': 'redir-host',
      'nameserver': ['223.5.5.5', '119.29.29.29'],
      'fallback': ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query'],
    },
    'proxies': proxies,
    'proxy-groups': [
      { name: 'zen-pool', type: 'select', proxies: names },
      { name: 'zen-auto', type: 'url-test', url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 50, proxies: names },
    ],
    'rules': [
      'DOMAIN-SUFFIX,opencode.ai,zen-pool',
      'MATCH,DIRECT',
    ],
  };
}

async function refreshMihomoConfig(subscriptionUrl) {
  if (!subscriptionUrl) throw new Error('订阅 URL 为空');
  const sub = await fetchSubscription(subscriptionUrl);
  const cfg = buildMihomoConfig(sub);
  const yamlStr = yaml.dump(cfg, { noRefs: true });
  fs.writeFileSync(MIHOMO_CONFIG, yamlStr, 'utf8');
  return { nodeCount: cfg.proxies.length };
}

module.exports = { load, save, genApiKey, fetchSubscription, buildMihomoConfig, refreshMihomoConfig, CONFIG_FILE, MIHOMO_CONFIG, MIHOMO_DATA_DIR, LAST_NODE_FILE, USAGE_FILE, resolveMihomoExe, getBundledMihomoDir, mihomoBinaryName };
