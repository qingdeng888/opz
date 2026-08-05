/**
 * main.js - Electron 主进程
 *
 * 职责:
 *   1. 创建窗口
 *   2. 管理 mihomo 实例生命周期
 *   3. 启动本地 OpenAI 兼容网关
 *   4. IPC:向渲染进程广播日志/状态,接收配置变更
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { Gateway, FIXED_MODEL } = require('./gateway');
const mihomo = require('./mihomo');
const config = require('./config');

let win = null;
let gateway = null;
let logBuffer = [];      // 最近的日志(供渲染进程初始化时拉取)
const MAX_LOG = 500;

function log(level, msg) {
  const line = { ts: new Date().toISOString(), level, msg };
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG) logBuffer.shift();
  if (win && !win.isDestroyed()) {
    win.webContents.send('log', line);
  }
  console.log(`[${level}] ${msg}`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    title: 'Zen Free Gateway',
    backgroundColor: '#0f1115',
    frame: false,           // 去掉原生标题栏
    autoHideMenuBar: true,  // 隐藏菜单栏
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 彻底移除菜单栏(连 Alt 键都调不出来)
  win.setMenuBarVisibility(false);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // DevTools:默认不自动打开(即使 --dev 也不弹),需要时按 F12 手动切换

  win.on('closed', () => { win = null; });
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
  gateway = new Gateway({ apiKey: cfg.apiKey, port: cfg.port, USAGE_FILE: config.USAGE_FILE }, log);
  const port = await gateway.start();
  // 实际端口(可能因占用而递增)保存到配置,保证下次启动一致
  if (port !== cfg.port) {
    cfg.port = port;
    config.save(cfg);
    log('info', `[config] 端口已保存为 ${port}`);
  }
  return port;
}

async function bootstrap() {
  let cfg = config.load();
  // 首次运行自动生成 API Key
  if (!cfg.apiKey) {
    cfg.apiKey = config.genApiKey();
    config.save(cfg);
    log('info', `[init] 生成 API Key: ${cfg.apiKey}`);
  }

  // 数据目录
  try {
    require('fs').mkdirSync(config.MIHOMO_DATA_DIR, { recursive: true });
  } catch {}

  // 如果有订阅 URL,确保 mihomo 配置是最新的
  if (cfg.subscriptionUrl) {
    try {
      log('info', '[sub] 刷新订阅...');
      const r = await config.refreshMihomoConfig(cfg.subscriptionUrl);
      log('ok', `[sub] 已刷新,${r.nodeCount} 个节点`);
    } catch (e) {
      log('error', '[sub] 刷新失败: ' + e.message);
    }
  } else if (!fs.existsSync(config.MIHOMO_CONFIG)) {
    // 无订阅 URL 且没有配置文件时,用内置 mihomo-zen.yaml(带默认节点)兜底
    const bundled = path.join(config.getBundledMihomoDir(), 'mihomo-zen.yaml');
    try {
      if (fs.existsSync(bundled)) {
        fs.copyFileSync(bundled, config.MIHOMO_CONFIG);
        log('ok', '[sub] 使用内置 mihomo 配置(可在设置里填订阅 URL 更新节点)');
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

  try {
    const port = await startGateway(cfg);
    log('ok', `[gateway] 已启动: http://127.0.0.1:${port}`);
    log('ok', `[gateway] URL: http://127.0.0.1:${port}/v1`);
    log('ok', `[gateway] Key: ${cfg.apiKey}`);
    log('ok', `[gateway] Model: ${FIXED_MODEL} (固定)`);
  } catch (e) {
    log('error', '[gateway] 启动失败: ' + e.message);
  }

  // 通知渲染进程当前配置
  if (win) {
    win.webContents.send('config', cfg);
    win.webContents.send('logs', logBuffer);
  }
}

// ---- IPC ----

// 窗口控制(由主进程操作 BrowserWindow,渲染进程不能直接 require)
ipcMain.handle('win-minimize', () => { if (win) win.minimize(); });
ipcMain.handle('win-maximize', () => { if (win) win.maximize(); });
ipcMain.handle('win-unmaximize', () => { if (win) win.unmaximize(); });
ipcMain.handle('win-toggle-maximize', () => {
  if (!win) return false;
  if (win.isMaximized()) { win.unmaximize(); return false; }
  win.maximize(); return true;
});
ipcMain.handle('win-is-maximized', () => win ? win.isMaximized() : false);
ipcMain.handle('win-close', () => { if (win) win.close(); });

ipcMain.handle('get-config', () => config.load());

ipcMain.handle('save-config', async (e, newCfg) => {
  const old = config.load();
  const merged = { ...old, ...newCfg };
  config.save(merged);
  log('info', '[config] 已保存');

  // 如果订阅 URL 变了,刷新 mihomo 配置
  if (newCfg.subscriptionUrl && newCfg.subscriptionUrl !== old.subscriptionUrl) {
    try {
      log('info', '[sub] 订阅变更,刷新中...');
      const r = await config.refreshMihomoConfig(newCfg.subscriptionUrl);
      log('ok', `[sub] 刷新成功,${r.nodeCount} 个节点`);
      // 重启 mihomo 让新配置生效
      log('info', '[mihomo] 重启以加载新配置...');
      if (gateway) gateway.pause();
      await mihomo.stop(log);
      await sleep(800);
      await ensureMihomo(merged);
      if (gateway) gateway.resume();
    } catch (e) {
      log('error', '[sub] 刷新失败: ' + e.message);
      if (gateway) gateway.resume();
    }
  }

  // 如果 API Key 变了,重启网关
  if (newCfg.apiKey && newCfg.apiKey !== old.apiKey) {
    log('info', '[gateway] Key 变更,重启...');
    const port = await startGateway(merged);
    log('ok', `[gateway] 新端口: ${port}`);
  }

  if (win) win.webContents.send('config', merged);
  return merged;
});

ipcMain.handle('regen-key', async () => {
  const cfg = config.load();
  cfg.apiKey = config.genApiKey();
  config.save(cfg);
  log('info', `[config] 新 Key: ${cfg.apiKey}`);
  const port = await startGateway(cfg);
  log('ok', `[gateway] 已用新 Key 重启,端口 ${port}`);
  if (win) win.webContents.send('config', cfg);
  return cfg.apiKey;
});

ipcMain.handle('restart-mihomo', async () => {
  const cfg = config.load();
  log('info', '[mihomo] 手动重启...');
  if (gateway) gateway.pause();
  await mihomo.stop(log);
  await sleep(800);
  await ensureMihomo(cfg);
  if (gateway) gateway.resume();
  return true;
});

// 手动重置:清空所有节点冷却 + 重新拉订阅 + 重启 mihomo + 重置锁定节点
// 用途:用户觉得当前节点都卡了,主动重置一次,重新开始
ipcMain.handle('manual-reset', async () => {
  log('warn', '===== 手动重置开始 =====');
  const cfg = config.load();

  // 0. 暂停 gateway:重置期间 mihomo 会重启,代理不可用,暂停接收请求避免断联
  if (gateway) {
    gateway.pause();
    log('info', '[reset] gateway 已暂停,重置期间请求返回 503');
  }

  // 1. 清空网关的节点冷却和锁定
  if (gateway) {
    const n = gateway.resetCooldowns();
    log('ok', `[reset] 清空 ${n} 个冷却记录`);
  }

  // 2. 重新拉订阅(获取最新节点列表)
  if (cfg.subscriptionUrl) {
    try {
      log('info', '[reset] 重新拉取订阅...');
      const r = await config.refreshMihomoConfig(cfg.subscriptionUrl);
      log('ok', `[reset] 订阅刷新,${r.nodeCount} 个节点`);
    } catch (e) {
      log('error', '[reset] 订阅刷新失败: ' + e.message);
    }
  }

  // 3. 重启 mihomo 加载新配置
  try {
    log('info', '[reset] 重启 mihomo...');
    await mihomo.stop(log);
    await sleep(800);
    await ensureMihomo(cfg);
  } catch (e) {
    log('error', '[reset] mihomo 重启失败: ' + e.message);
  }

  // 4. 删除 last-node 记录,避免恢复到旧节点
  const lastNodeFile = config.LAST_NODE_FILE;
  try {
    if (fs.existsSync(lastNodeFile)) fs.unlinkSync(lastNodeFile);
    log('ok', '[reset] 已清除上次节点记录');
  } catch {}

  // 5. 恢复 gateway:mihomo 已就绪,重新接收请求
  if (gateway) {
    gateway.resume();
    log('ok', '[reset] gateway 已恢复');
  }

  log('ok', '===== 手动重置完成 =====');
  return true;
});

// 获取当前节点冷却状态(供界面显示)
ipcMain.handle('get-cooldowns', async () => {
  if (!gateway) return [];
  return gateway.cooldown.summary();
});

ipcMain.handle('get-status', async () => {
  const cfg = config.load();
  const running = await mihomo.isRunning();
  const version = running ? await mihomo.getVersion() : null;
  return {
    mihomoRunning: running,
    mihomoVersion: version,
    gatewayPort: gateway ? gateway.config.port : null,
    gatewayRunning: !!gateway,
    apiKey: cfg.apiKey,
    subscriptionUrl: cfg.subscriptionUrl,
    fixedModel: FIXED_MODEL,
  };
});

ipcMain.handle('get-usage', () => {
  if (!gateway) return null;
  return gateway.getUsage();
});

ipcMain.handle('reset-usage', () => {
  if (!gateway) return false;
  gateway.resetUsage();
  return true;
});

app.whenReady().then(async () => {
  createWindow();
  await bootstrap();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (gateway) gateway.stop();
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (gateway) { await gateway.stop(); gateway = null; }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
