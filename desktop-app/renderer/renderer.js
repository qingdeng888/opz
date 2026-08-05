/**
 * renderer.js - 界面逻辑
 */

let logCount = 0;

// ---- 窗口控制(Windows 标准风格,走 IPC)----
document.getElementById('btnMin').onclick = () => window.electron?.minimize();
document.getElementById('btnMax').onclick = async () => {
  const w = window.electron;
  if (!w) return;
  const btn = document.getElementById('btnMax');
  const isMax = await w.toggleMaximize();
  if (isMax) {
    btn.innerHTML = '&#xE923;'; // 还原图标
    btn.title = '还原';
    document.documentElement.classList.add('maximized');
  } else {
    btn.innerHTML = '&#xE922;'; // 最大化图标
    btn.title = '最大化';
    document.documentElement.classList.remove('maximized');
  }
};
document.getElementById('btnClose').onclick = () => window.electron?.close();

// ---- 复制按钮 ----
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.onclick = async () => {
    const target = btn.getAttribute('data-copy');
    const el = document.getElementById(target);
    if (!el) return;
    const text = el.textContent;
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = '已复制 ✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1200);
    } catch (e) {
      // 兜底:选中文字
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };
});

// ---- 状态刷新 ----
async function refreshStatus() {
  const s = await window.zen.getStatus();
  const port = s.gatewayPort;

  // URL/Key
  document.getElementById('urlValue').textContent = port ? `http://127.0.0.1:${port}/v1` : 'http://127.0.0.1:—/v1';
  document.getElementById('keyValue').textContent = s.apiKey || '—';
  document.getElementById('usageUrl').textContent = port ? `http://127.0.0.1:${port}/v1` : 'http://127.0.0.1:—/v1';
  document.getElementById('usageCurl').textContent =
    `curl http://127.0.0.1:${port || '—'}/v1/chat/completions \\
  -H "Authorization: Bearer ${s.apiKey || '—'}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}]}'`;

  // mihomo
  const mhEl = document.getElementById('mhStatus');
  if (s.mihomoRunning) {
    mhEl.textContent = '运行中';
    mhEl.className = 'value ok';
  } else {
    mhEl.textContent = '未运行';
    mhEl.className = 'value err';
  }
  document.getElementById('mhVersion').textContent = s.mihomoVersion || '—';

  // gateway
  const dotMh = document.getElementById('dotMh');
  const dotGw = document.getElementById('dotGw');
  dotMh.className = 'dot ' + (s.mihomoRunning ? '' : 'off');
  dotGw.className = 'dot ' + (s.gatewayRunning ? '' : 'off');
  document.getElementById('sbPort').textContent = 'port: ' + (port || '—');

  document.getElementById('topStatus').textContent =
    (s.mihomoRunning ? 'mihomo✓' : 'mihomo✗') + ' · ' +
    (s.gatewayRunning ? 'gateway✓' : 'gateway✗');
}

// ---- 加载配置到表单 ----
async function loadConfigForm() {
  const cfg = await window.zen.getConfig();
  document.getElementById('cfgSub').value = cfg.subscriptionUrl || '';
  document.getElementById('cfgKey').value = cfg.apiKey || '';
  document.getElementById('cfgExe').value = cfg.mihomoExe || '';
  document.getElementById('cfgPort').value = cfg.port || 0;
}

// ---- 保存配置 ----
document.getElementById('btnSave').onclick = async () => {
  const btn = document.getElementById('btnSave');
  btn.textContent = '保存中...';
  btn.disabled = true;
  try {
    const newCfg = {
      subscriptionUrl: document.getElementById('cfgSub').value.trim(),
      apiKey: document.getElementById('cfgKey').value.trim(),
      mihomoExe: document.getElementById('cfgExe').value.trim(),
      port: parseInt(document.getElementById('cfgPort').value) || 0,
    };
    await window.zen.saveConfig(newCfg);
    btn.textContent = '已保存 ✓';
    setTimeout(() => { btn.textContent = '保存并应用'; btn.disabled = false; }, 1500);
    await refreshStatus();
  } catch (e) {
    btn.textContent = '保存失败';
    setTimeout(() => { btn.textContent = '保存并应用'; btn.disabled = false; }, 2000);
  }
};

// ---- 重新生成 Key ----
document.getElementById('btnGenKey').onclick = async () => {
  const key = await window.zen.regenKey();
  document.getElementById('cfgKey').value = key;
  await refreshStatus();
};

// ---- 重启 mihomo ----
document.getElementById('btnRestartMh').onclick = async () => {
  const btn = document.getElementById('btnRestartMh');
  btn.textContent = '重启中...';
  btn.disabled = true;
  try {
    await window.zen.restartMihomo();
    btn.textContent = '已重启 ✓';
  } catch (e) {
    btn.textContent = '失败';
  }
  setTimeout(() => { btn.textContent = '重启 mihomo'; btn.disabled = false; }, 1500);
  await refreshStatus();
};

document.getElementById('btnRefreshStatus').onclick = refreshStatus;

// ---- 用量统计 ----
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n || 0);
}

async function refreshUsage() {
  try {
    const u = await window.zen.getUsage();
    if (!u) return;

    // 总览卡片
    const t = u.total;
    document.getElementById('stRequests').textContent = fmt(t.requests);
    document.getElementById('stReqSub').textContent = `${t.success} 成功 / ${t.fail} 失败`;
    document.getElementById('stTotalTokens').textContent = fmt(t.totalTokens);
    document.getElementById('stPromptTokens').textContent = fmt(t.promptTokens);
    document.getElementById('stReasoningTokens').textContent = fmt(t.reasoningTokens);
    document.getElementById('stTokenSub').textContent = `输出 ${fmt(t.completionTokens)}`;
    document.getElementById('stReasonSub').textContent = `占总 ${t.totalTokens ? ((t.reasoningTokens / t.totalTokens) * 100).toFixed(0) : 0}%`;

    // 每日明细表(最近 7 天,倒序)
    const days = Object.keys(u.byDay || {}).sort().reverse().slice(0, 7);
    const tbody = document.getElementById('stDayBody');
    if (days.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="stats-empty">暂无数据,发个请求试试</td></tr>';
    } else {
      tbody.innerHTML = days.map(d => {
        const r = u.byDay[d];
        return `<tr>
          <td>${d}</td>
          <td class="num">${r.requests}</td>
          <td class="num" style="color:var(--accent)">${r.success}</td>
          <td class="num" style="color:var(--danger)">${r.fail}</td>
          <td class="num">${fmt(r.promptTokens)}</td>
          <td class="num">${fmt(r.completionTokens)}</td>
          <td class="num" style="color:var(--warn)">${fmt(r.reasoningTokens)}</td>
          <td class="num" style="color:var(--info)">${fmt(r.totalTokens)}</td>
        </tr>`;
      }).join('');
    }

    // 底部状态栏也显示简要
    document.getElementById('sbStats').textContent = `请求 ${t.requests} · Token ${fmt(t.totalTokens)}`;
  } catch (e) {
    // 静默失败
  }
}

document.getElementById('btnResetUsage').onclick = async () => {
  const btn = document.getElementById('btnResetUsage');
  btn.textContent = '清零中...';
  btn.disabled = true;
  try {
    await window.zen.resetUsage();
    btn.textContent = '已清零 ✓';
    await refreshUsage();
  } catch (e) {
    btn.textContent = '失败';
  }
  setTimeout(() => { btn.textContent = '清零统计'; btn.disabled = false; }, 1500);
};

// ---- 手动重置(标题栏按钮)----
async function doManualReset(btnEl) {
  const btn = btnEl || document.getElementById('btnReset');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '↻ 重置中...';
  try {
    await window.zen.manualReset();
    btn.innerHTML = '✓ 已重置';
  } catch (e) {
    btn.innerHTML = '✗ 失败';
  }
  setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
  await refreshStatus();
  await refreshCooldowns();
}
document.getElementById('btnReset').onclick = function() { doManualReset(this); };

// ---- 冷却节点刷新 ----
async function refreshCooldowns() {
  try {
    const cds = await window.zen.getCooldowns();
    const badge = document.getElementById('cdBadge');
    if (cds.length === 0) {
      badge.textContent = '冷却: 0';
      badge.className = 'cooldown-badge zero';
      badge.title = '无节点冷却,全部可用';
    } else {
      badge.textContent = `冷却: ${cds.length}`;
      badge.className = 'cooldown-badge';
      const list = cds.map(c => `${c.node.slice(0,20)}... (${c.remain}s)`).join('\n');
      badge.title = list;
    }
  } catch {}
}

// ---- 日志 ----
function appendLog(line) {
  const list = document.getElementById('logList');
  const item = document.createElement('div');
  item.className = 'log-item';
  const t = new Date(line.ts);
  const ts = String(t.getHours()).padStart(2,'0') + ':' +
             String(t.getMinutes()).padStart(2,'0') + ':' +
             String(t.getSeconds()).padStart(2,'0');
  const level = line.level || 'info';
  item.innerHTML =
    `<span class="log-time">${ts}</span>` +
    `<span class="log-level ${level}">${level.toUpperCase()}</span>` +
    `<span class="log-msg">${esc(line.msg)}</span>`;
  list.appendChild(item);
  // 限制最多 500 条
  while (list.children.length > 500) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
  logCount++;
  document.getElementById('logCount').textContent = logCount;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---- 监听 ----
window.zen.onLog(appendLog);
window.zen.onLogs((arr) => {
  arr.forEach(appendLog);
  refreshStatus();
});
window.zen.onConfig((cfg) => {
  // 配置变了,刷新表单和状态
  loadConfigForm();
  refreshStatus();
});

// ---- 初始化 ----
(async () => {
  await loadConfigForm();
  await refreshStatus();
  await refreshCooldowns();
  await refreshUsage();
  // 每 5 秒刷新状态 + 冷却
  setInterval(refreshStatus, 5000);
  setInterval(refreshCooldowns, 2000);  // 冷却倒计时更新快一点
  setInterval(refreshUsage, 5000);      // 用量统计 5 秒刷新
})();
