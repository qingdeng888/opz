/**
 * preload.js - 安全的 IPC 桥接
 * 暴露有限的 API 给渲染进程,避免直接 require Node 模块。
 */
const { contextBridge, ipcRenderer } = require('electron');

// 窗口控制(全部走 IPC,由主进程操作 BrowserWindow)
contextBridge.exposeInMainWorld('electron', {
  minimize: () => ipcRenderer.invoke('win-minimize'),
  maximize: () => ipcRenderer.invoke('win-maximize'),
  unmaximize: () => ipcRenderer.invoke('win-unmaximize'),
  toggleMaximize: () => ipcRenderer.invoke('win-toggle-maximize'),
  close: () => ipcRenderer.invoke('win-close'),
  isMaximized: () => ipcRenderer.invoke('win-is-maximized'),
});

// 业务 API
contextBridge.exposeInMainWorld('zen', {
  // 获取配置
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  regenKey: () => ipcRenderer.invoke('regen-key'),
  restartMihomo: () => ipcRenderer.invoke('restart-mihomo'),
  manualReset: () => ipcRenderer.invoke('manual-reset'),
  getCooldowns: () => ipcRenderer.invoke('get-cooldowns'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  resetUsage: () => ipcRenderer.invoke('reset-usage'),

  // 监听日志
  onLog: (cb) => {
    const handler = (e, line) => cb(line);
    ipcRenderer.on('log', handler);
    return () => ipcRenderer.removeListener('log', handler);
  },
  onLogs: (cb) => ipcRenderer.once('logs', (e, arr) => cb(arr)),
  onConfig: (cb) => ipcRenderer.on('config', (e, c) => cb(c)),
});
