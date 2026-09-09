/**
 * ui.js - 内嵌 Web 管理面板(单 HTML,无外部资源/CDN)
 *
 * module.exports 是一个完整的 HTML 字符串,由 gateway 的 GET / 返回。
 * 配色与旧 prototype.html 保持一致,深色主题。
 */

module.exports = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zen Free Gateway 管理面板</title>
<style>
:root {
  --bg-deep: #0f1115;
  --bg-main: #161a21;
  --bg-panel: #1c2129;
  --bg-input: #222834;
  --border: #2a3140;
  --text-main: #e6e8ec;
  --text-dim: #8b94a5;
  --accent: #4ade80;
  --accent-dim: #16a34a;
  --danger: #f87171;
  --danger-dim: #dc2626;
  --info: #60a5fa;
  --info-dim: #2563eb;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg-deep);
  color: var(--text-main);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  min-height: 100vh;
}
.app { max-width: 760px; margin: 0 auto; padding: 32px 20px 60px; }
h1 { font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
h1 .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); display: inline-block; }
h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: var(--text-main); }
.sub { color: var(--text-dim); font-size: 12px; margin-top: 4px; }
.card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  margin-top: 20px;
}
.row { display: flex; gap: 12px; flex-wrap: wrap; }
.field { flex: 1; min-width: 150px; margin-bottom: 14px; }
.field.full { flex: 1 1 100%; }
label { display: block; color: var(--text-dim); font-size: 12px; margin-bottom: 6px; }
input, select {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  color: var(--text-main);
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 13px;
  outline: none;
}
input:focus, select:focus, textarea:focus { border-color: var(--info); }
input::placeholder { color: #4a5368; }
textarea {
  width: 100%;
  background: var(--bg-input);
  border: 1px solid var(--border);
  color: var(--text-main);
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace;
  line-height: 1.6;
  outline: none;
  resize: vertical;
}
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: none; border-radius: 8px; padding: 9px 18px;
  font-size: 13px; font-weight: 500; cursor: pointer; transition: opacity .15s;
}
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn-primary { background: var(--accent); color: #0b120d; }
.btn-primary:hover:not(:disabled) { opacity: .85; }
.btn-ghost { background: var(--bg-input); color: var(--text-main); border: 1px solid var(--border); }
.btn-ghost:hover:not(:disabled) { background: #283040; }
.btn-sm { padding: 5px 12px; font-size: 12px; }

/* 登录 */
.login-wrap { max-width: 360px; margin: 18vh auto 0; text-align: center; }
.login-wrap .card { text-align: left; }
.login-wrap .logo { width: 44px; height: 44px; border-radius: 12px; background: var(--bg-input); border: 1px solid var(--border); display: inline-flex; align-items: center; justify-content: center; font-size: 22px; margin-bottom: 16px; }
.login-hint { color: var(--text-dim); font-size: 12px; margin: 10px 0 0; text-align: center; }
.err { color: var(--danger); font-size: 12px; margin-top: 10px; min-height: 16px; }
.ok { color: var(--accent); font-size: 12px; margin-top: 10px; min-height: 16px; }

/* 状态徽标 */
.badges { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.badge {
  background: var(--bg-input); border: 1px solid var(--border); color: var(--text-dim);
  padding: 5px 12px; border-radius: 999px; font-size: 12px;
}
.badge b { color: var(--text-main); font-weight: 600; }
.badge.green b { color: var(--accent); }
.badge.blue b { color: var(--info); }

/* 状态统计 */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.stat { background: var(--bg-input); border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
.stat .n { font-size: 20px; font-weight: 600; }
.stat .l { color: var(--text-dim); font-size: 11px; margin-top: 2px; }

/* 模型 chip */
.model-list { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.model-chip {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--bg-input); border: 1px solid var(--border);
  color: var(--text-main); border-radius: 999px; padding: 4px 10px; font-size: 12px;
}
.model-chip .del { cursor: pointer; color: var(--text-dim); font-size: 14px; line-height: 1; padding-left: 4px; }
.model-chip .del:hover { color: var(--danger); }

.actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
.msg { font-size: 12px; margin-top: 12px; min-height: 16px; }
.msg.err { color: var(--danger); }
.msg.ok { color: var(--accent); }
.divider { height: 1px; background: var(--border); margin: 16px 0; }
code { background: var(--bg-input); border: 1px solid var(--border); padding: 1px 6px; border-radius: 5px; font-size: 12px; color: var(--info); }

/* 模型回复展示 */
.reply-box {
  background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px;
  padding: 12px; font-size: 13px; line-height: 1.7; color: var(--text-main);
  white-space: pre-wrap; word-break: break-word;
  max-height: 320px; overflow-y: auto; margin-top: 6px;
}
.reply-box:empty::before { content: '(等待测试)'; color: var(--text-dim); }
</style>
</head>
<body>
<!-- 登录视图 -->
<div id="view-login" class="login-wrap">
  <div class="logo">🛡️</div>
  <h1 style="justify-content:center;">Zen Free Gateway</h1>
  <div class="sub" style="margin-bottom:8px;">管理面板</div>
  <div class="card">
    <div class="field full" style="margin-bottom:6px;">
      <label for="login-password">管理密码</label>
      <input id="login-password" type="password" placeholder="输入管理密码" autocomplete="current-password">
    </div>
    <button id="btn-login" class="btn btn-primary" style="width:100%;">登录</button>
    <div class="err" id="login-err"></div>
    <p class="login-hint">密码在启动横幅 / data/info.txt 中查看</p>
  </div>
</div>

<!-- 主视图 -->
<div id="view-main" class="app" style="display:none;">
  <h1><span class="dot"></span> Zen Free Gateway</h1>
  <div class="sub">管理面板 · 代理与密钥设置</div>

  <div class="card">
    <h2>运行状态</h2>
    <div class="badges">
      <span class="badge green">代理 <b id="st-proxy">-</b></span>
      <span class="badge blue">模型 <b id="st-model">-</b></span>
      <span class="badge">运行时长 <b id="st-uptime">-</b></span>
      <span class="badge">端口 <b id="st-port">-</b></span>
    </div>
    <div class="divider"></div>
    <div class="stats">
      <div class="stat"><div class="n" id="st-requests">-</div><div class="l">请求总数</div></div>
      <div class="stat"><div class="n" id="st-success">-</div><div class="l">成功</div></div>
      <div class="stat"><div class="n" id="st-fail">-</div><div class="l">失败</div></div>
      <div class="stat"><div class="n" id="st-tokens">-</div><div class="l">Token 总数</div></div>
    </div>
  </div>

  <div class="card">
    <h2>API Key</h2>
    <div class="field full">
      <label for="f-apikey">对外 API Key(接入 AI 工具时使用)</label>
      <input id="f-apikey" type="text" placeholder="zen-xxxx">
    </div>
    <div class="msg" id="msg-apikey"></div>
  </div>

  <div class="card">
    <h2>上游 API Key</h2>
    <div class="sub">opencode.ai 的 API Key(sk-xxx),网关转发时携带;留空则不带认证(免费模型需此 Key + 会话 ID)</div>
    <div class="field full">
      <label for="f-upstreamkey">上游 Key(sk-xxx)</label>
      <input id="f-upstreamkey" type="password" placeholder="sk-xxxx,留空则不携带认证" autocomplete="off">
    </div>
    <div class="msg" id="msg-upstreamkey"></div>
  </div>

  <div class="card">
    <h2>免费模型</h2>
    <div class="sub">OpenCode 免费模型会变动,在此增删;保存后即时热加载,无需重启</div>
    <div style="height:12px;"></div>
    <div id="model-list" class="model-list"></div>
    <div class="row" style="align-items:center;">
      <div class="field" style="margin-bottom:0;">
        <input id="f-model-add" type="text" placeholder="输入模型 ID,回车添加,如 hy3-free">
      </div>
      <button id="btn-model-add" class="btn btn-ghost btn-sm" style="height:36px;">添加</button>
    </div>
    <div class="msg" id="msg-models"></div>
  </div>

  <div class="card">
    <h2>代理设置</h2>
    <div class="sub">向 opencode 的请求将通过所选方式出站;未配置代理时使用直连</div>
    <div style="height:12px;"></div>
    <div class="field">
      <label for="f-proxy-type">出站方式</label>
      <select id="f-proxy-type">
        <option value="none">直连</option>
        <option value="http">HTTP 代理</option>
        <option value="socks5">SOCKS5 代理</option>
        <option value="http_pool">HTTP 代理池</option>
        <option value="socks5_pool">SOCKS5 代理池</option>
      </select>
    </div>
    <div id="proxy-fields" style="display:none;">
      <div class="row">
        <div class="field">
          <label for="f-proxy-host">代理 Host</label>
          <input id="f-proxy-host" type="text" placeholder="127.0.0.1">
        </div>
        <div class="field">
          <label for="f-proxy-port">代理端口</label>
          <input id="f-proxy-port" type="number" placeholder="7890" min="1" max="65535">
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label for="f-proxy-user">用户名(可选)</label>
          <input id="f-proxy-user" type="text" placeholder="留空则不认证">
        </div>
        <div class="field">
          <label for="f-proxy-pass">密码(可选)</label>
          <input id="f-proxy-pass" type="password" placeholder="********">
        </div>
      </div>
    </div>
    <div id="pool-fields" style="display:none;">
      <div class="field full">
        <label for="f-pool-lines">代理列表(每行一个,保存后自动随机抽取)</label>
        <textarea id="f-pool-lines" rows="8" placeholder="http://user:password@ip:port&#10;socks5://user:password@ip:port&#10;http://ip:port"></textarea>
      </div>
      <div class="sub">每行一个代理,支持 <code>http://</code> 或 <code>socks5://</code> 前缀,可带 <code>user:password@</code>;无效行自动忽略</div>
    </div>
    <div class="msg" id="msg-proxy"></div>
  </div>

  <div class="card">
    <h2>API 连通性测试</h2>
    <div class="sub">基础连通只探测网络通路;模型对话会真实向上游发一条消息,验证所选模型能否作答</div>
    <div style="height:12px;"></div>
    <div class="row">
      <div class="field">
        <label for="f-test-type">测试类型</label>
        <select id="f-test-type">
          <option value="connect">基础连通性(探测上游接口)</option>
          <option value="model">上游模型对话(真实请求)</option>
        </select>
      </div>
      <div class="field" id="test-model-field" style="display:none;">
        <label for="f-test-model">测试模型</label>
        <select id="f-test-model"></select>
      </div>
    </div>
    <div id="test-msg-field" style="display:none;">
      <div class="field full">
        <label for="f-test-message">测试消息(可自定义,默认:你是谁，出来干活了)</label>
        <textarea id="f-test-message" rows="2"></textarea>
      </div>
      <div class="actions" style="margin-top:0;">
        <button id="btn-test-reset" class="btn btn-ghost btn-sm">恢复默认消息</button>
      </div>
    </div>
    <div class="actions">
      <button id="btn-test" class="btn btn-primary">开始测试</button>
    </div>
    <div class="msg" id="msg-test"></div>
    <div id="test-reply-field" style="display:none;">
      <label for="test-reply">模型回复</label>
      <div class="reply-box" id="test-reply"></div>
    </div>
  </div>

  <div class="card">
    <h2>管理密码</h2>
    <div class="sub">留空或填 ******** 表示保持当前密码不变</div>
    <div class="field" style="margin-top:12px;">
      <input id="f-adminpass" type="password" placeholder="输入新密码以修改">
    </div>
    <div class="msg" id="msg-adminpass"></div>
  </div>

  <div class="actions">
    <button id="btn-save" class="btn btn-primary">保存设置</button>
    <button id="btn-refresh" class="btn btn-ghost">刷新状态</button>
    <button id="btn-logout" class="btn btn-ghost">退出登录</button>
  </div>
  <div class="msg" id="msg-global"></div>
</div>

<script>
(function () {
  var TOKEN_KEY = 'zen_gw_token';
  var DEFAULT_TEST_MESSAGE = '你是谁，出来干活了';
  var state = { config: null, stats: null, freeModels: [] };

  function el(id) { return document.getElementById(id); }
  function show(id, on) { el(id).style.display = on ? '' : 'none'; }

  function token() { return sessionStorage.getItem(TOKEN_KEY) || ''; }
  function setToken(t) { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['Content-Type'] = 'application/json';
    if (token()) opts.headers['X-Auth-Token'] = token();
    opts.method = opts.method || 'GET';
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok && r.status === 401 && path !== '/api/login') {
          // token 失效,回登录
          logout();
          throw new Error('会话已过期,请重新登录');
        }
        if (!r.ok) throw new Error(j.error && j.error.message ? j.error.message : ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function fmtMs(ms) {
    if (!ms && ms !== 0) return '-';
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    var h = Math.floor(s / 3600);
    return h + ' 时 ' + Math.floor((s % 3600) / 60) + ' 分';
  }

  // ---- 登录 ----
  function doLogin() {
    var pass = el('login-password').value;
    el('login-err').textContent = '';
    api('/api/login', { method: 'POST', body: { password: pass } }).then(function (j) {
      setToken(j.token);
      enterMain();
    }).catch(function (e) { el('login-err').textContent = e.message || '登录失败'; });
  }
  el('btn-login').addEventListener('click', doLogin);
  el('login-password').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

  function enterMain() {
    show('view-login', false);
    show('view-main', true);
    loadAll();
  }
  function logout() {
    setToken('');
    show('view-main', false);
    show('view-login', true);
    el('login-password').value = '';
  }
  el('btn-logout').addEventListener('click', function () { logout(); });

  // ---- 加载 ----
  function loadAll() {
    loadConfig();
    loadStats();
  }
  function loadConfig() {
    return api('/api/config').then(function (j) {
      state.config = j;
      el('f-apikey').value = j.apiKey || '';
      el('f-proxy-type').value = j.proxy.type || 'none';
      el('f-proxy-host').value = j.proxy.host || '';
      el('f-proxy-port').value = j.proxy.port || '';
      el('f-proxy-user').value = j.proxy.username || '';
      el('f-proxy-pass').value = j.proxy.password ? '********' : '';
      el('f-pool-lines').value = (j.proxy.pool || []).map(poolLine).join('\\n');
      el('f-adminpass').value = '';
      el('f-upstreamkey').value = j.upstreamKey || '';
      el('st-port').textContent = j.port;
      state.freeModels = (j.freeModels || []).slice();
      renderModels();
      renderTestModels();
      toggleProxyFields();
    }).catch(function (e) { el('msg-global').textContent = '加载配置失败: ' + e.message; });
  }
  function loadStats() {
    return api('/api/stats').then(function (j) {
      state.stats = j;
      el('st-proxy').textContent = j.proxy || '-';
      el('st-model').textContent = j.model || '-';
      el('st-uptime').textContent = fmtMs(j.uptime);
      el('st-port').textContent = j.port;
      var u = j.usage && j.usage.total;
      el('st-requests').textContent = u ? u.requests : '-';
      el('st-success').textContent = u ? u.success : '-';
      el('st-fail').textContent = u ? u.fail : '-';
      el('st-tokens').textContent = u ? u.totalTokens : '-';
    }).catch(function () { /* 状态区失败不阻塞 */ });
  }

  // ---- 代理字段显隐 ----
  function isPoolType(v) { return v === 'http_pool' || v === 'socks5_pool'; }
  function toggleProxyFields() {
    var v = el('f-proxy-type').value;
    show('proxy-fields', v === 'http' || v === 'socks5');
    show('pool-fields', isPoolType(v));
  }
  el('f-proxy-type').addEventListener('change', toggleProxyFields);

  // 结构化池条目 -> 单行文本(密码回显脱敏 '********')
  function poolLine(e) {
    var cred = e.username ? (e.username + (e.password ? ':' + e.password : '') + '@') : '';
    return e.type + '://' + cred + e.host + ':' + e.port;
  }

  // ---- 免费模型编辑(本地暂存,保存时一并提交)----
  function renderModels() {
    var box = el('model-list');
    box.innerHTML = '';
    if (!state.freeModels.length) {
      var empty = document.createElement('span');
      empty.className = 'sub';
      empty.style.margin = '0';
      empty.textContent = '(空列表将回退到内置默认模型)';
      box.appendChild(empty);
      return;
    }
    state.freeModels.forEach(function (id) {
      var chip = document.createElement('span');
      chip.className = 'model-chip';
      chip.textContent = id;
      var del = document.createElement('span');
      del.className = 'del';
      del.textContent = '×';
      del.title = '移除 ' + id;
      del.addEventListener('click', function () {
        state.freeModels = state.freeModels.filter(function (m) { return m !== id; });
        renderModels();
        el('msg-models').textContent = '已移除 ' + id + '(保存后生效)';
      });
      chip.appendChild(del);
      box.appendChild(chip);
    });
  }
  function addModel() {
    var inp = el('f-model-add');
    var id = inp.value.trim();
    if (!id) return;
    if (state.freeModels.indexOf(id) >= 0) { el('msg-models').textContent = '已存在: ' + id; return; }
    state.freeModels.push(id);
    inp.value = '';
    renderModels();
    el('msg-models').textContent = '已添加 ' + id + '(保存后生效)';
  }
  el('btn-model-add').addEventListener('click', addModel);
  el('f-model-add').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addModel(); }
  });

  // ---- 保存 ----
  el('btn-save').addEventListener('click', function () {
    var type = el('f-proxy-type').value;
    var proxy = {
      type: type,
      host: el('f-proxy-host').value.trim(),
      port: parseInt(el('f-proxy-port').value) || 0,
      username: el('f-proxy-user').value,
      password: el('f-proxy-pass').value,
      pool: el('f-pool-lines').value.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean)
    };
    var payload = {
      apiKey: el('f-apikey').value.trim(),
      proxy: proxy,
      freeModels: state.freeModels,
      upstreamKey: el('f-upstreamkey').value
    };
    var adminPass = el('f-adminpass').value;
    if (adminPass) payload.adminPassword = adminPass; // 空/****** 保持原值

    el('msg-global').textContent = '';
    el('msg-apikey').textContent = '';
    el('msg-proxy').textContent = '';
    el('msg-adminpass').textContent = '';
    el('msg-models').textContent = '';
    el('msg-upstreamkey').textContent = '';
    el('btn-save').disabled = true;
    api('/api/config', { method: 'PUT', body: payload }).then(function (j) {
      var where = type === 'none' ? 'msg-apikey' : 'msg-proxy';
      if (type === 'none') el('msg-apikey').textContent = j.message || '已保存';
      else el('msg-proxy').textContent = j.message || '已保存';
      if (payload.adminPassword) el('msg-adminpass').textContent = '管理密码已更新';
      if (payload.upstreamKey) el('msg-upstreamkey').textContent = '上游 Key 已更新';
      el('msg-models').textContent = '免费模型已同步 ' + j.config.freeModels.length + ' 个';
      return loadAll();
    }).catch(function (e) {
      el('msg-global').textContent = '保存失败: ' + e.message;
    }).finally(function () {
      el('btn-save').disabled = false;
    });
  });

  // ---- API 连通性测试 ----
  // 测试模型下拉:跟随实际生效的免费模型白名单,重载后保留用户已选项
  function renderTestModels() {
    var sel = el('f-test-model');
    var prev = sel.value;
    sel.innerHTML = '';
    state.freeModels.forEach(function (id) {
      var opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      sel.appendChild(opt);
    });
    if (prev && state.freeModels.indexOf(prev) >= 0) sel.value = prev;
  }

  // 仅「模型对话」模式需要选择模型与填写消息
  function toggleTestFields() {
    var isModel = el('f-test-type').value === 'model';
    show('test-model-field', isModel);
    show('test-msg-field', isModel);
    if (!isModel) show('test-reply-field', false);
  }
  el('f-test-type').addEventListener('change', toggleTestFields);

  el('btn-test-reset').addEventListener('click', function () {
    el('f-test-message').value = DEFAULT_TEST_MESSAGE;
    el('msg-test').textContent = '已恢复默认测试消息';
    el('msg-test').className = 'msg';
  });

  el('btn-test').addEventListener('click', function () {
    var btn = el('btn-test');
    var type = el('f-test-type').value;
    var msgEl = el('msg-test');
    var payload = { type: type };
    if (type === 'model') {
      payload.model = el('f-test-model').value;
      var custom = el('f-test-message').value.trim();
      if (custom) payload.message = custom; // 留空则由服务端回退默认消息
    }

    btn.disabled = true;
    btn.textContent = '测试中...';
    msgEl.textContent = '';
    msgEl.className = 'msg';
    show('test-reply-field', false);
    el('test-reply').textContent = '';

    api('/api/test', { method: 'POST', body: payload }).then(function (j) {
      if (type !== 'model') {
        if (j.ok) {
          msgEl.textContent = '✅ 连通正常(' + (j.type || '?') + ') ' + j.ms + 'ms,上游 HTTP ' + j.status;
          msgEl.className = 'msg ok';
        } else {
          msgEl.textContent = '❌ 连接失败: ' + (j.error || '未知错误') + '(' + j.ms + 'ms)';
          msgEl.className = 'msg err';
        }
        return;
      }
      // 模型对话:展示回复正文与 token 用量
      if (j.ok) {
        var u = j.usage || {};
        msgEl.textContent = '✅ 模型响应正常(' + (j.type || '?') + ') ' + j.ms + 'ms · ' + (j.model || '-') +
          ' · tokens ' + (u.total_tokens || 0) +
          '(入 ' + (u.prompt_tokens || 0) + ' / 出 ' + (u.completion_tokens || 0) + ')';
        msgEl.className = 'msg ok';
        el('test-reply').textContent = j.reply || '(模型返回空内容)';
        show('test-reply-field', true);
      } else {
        msgEl.textContent = '❌ 模型测试失败: ' + (j.error || '未知错误') + '(' + j.ms + 'ms)';
        msgEl.className = 'msg err';
      }
    }).catch(function (e) {
      msgEl.textContent = '测试失败: ' + e.message;
      msgEl.className = 'msg err';
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = '开始测试';
    });
  });

  // ---- 刷新 ----
  el('btn-refresh').addEventListener('click', function () {
    el('msg-global').textContent = '';
    Promise.all([loadConfig(), loadStats()]).catch(function () {});
  });

  // 初始化测试卡片:填入默认消息,并按默认类型同步字段显隐
  el('f-test-message').value = DEFAULT_TEST_MESSAGE;
  toggleTestFields();

  // 首次进入:已登录则直接进主视图
  if (token()) enterMain();
})();
</script>
</body>
</html>
`;
