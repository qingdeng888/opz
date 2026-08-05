/**
 * mihomo.js - 管理 zen-mihomo 独立实例
 *
 * 端口:代理 17897 / 控制 19090
 * 与 Clash Verge 完全隔离,不动系统代理。
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const config = require('./config');

const MIXED_PORT = 17897;
const CTRL_PORT = 19090;
const DATA_DIR = config.MIHOMO_DATA_DIR;
const LOG_FILE = path.join(DATA_DIR, 'mihomo-zen.log');
const ERR_FILE = path.join(DATA_DIR, 'mihomo-zen.err.log');
const CONFIG_FILE = config.MIHOMO_CONFIG;
const BUNDLED_MIHOMO_DIR = config.getBundledMihomoDir();

function isRunning() {
  return new Promise((resolve) => {
    const tester = net.createConnection({ port: MIXED_PORT, host: '127.0.0.1' });
    tester.setTimeout(500);
    tester.on('connect', () => { tester.destroy(); resolve(true); });
    tester.on('error', () => resolve(false));
    tester.on('timeout', () => { tester.destroy(); resolve(false); });
  });
}

function getPid() {
  return new Promise((resolve) => {
    const tester = net.createConnection({ port: MIXED_PORT, host: '127.0.0.1' });
    tester.setTimeout(500);
    tester.on('connect', () => {
      // 读取占用进程(简化:返回 PID 通过 lsoq 等价,Windows 上用 netstat)
      tester.destroy();
      resolve(null);  // PID 由外部查
    });
    tester.on('error', () => resolve(null));
    tester.on('timeout', () => { tester.destroy(); resolve(null); });
  });
}

function copyGeoFiles() {
  // 从自带 mihomo 目录复制 geo 文件到数据目录,避免 mihomo 首次启动下载
  const geoFiles = ['Country.mmdb', 'geoip.dat', 'geosite.dat'];
  for (const f of geoFiles) {
    const src = path.join(BUNDLED_MIHOMO_DIR, f);
    const dst = path.join(DATA_DIR, f);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
      }
    } catch {}
  }
}

function start(exePath, logger) {
  return new Promise(async (resolve, reject) => {
    if (await isRunning()) {
      logger('info', '[mihomo] 已在运行');
      return resolve(true);
    }
    if (!fs.existsSync(exePath)) {
      return reject(new Error('找不到 verge-mihomo.exe: ' + exePath));
    }
    if (!fs.existsSync(CONFIG_FILE)) {
      return reject(new Error('找不到 mihomo-zen.yaml,请先刷新订阅'));
    }

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    copyGeoFiles();

    logger('info', '[mihomo] 启动中...');
    const out = fs.openSync(LOG_FILE, 'w');
    const err = fs.openSync(ERR_FILE, 'w');
    const child = spawn(exePath, ['-d', DATA_DIR, '-f', CONFIG_FILE], {
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
    });
    child.unref();

    // 等待端口起来(最长 20 秒,首次加载 geo 慢)
    let waited = 0;
    const timer = setInterval(async () => {
      waited += 500;
      if (await isRunning()) {
        clearInterval(timer);
        logger('ok', `[mihomo] 已启动 (PID ${child.pid})`);
        resolve(true);
      } else if (waited > 20000) {
        clearInterval(timer);
        const errLog = fs.existsSync(ERR_FILE) ? fs.readFileSync(ERR_FILE, 'utf8').slice(-500) : '';
        reject(new Error('mihomo 启动超时\n' + errLog));
      }
    }, 500);
  });
}

function stop(logger) {
  // Windows:通过端口找 PID 然后 kill
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr ":${MIXED_PORT} " ^| findstr "LISTENING"') do taskkill /F /PID %a`, (err) => {
      if (err) {
        logger('warn', '[mihomo] 停止失败(可能未运行): ' + err.message);
      } else {
        logger('ok', '[mihomo] 已停止');
      }
      resolve(true);
    });
  });
}

function getVersion() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: CTRL_PORT, path: '/version', method: 'GET', timeout: 3000,
    }, (resp) => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => { try { resolve(JSON.parse(d).version); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

module.exports = { isRunning, start, stop, getVersion, MIXED_PORT, CTRL_PORT };
