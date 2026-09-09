/**
 * gateway.js - 本地 OpenAI 兼容 API 网关(无 mihomo,支持直连/HTTP/SOCKS5 代理)
 *
 * 对外暴露:
 *   GET  /health                健康检查(免鉴权)
 *   GET  /                      管理面板 HTML(免鉴权)
 *   POST /api/login             面板登录(免鉴权) -> token
 *   GET|PUT /api/config         查看/修改配置(token 鉴权)
 *   POST /api/test              连通性测试(token 鉴权)
 *                               type=connect 基础连通(默认) / type=model 真实模型对话
 *   GET  /v1/models             模型列表(API Key 鉴权)
 *   POST /v1/chat/completions   聊天补全,SSE 流式(API Key 鉴权)
 *
 * 出站方式由 config.proxy.type 决定:none=直连,http=HTTP CONNECT, socks5=SOCKS5。
 * 代理配置可热更新(setProxy/applyConfig),无需重启。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');
const { ProxyAgent, PoolAgent } = require('./proxy');
const UI_HTML = require('./ui');

const OPENCODE_ENDPOINT = 'https://opencode.ai/zen/v1/chat/completions';
const OPENCODE_MODELS = 'https://opencode.ai/zen/v1/models';
const FIXED_MODEL = 'mimo-v2.5-free';

// 面板「模型对话测试」的默认提问;用户可在面板自定义
const DEFAULT_TEST_MESSAGE = '你是谁，出来干活了';
// 诊断类请求的 token 上限:够模型作答即可,避免测试消耗过多免费额度
const TEST_MAX_TOKENS = 512;

// 构建出站请求头(每次请求随机生成伪会话 ID,避免固定 ID 触发风控)
function buildUpstreamHeaders(cfg) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': '*/*',
    'User-Agent': 'opencode/1.18.30 ai-sdk/provider-utils runtime/bun',
    'X-Opencode-Client': 'cli',
    'x-opencode-session': 'ses_' + crypto.randomUUID(),
    'x-opencode-request': 'usr_' + crypto.randomUUID(),
    'x-opencode-project': 'prj_' + crypto.randomUUID(),
  };
  if (cfg.upstreamKey) {
    h['Authorization'] = 'Bearer ' + cfg.upstreamKey;
  }
  return h;
}

// 免费模型默认白名单(config.freeModels 为空时兜底)
// 免费模型白名单(供 /v1/models 返回)
// 用户可在管理面板增删(存 config.freeModels,热加载生效),这里保留一份出厂默认
// 校准依据:opencode CLI 1.18.30 `opencode models` 列出的 opencode/* 免费模型
// (2026-09-09 实测;上游免费模型变动频繁,失配时以 CLI 输出为准)
const FREE_MODELS = [
  'big-pickle',
  'ling-3.0-flash-fin-free',
  'mimo-v2.5-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
];

// 管理会话有效期:12 小时,滑动续期
const SESSION_TTL = 12 * 60 * 60 * 1000;

/** 常量时间比较(防时序攻击) */
function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 读取请求体并解析 JSON;空体视为 {},非法 JSON 返回 null */
async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Token 用量统计器
 * 记录总请求数、成功/失败数、token 消耗(prompt/completion/reasoning)
 * 按天和按模型分组,持久化到 JSON 文件,重启不丢失。
 */
class UsageTracker {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.logger = logger;
    this.data = this.load();
  }
  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch (e) { this.logger?.('warn', `[usage] 加载用量数据失败: ${e.message}`); }
    return {
      total: { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      byDay: {}, byModel: {}, lastRequest: null, startTime: Date.now(),
    };
  }
  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) { this.logger?.('warn', `[usage] 保存用量数据失败: ${e.message}`); }
  }
  record(model, usage, success) {
    const day = new Date().toISOString().slice(0, 10);
    const pt = usage?.prompt_tokens || 0;
    const ct = usage?.completion_tokens || 0;
    const rt = usage?.completion_tokens_details?.reasoning_tokens || 0;
    const tt = usage?.total_tokens || (pt + ct);

    const t = this.data.total;
    t.requests++; if (success) t.success++; else t.fail++;
    t.promptTokens += pt; t.completionTokens += ct; t.reasoningTokens += rt; t.totalTokens += tt;

    if (!this.data.byDay[day]) this.data.byDay[day] = { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    const d = this.data.byDay[day];
    d.requests++; if (success) d.success++; else d.fail++;
    d.promptTokens += pt; d.completionTokens += ct; d.reasoningTokens += rt; d.totalTokens += tt;

    if (!this.data.byModel[model]) this.data.byModel[model] = { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    const m = this.data.byModel[model];
    m.requests++; if (success) m.success++; else m.fail++;
    m.promptTokens += pt; m.completionTokens += ct; m.reasoningTokens += rt; m.totalTokens += tt;

    this.data.lastRequest = Date.now();
    this.save();
  }
  getStats() {
    return {
      total: this.data.total,
      byDay: this.data.byDay,
      byModel: this.data.byModel,
      lastRequest: this.data.lastRequest,
      startTime: this.data.startTime,
    };
  }
  reset() {
    this.data = { total: { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 }, byDay: {}, byModel: {}, lastRequest: null, startTime: Date.now() };
    this.save();
    this.logger?.('ok', '[usage] 用量统计已清零');
  }
}

class Gateway {
  constructor(cfg, logger) {
    this.config = cfg;          // 配置对象(可被 applyConfig 整体替换)
    this.logger = logger;       // (level, msg) => void
    this.server = null;
    this.usage = new UsageTracker(config.USAGE_FILE, logger);
    this.sessions = new Map();  // token -> expiresAt
    this.agent = null;          // 懒构建的出站 agent(keep-alive 复用)
    this.agentSig = '';         // 记录构建 agent 时的代理签名
  }

  // ---- 出站 agent(直连 / ProxyAgent / PoolAgent)----
  proxyLabel() {
    const p = this.config.proxy;
    if (!p || p.type === 'none') return '直连';
    // 代理池:显示模式与池内代理数量
    if (p.type === 'http_pool' || p.type === 'socks5_pool') {
      const n = (p.pool || []).length;
      return `${p.type}(${n})`;
    }
    const auth = p.username ? `${p.username}:***@` : '';
    return `${p.type}://${auth}${p.host}:${p.port}`;
  }
  proxySig(p) {
    const pool = (p.pool || []).map(e => `${e.type}|${e.host}|${e.port}|${e.username}|${e.password}`).join(';');
    return `${p.type}|${p.host}|${p.port}|${p.username}|${p.password}|${pool}`;
  }
  destroyAgent() {
    if (this.agent) { try { this.agent.destroy(); } catch {} this.agent = null; }
  }
  buildAgent() {
    const p = this.config.proxy;
    const sig = this.proxySig(p);
    if (!this.agent || this.agentSig !== sig) {
      this.destroyAgent();
      const type = p.type;
      if (type === 'none' || !type) {
        this.agent = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000, rejectUnauthorized: false });
      } else if (type === 'http_pool' || type === 'socks5_pool') {
        // 代理池:每次请求随机抽取一个代理;keepAlive 关闭由 PoolAgent 内部保证
        this.agent = new PoolAgent(p.pool || [], { maxSockets: 32, rejectUnauthorized: false });
      } else {
        this.agent = new ProxyAgent(p, { keepAlive: true, maxSockets: 16, keepAliveMsecs: 30000, rejectUnauthorized: false });
      }
      this.agentSig = sig;
    }
    return this.agent;
  }
  /** 应用新配置;代理变化时热重建 agent,其余字段即时生效 */
  applyConfig(next) {
    const old = this.config;
    this.config = next;
    if (this.proxySig(old.proxy) !== this.proxySig(next.proxy)) {
      this.destroyAgent();
      this.logger('info', `[config] 代理热更新 -> ${this.proxyLabel()}`);
    }
  }

  // ---- 免费模型解析 ----
  // config.freeModels 非空则用面板配置,否则回退内置默认;保证 /v1/models 恒非空
  getFreeModels() {
    const list = this.config.freeModels;
    return (list && list.length) ? list : FREE_MODELS;
  }
  /** 模型归一化:白名单内透传,否则回退固定模型 */
  resolveModel(model) {
    return this.getFreeModels().includes(model) ? model : FIXED_MODEL;
  }

  // ---- 管理会话 ----
  isAuthed(req) {
    const token = req.headers['x-auth-token'];
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp) return false;
    if (Date.now() > exp) { this.sessions.delete(token); return false; }
    this.sessions.set(token, Date.now() + SESSION_TTL); // 滑动续期
    return true;
  }
  pruneSessions() {
    const now = Date.now();
    for (const [t, exp] of this.sessions) if (exp <= now) this.sessions.delete(t);
  }

  // ---- 启动 HTTP 服务 ----
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try { await this.handle(req, res); }
        catch (e) { this.safe(res, 500, { error: { message: 'Internal: ' + e.message } }); }
      });

      const tryListen = (port) => {
        this.server.removeAllListeners('error');
        this.server.on('error', (err) => {
          if (err.code === 'EADDRINUSE' && port < 65535) {
            this.logger('warn', `[gateway] 端口 ${port} 被占用,尝试 ${port + 1}`);
            tryListen(port + 1);
          } else { reject(err); }
        });
        this.server.listen(port, this.config.host || '0.0.0.0', () => {
          const addr = this.server.address();
          this.config.port = addr.port;
          this.logger('ok', `[gateway] 监听 ${addr.address}:${addr.port}`);
          resolve(addr.port);
        });
      };

      tryListen(this.config.port || 9527);
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.destroyAgent();
      if (this.server) { this.server.close(() => { this.server = null; resolve(); }); }
      else { resolve(); }
    });
  }

  // ---- 路由 ----
  async handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const m = req.method;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    if (m === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // 健康检查(免鉴权)
    if (p === '/health' && m === 'GET') {
      return this.safe(res, 200, { ok: true, model: FIXED_MODEL, port: this.config.port, proxy: this.proxyLabel() });
    }

    // 管理面板(免鉴权,登录由前端完成)
    if (p === '/' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(UI_HTML);
    }

    // 登录(免鉴权)
    if (p === '/api/login' && m === 'POST') {
      return this.apiLogin(req, res);
    }

    // /api/* 管理接口:token 鉴权
    if (p.startsWith('/api/')) {
      if (!this.isAuthed(req)) {
        return this.safe(res, 401, { error: { message: 'Unauthorized', type: 'auth_error' } });
      }
      if (p === '/api/config' && m === 'GET') {
        const s = config.sanitize(this.config);
        s.freeModels = this.getFreeModels(); // 回传实际生效的模型列表(含默认兜底)
        return this.safe(res, 200, s);
      }
      if (p === '/api/config' && m === 'PUT') {
        return this.apiUpdateConfig(req, res);
      }
      if (p === '/api/test' && m === 'POST') {
        return this.apiTest(req, res);
      }
      if (p === '/api/stats' && m === 'GET') {
        return this.safe(res, 200, this.getStats());
      }
      return this.safe(res, 404, { error: { message: `Not found: ${m} ${p}` } });
    }

    // /v1/* 客户端 API:API Key 鉴权
    if (p.startsWith('/v1/')) {
      if (!this.checkKey(req)) {
        return this.safe(res, 401, { error: { message: 'Invalid API key', type: 'auth_error' } });
      }
      if (p === '/v1/models' && m === 'GET') return this.handleModels(res);
      if (p === '/v1/chat/completions' && m === 'POST') return this.handleChat(req, res);
    }

    this.safe(res, 404, { error: { message: `Not found: ${m} ${p}` } });
  }

  checkKey(req) {
    const k = req.headers['authorization'] || '';
    const mm = k.match(/^Bearer\s+(.+)$/i);
    if (!mm) return false;
    return mm[1] === this.config.apiKey;
  }

  // ---- 面板登录 ----
  async apiLogin(req, res) {
    const body = await readJsonBody(req);
    if (body === null) return this.safe(res, 400, { error: { message: 'Invalid JSON' } });
    const pass = typeof body.password === 'string' ? body.password : '';
    if (!safeEqualStr(pass, this.config.adminPassword)) {
      this.logger('warn', '[login] 密码错误');
      return this.safe(res, 401, { error: { message: '密码错误' } });
    }
    this.pruneSessions();
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, Date.now() + SESSION_TTL);
    this.logger('ok', '[login] 管理面板登录成功');
    return this.safe(res, 200, { ok: true, token });
  }

  // ---- 修改配置(含哨兵保持原值)----
  async apiUpdateConfig(req, res) {
    const body = await readJsonBody(req);
    if (body === null) return this.safe(res, 400, { error: { message: 'Invalid JSON' } });

    const next = { ...this.config, proxy: { ...this.config.proxy } };
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.apiKey = body.apiKey.trim();
    // adminPassword:'********'(或空)视为保持原值
    if (typeof body.adminPassword === 'string' && body.adminPassword && body.adminPassword !== '********') next.adminPassword = body.adminPassword;
    if (typeof body.port === 'number' && body.port >= 1 && body.port <= 65535) next.port = body.port;
    if (typeof body.host === 'string' && body.host.trim()) next.host = body.host.trim();

    const pc = (body.proxy && typeof body.proxy === 'object') ? body.proxy : {};
    next.proxy = config.normalizeProxy({
      type: pc.type !== undefined ? pc.type : next.proxy.type,
      host: pc.host !== undefined ? pc.host : next.proxy.host,
      port: pc.port !== undefined ? pc.port : next.proxy.port,
      username: pc.username !== undefined ? pc.username : next.proxy.username,
      password: (pc.password && pc.password !== '********') ? pc.password : next.proxy.password,
      pool: pc.pool !== undefined ? pc.pool : next.proxy.pool,
    });

    // 代理池密码哨兵:'********' 保持旧池中同 key 条目的原密码
    // (前端重载配置后看到的是脱敏密码,直接保存需靠 key 匹配还原)
    if (Array.isArray(next.proxy.pool)) {
      const oldPool = config.normalizeProxyPool(this.config.proxy.pool);
      next.proxy.pool = next.proxy.pool.map(e => {
        if (e.password === '********') {
          const old = oldPool.find(o => o.type === e.type && o.host === e.host && o.port === e.port && o.username === e.username);
          if (old) return { ...e, password: old.password };
        }
        return e;
      });
    }

    // 免费模型白名单:数组则归一化存储(空数组=回退内置默认);其余忽略
    if (Array.isArray(body.freeModels)) {
      next.freeModels = config.normalizeFreeModels(body.freeModels);
    }

    // 上游 API Key(sk-xxx):空/脱敏哨兵保持原值
    if (typeof body.upstreamKey === 'string' && body.upstreamKey && body.upstreamKey !== '********') {
      next.upstreamKey = body.upstreamKey.trim();
    }

    config.ensureAdminPassword(next); // 保证密码非空
    config.save(next);

    const portChanged = next.port !== this.config.port || next.host !== this.config.host;
    this.applyConfig(next);

    const out = config.sanitize(next);
    out.freeModels = this.getFreeModels(); // 回传实际生效的模型列表(含默认兜底)
    const msg = portChanged ? '已保存(端口/监听地址改动重启后生效)' : '已保存并热生效';
    this.logger('ok', `[config] 更新: ${msg} 免费模型 x${out.freeModels.length}`);
    return this.safe(res, 200, { ok: true, message: msg, config: out });
  }

  // ---- 连通性测试(POST /api/test)----
  // body.type = 'connect' 基础连通:GET /zen/v1/models,只验证网络与代理通路(向后兼容默认)
  // body.type = 'model'   模型对话:真实发一条 chat/completions,验证所选模型能否作答
  async apiTest(req, res) {
    const body = await readJsonBody(req);
    if (body === null) return this.safe(res, 400, { error: { message: 'Invalid JSON' } });

    if (body.type === 'model') return this.apiTestModel(res, body);
    return this.safe(res, 200, await this.apiTestConnect());
  }

  // 基础连通:走当前 agent,任何 HTTP 响应即视为网络可达
  apiTestConnect() {
    const t0 = Date.now();
    const agent = this.buildAgent();
    const label = this.proxyLabel();
    return new Promise((resolve) => {
      const url = new URL(OPENCODE_MODELS);
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'GET',
        agent,
        timeout: 15000,
      }, (resp) => {
        resp.resume();
        resolve({ ok: true, ms: Date.now() - t0, status: resp.statusCode, type: label });
      });
      req.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, error: e.message, type: label }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t0, error: 'timeout(15s)', type: label }); });
      req.end();
    });
  }

  /**
   * 模型对话测试:向上游真实发一条消息,回传模型答复供面板展示。
   * 复用 forwardToOpenCode,因此走同一套出站/代理/请求头逻辑。
   * 诊断请求不写 usage 统计(由 handleChat 负责记账,这里绕开),避免污染用量数据。
   */
  async apiTestModel(res, body) {
    const label = this.proxyLabel();
    const message = String(body.message || '').trim() || DEFAULT_TEST_MESSAGE;
    const model = this.resolveModel(body.model); // 白名单内透传,否则回退固定模型
    const t0 = Date.now();

    this.logger('info', `[test] 模型对话测试 model=${model} proxy=${label} msg="${message}"`);

    try {
      const result = await this.forwardToOpenCode({
        model,
        messages: [{ role: 'user', content: message }],
        stream: false,
        max_tokens: TEST_MAX_TOKENS,
      });
      const reply = result?.choices?.[0]?.message?.content || '';
      const usage = result?.usage || null;
      this.logger('ok', `[test] 模型回复正常 ${Date.now() - t0}ms tokens=${usage?.total_tokens ?? 0}`);
      return this.safe(res, 200, {
        ok: true,
        ms: Date.now() - t0,
        status: 200,
        type: label,
        mode: 'model',
        model,
        message,
        reply,
        usage,
      });
    } catch (e) {
      const status = e?.status || 0;
      // 上游错误体可能是 JSON(如 429 的 FreeUsageLimitError),尽量提取可读信息
      let detail = e?.body || e?.message || '未知错误';
      try {
        const parsed = JSON.parse(detail);
        detail = parsed?.error?.message || parsed?.message || detail;
      } catch { /* 非 JSON,原样返回 */ }
      const error = status === 0 ? `上游连接失败: ${detail}` : `HTTP ${status}: ${detail}`;
      this.logger('error', `[test] 模型对话测试失败 ${error}`);
      return this.safe(res, 200, { ok: false, ms: Date.now() - t0, error, type: label, mode: 'model', model, message });
    }
  }

  // ---- /v1/models ----
  handleModels(res) {
    const data = this.getFreeModels().map(id => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'opencode-zen',
    }));
    this.safe(res, 200, { object: 'list', data });
  }

  // ---- /v1/chat/completions(单上游,429 透传 Retry-After)----
  async handleChat(req, res) {
    const body = await readJsonBody(req);
    if (body === null) return this.safe(res, 400, { error: { message: 'Invalid JSON' } });

    body.model = this.resolveModel(body.model); // 白名单内模型透传,否则回退固定模型
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return this.safe(res, 400, { error: { message: 'messages required' } });
    }
    const wantStream = body.stream === true;

    const clientIp = req.socket.remoteAddress;
    this.logger('info', `[chat] from=${clientIp} msgs=${body.messages.length} stream=${wantStream} proxy=${this.proxyLabel()}`);

    try {
      if (wantStream) {
        await this.forwardStream(res, body, req);
      } else {
        const result = await this.forwardToOpenCode(body);
        this.usage.record(body.model, result.usage, true);
        this.logger('ok', `[ok] tokens=${result.usage?.total_tokens}`);
        return this.safe(res, 200, result);
      }
    } catch (e) {
      const status = e.status || 0;
      const notStarted = e.notStarted !== false; // 流式是否已开始发数据
      if (!notStarted) {
        // 已开始流式转发后出错:不能切换,直接返回错误让 agent 重试
        this.logger('error', `[stream-mid] 流式中断: ${e.body || e.message}`);
        try { this.safe(res, 502, { error: { message: 'Stream interrupted' } }); } catch {}
        return;
      }
      this.logger('error', `[chat] 转发失败 HTTP ${status}: ${e.body || e.message}`);
      if (status === 429) {
        res.setHeader('Retry-After', '60');
        return this.safe(res, 429, { error: { message: 'Rate limited, retry in ~60s', type: 'rate_limited' } });
      }
      if (status === 0) {
        return this.safe(res, 502, { error: { message: `上游连接失败: ${e.body || e.message}`, type: 'upstream_error' } });
      }
      let parsed;
      try { parsed = JSON.parse(e.body); } catch { parsed = { error: { message: e.body || `HTTP ${status}` } }; }
      return this.safe(res, status, parsed);
    }
  }

  // ---- 转发到 opencode(非流式)----
  forwardToOpenCode(body) {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body);
      const url = new URL(OPENCODE_ENDPOINT);
      const opts = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          ...buildUpstreamHeaders(this.config),
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        agent: this.buildAgent(),
        timeout: 60000,
      };

      const r = https.request(opts, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          if (resp.statusCode === 200) {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject({ status: 502, body: data }); }
          } else {
            reject({ status: resp.statusCode, body: data });
          }
        });
      });
      r.on('error', (e) => reject({ status: 0, body: e.message }));
      r.on('timeout', () => { r.destroy(); reject({ status: 0, body: 'timeout' }); });
      r.write(bodyStr);
      r.end();
    });
  }

  // ---- 流式管道转发 opencode 的 SSE(原样透传)----
  forwardStream(res, body, req) {
    return new Promise((resolve, reject) => {
      body.stream = true;
      const bodyStr = JSON.stringify(body);
      const url = new URL(OPENCODE_ENDPOINT);
      const opts = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          ...buildUpstreamHeaders(this.config),
          'Accept': 'text/event-stream',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        agent: this.buildAgent(),
        timeout: 300000, // 流式 5 分钟(thinking 模式推理较慢)
      };

      let clientGone = false;
      let upstreamReq = null;
      const onClientClose = () => {
        clientGone = true;
        if (upstreamReq) { try { upstreamReq.destroy(); } catch {} }
      };
      req.on('close', onClientClose);
      req.on('aborted', onClientClose);

      upstreamReq = https.request(opts, (resp) => {
        if (resp.statusCode !== 200) {
          // 非 200(如 429):收集 body 判断错误,尚未 writeHead,可安全返回错误
          let data = '';
          resp.on('data', c => data += c);
          resp.on('end', () => {
            req.off('close', onClientClose);
            req.off('aborted', onClientClose);
            reject({ status: resp.statusCode, body: data, notStarted: true });
          });
          return;
        }

        if (clientGone) {
          this.logger('info', '[stream] 客户端已断开,取消上游响应');
          try { resp.destroy(); } catch {}
          req.off('close', onClientClose);
          req.off('aborted', onClientClose);
          resolve();
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        // 拦截 SSE 数据提取 usage(不改数据,原样转发)
        let sseBuffer = '';
        let capturedUsage = null;

        resp.on('data', (chunk) => {
          if (clientGone) { try { resp.destroy(); } catch {} return; }
          try { res.write(chunk); } catch {}
          try {
            sseBuffer += chunk.toString();
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop();
            for (const line of lines) {
              if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                const json = JSON.parse(line.slice(6));
                if (json.usage) capturedUsage = json.usage;
              }
            }
          } catch {}
        });

        resp.on('end', () => {
          req.off('close', onClientClose);
          req.off('aborted', onClientClose);
          if (!res.writableEnded) { try { res.end(); } catch {} }
          if (capturedUsage) this.usage.record(body.model, capturedUsage, true);
          resolve();
        });

        resp.on('error', (e) => {
          req.off('close', onClientClose);
          req.off('aborted', onClientClose);
          if (clientGone || e.message === 'aborted' || e.code === 'ECONNRESET') {
            this.logger('info', `[stream] 客户端断开或连接重置,已清理上游连接`);
          } else {
            this.logger('warn', `[stream] 上游错误: ${e.message}`);
          }
          if (!res.writableEnded) { try { res.end(); } catch {} }
          resolve();
        });
      });

      upstreamReq.on('error', (e) => {
        req.off('close', onClientClose);
        req.off('aborted', onClientClose);
        reject({ status: 0, body: e.message, notStarted: true });
      });
      upstreamReq.on('timeout', () => {
        upstreamReq.destroy();
        req.off('close', onClientClose);
        req.off('aborted', onClientClose);
        reject({ status: 0, body: 'stream timeout', notStarted: true });
      });

      upstreamReq.write(bodyStr);
      upstreamReq.end();
    });
  }

  // ---- 状态/用量 ----
  getStats() {
    const usage = this.usage.getStats();
    return {
      uptime: Date.now() - usage.startTime,
      usage,
      proxy: this.proxyLabel(),
      model: FIXED_MODEL,
      port: this.config.port,
      apiKey: this.config.apiKey,
    };
  }
  getUsage() { return this.usage.getStats(); }
  resetUsage() { this.usage.reset(); }

  safe(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }
}

module.exports = { Gateway, FIXED_MODEL };
