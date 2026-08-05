/**
 * gateway.js - 本地 OpenAI 兼容 API 网关
 *
 * 对外暴露标准 OpenAI 协议:
 *   POST /v1/chat/completions
 *   GET  /v1/models
 *
 * 内部逻辑:
 *   1. 收到请求 -> 校验 API Key
 *   2. 通过本地 mihomo 代理(17897)转发到 opencode.ai/zen/v1/chat/completions
 *   3. 遇到 429 -> 切换 mihomo 调度节点的选择 -> 重试
 *   4. 成功后记住该节点,下次优先用
 *
 * 模型固定:deepseek-v4-flash-free(忽略客户端传的 model,强制覆盖)
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const config = require('./config');

const OPENCODE_ENDPOINT = 'https://opencode.ai/zen/v1/chat/completions';
const OPENCODE_MODELS = 'https://opencode.ai/zen/v1/models';
const FIXED_MODEL = 'deepseek-v4-flash-free';
const MIHOMO_PROXY_PORT = 17897;
const MIHOMO_CTRL_PORT = 19090;
const POOL_NAME = 'zen-pool';

// 免费模型白名单(供 /v1/models 返回)
const FREE_MODELS = [
  'deepseek-v4-flash-free',
  'big-pickle',
  'mimo-v2.5-free',
  'laguna-s-2.1-free',
  'ling-3.0-flash-free',
  'north-mini-code-free',
  'nemotron-3-ultra-free',
];

// 节点冷却时间(毫秒):429 后冷却 90 秒,过完自动恢复
// opencode 限流时间窗口实测约 60-90 秒,设 90 秒保证恢复
const COOLDOWN_MS = 90 * 1000;

/**
 * 节点冷却管理器
 * 记录每个节点 429 的时间,冷却期内跳过该节点。
 * 这样连续请求时不会重复选到刚被限的节点,避免振荡。
 */
class NodeCooldown {
  constructor(logger) {
    this.logger = logger;
    this.cooldowns = new Map();  // node -> 429 时间戳
  }
  // 标记节点 429,进入冷却
  mark429(node) {
    this.cooldowns.set(node, Date.now());
  }
  // 节点是否在冷却中
  isCooling(node) {
    const t = this.cooldowns.get(node);
    if (!t) return false;
    if (Date.now() - t < COOLDOWN_MS) return true;
    // 冷却结束,自动移除
    this.cooldowns.delete(node);
    return false;
  }
  // 节点成功使用,清除冷却记录
  clear(node) {
    this.cooldowns.delete(node);
  }
  // 从节点列表中选出第一个可用(未冷却)的
  pickAvailable(nodes, excludeSet = null) {
    for (const n of nodes) {
      if (excludeSet && excludeSet.has(n)) continue;
      if (this.isCooling(n)) continue;
      return n;
    }
    return null;
  }
  // 状态摘要(供日志/界面用)
  summary() {
    const cooling = [];
    for (const [node, t] of this.cooldowns) {
      if (Date.now() - t < COOLDOWN_MS) {
        cooling.push({ node, remain: Math.ceil((COOLDOWN_MS - (Date.now() - t)) / 1000) });
      }
    }
    return cooling;
  }
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
      byDay: {},    // { "2026-08-02": { requests, success, fail, promptTokens, ... } }
      byModel: {},  // { "deepseek-v4-flash-free": { requests, ... } }
      lastRequest: null,
      startTime: Date.now(),
    };
  }
  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) { this.logger?.('warn', `[usage] 保存用量数据失败: ${e.message}`); }
  }
  record(model, usage, success) {
    const day = new Date().toISOString().slice(0, 10);  // 2026-08-02
    const pt = usage?.prompt_tokens || 0;
    const ct = usage?.completion_tokens || 0;
    const rt = usage?.completion_tokens_details?.reasoning_tokens || 0;
    const tt = usage?.total_tokens || (pt + ct);

    // 总计
    const t = this.data.total;
    t.requests++;
    if (success) t.success++; else t.fail++;
    t.promptTokens += pt;
    t.completionTokens += ct;
    t.reasoningTokens += rt;
    t.totalTokens += tt;

    // 按天
    if (!this.data.byDay[day]) this.data.byDay[day] = { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    const d = this.data.byDay[day];
    d.requests++;
    if (success) d.success++; else d.fail++;
    d.promptTokens += pt;
    d.completionTokens += ct;
    d.reasoningTokens += rt;
    d.totalTokens += tt;

    // 按模型
    if (!this.data.byModel[model]) this.data.byModel[model] = { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
    const m = this.data.byModel[model];
    m.requests++;
    if (success) m.success++; else m.fail++;
    m.promptTokens += pt;
    m.completionTokens += ct;
    m.reasoningTokens += rt;
    m.totalTokens += tt;

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
    this.data = {
      total: { requests: 0, success: 0, fail: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      byDay: {}, byModel: {}, lastRequest: null, startTime: Date.now(),
    };
    this.save();
    this.logger?.('ok', '[usage] 用量统计已清零');
  }
}

class Gateway {
  constructor(config, logger) {
    this.config = config;       // { apiKey, port }
    this.logger = logger;       // (level, msg) => void
    this.server = null;
    this.lastNodeFile = config.LAST_NODE_FILE;
    this.nodeCache = null;      // 节点列表缓存
    this.nodeCacheTime = 0;
    this.switching = false;     // 切换中标记(避免并发切换)
    this.cooldown = new NodeCooldown(logger);  // 节点冷却管理
    this.lockedNode = null;     // 锁定节点:成功后锁定,后续请求优先用,直到 429 才换
    this.paused = false;        // 暂停标志:重置/重启期间暂停接收请求,避免代理不可用导致断联
    this.usage = new UsageTracker(config.USAGE_FILE, logger);  // token 用量统计
  }

  // ---- 暂停/恢复(重置或重启 mihomo 期间调用)----
  pause() { this.paused = true; }
  resume() { this.paused = false; }

  // ---- 启动 HTTP 服务 ----
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this.handle(req, res);
        } catch (e) {
          this.safe(res, 500, { error: { message: 'Internal: ' + e.message } });
        }
      });

      const tryListen = (port) => {
        this.server.removeAllListeners('error');
        this.server.on('error', (err) => {
          if (err.code === 'EADDRINUSE' && port < 65535) {
            // 端口被占,自动试下一个
            this.logger('warn', `[gateway] 端口 ${port} 被占用,尝试 ${port + 1}`);
            tryListen(port + 1);
          } else {
            reject(err);
          }
        });
        this.server.listen(port, '127.0.0.1', () => {
          const addr = this.server.address();
          this.config.port = addr.port;
          this.logger('ok', `[gateway] 监听 127.0.0.1:${addr.port}`);
          // 启动时恢复一次上次成功节点(后续请求不再调用,避免振荡)
          this.restoreLastNode().catch(() => {});
          resolve(addr.port);
        });
      };

      // 从配置的端口开始试(默认 9527),被占则递增
      const startPort = this.config.port || 9527;
      tryListen(startPort);
    });
  }

  // ---- 手动重置:清空所有冷却 + 锁定节点 ----
  resetCooldowns() {
    const count = this.cooldown.cooldowns.size;
    this.cooldown.cooldowns.clear();
    this.lockedNode = null;
    this.nodeCache = null;       // 清空节点缓存,避免重置后仍用旧节点名
    this.nodeCacheTime = 0;
    this.logger('ok', `[reset] 已清空 ${count} 个节点冷却记录,重置锁定节点,清空节点缓存`);
    return count;
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => { this.server = null; resolve(); });
      } else { resolve(); }
    });
  }

  // ---- 路由 ----
  async handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const m = req.method;

    // CORS(方便浏览器 agent 调用)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    if (m === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // 健康检查(不需要 key)
    if (p === '/health' && m === 'GET') {
      return this.safe(res, 200, { ok: true, model: FIXED_MODEL, port: this.config.port });
    }

    // 以下需要 Key
    if (!this.checkKey(req)) {
      return this.safe(res, 401, { error: { message: 'Invalid API key', type: 'auth_error' } });
    }

    // 暂停中(重置/重启 mihomo 期间):返回 503 让客户端重试,而不是因代理不可用导致断联
    if (this.paused) {
      res.setHeader('Retry-After', '10');
      return this.safe(res, 503, { error: { message: 'Gateway is resetting, please retry in a few seconds', type: 'gateway_paused' } });
    }

    if (p === '/v1/models' && m === 'GET') {
      return this.handleModels(res);
    }
    if (p === '/v1/chat/completions' && m === 'POST') {
      return this.handleChat(req, res);
    }

    this.safe(res, 404, { error: { message: `Not found: ${m} ${p}` } });
  }

  checkKey(req) {
    const k = req.headers['authorization'] || '';
    const m = k.match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    return m[1] === this.config.apiKey;
  }

  // ---- /v1/models ----
  handleModels(res) {
    const data = FREE_MODELS.map(id => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'opencode-zen',
    }));
    this.safe(res, 200, { object: 'list', data });
  }

  // ---- /v1/chat/completions ----
  async handleChat(req, res) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = JSON.parse(raw); }
    catch { return this.safe(res, 400, { error: { message: 'Invalid JSON' } }); }

    // 强制固定模型(忽略客户端传的)
    body.model = FIXED_MODEL;
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return this.safe(res, 400, { error: { message: 'messages required' } });
    }
    // 不支持流式时强制非流式(简化实现)
    const wantStream = body.stream === true;
    body.stream = false;

    const clientIp = req.socket.remoteAddress;
    this.logger('info', `[chat] from=${clientIp} msgs=${body.messages.length} stream=${wantStream}`);

    // 尝试发请求,429/超时则换节点重试
    const nodes = await this.getAllNodes();
    if (nodes.length === 0) {
      return this.safe(res, 503, { error: { message: 'No proxy nodes available' } });
    }

    // ---- 节点选择策略 ----
    // 核心原则:一个 IP 能用就一直用,直到 429 才换。
    // lockedNode:上次成功锁定的节点,后续请求直接用,不重新选择
    let cur = this.lockedNode;
    if (!cur || this.cooldown.isCooling(cur)) {
      cur = this.cooldown.pickAvailable(nodes);
      if (!cur) {
        // 全部冷却中:选剩余冷却时间最短的
        let bestNode = null, bestRemain = Infinity;
        for (const n of nodes) {
          const t = this.cooldown.cooldowns.get(n);
          if (t) {
            const remain = COOLDOWN_MS - (Date.now() - t);
            if (remain < bestRemain) { bestRemain = remain; bestNode = n; }
          }
        }
        if (bestNode && bestRemain > 0) {
          this.logger('warn', `[cooldown] 所有节点冷却中,等待 ${bestNode} 恢复(剩 ${Math.ceil(bestRemain/1000)}s)`);
          await sleep(bestRemain + 1000);
          cur = bestNode;
          this.cooldown.cooldowns.delete(cur);
        } else {
          cur = nodes[0];
        }
      }
      const curMihomo = await this.getCurrentNode();
      if (curMihomo !== cur) {
        const ok = await this.switchNode(cur);
        if (!ok) {
          this.cooldown.mark429(cur);
          return this.safe(res, 503, { error: { message: 'Switch node failed' } });
        }
      }
    }

    // 本次请求内已尝试过的节点(429 或网络错误耗尽后切换)
    const localTried = new Set();
    let curRetry = 0;          // 当前节点网络错误重试计数
    const MAX_NET_RETRY = 2;
    let attempt = 0;

    while (true) {
      attempt++;
      if (attempt > nodes.length + 5) {
        this.logger('error', `[chat] 重试次数耗尽`);
        return this.safe(res, 503, {
          error: { message: 'All nodes unavailable after retries', type: 'all_nodes_unavailable' },
        });
      }

      const t0 = Date.now();
      try {
        if (wantStream) {
          // ---- 流式:直接管道转发 opencode 的 SSE ----
          // notStarted=true 表示还没开始发数据(429/网络错误),可以安全切换重试
          // notStarted=false 或正常 resolve 表示已开始/完成,不能再切换
          await this.forwardStream(res, body);
          const dt = Date.now() - t0;
          this.lockedNode = cur;
          this.cooldown.clear(cur);
          this.saveLastNode(cur);
          this.logger('ok', `[stream-ok] node="${cur}" ${dt}ms`);
          return;
        } else {
          // ---- 非流式 ----
          const result = await this.forwardToOpenCode(body);
          const dt = Date.now() - t0;
          this.lockedNode = cur;
          this.cooldown.clear(cur);
          this.saveLastNode(cur);
          curRetry = 0;
          this.usage.record(FIXED_MODEL, result.usage, true);
          this.logger('ok', `[ok] node="${cur}" ${dt}ms tokens=${result.usage?.total_tokens}`);
          return this.safe(res, 200, result);
        }
      } catch (e) {
        const status = e.status || 0;
        const notStarted = e.notStarted !== false;  // 流式是否还没开始发数据

        // 已经开始流式转发后出错:不能切换,直接返回错误让 agent 重试
        if (!notStarted) {
          this.logger('error', `[stream-mid] node="${cur}" 流式中断: ${e.body || e.message}`);
          try { this.safe(res, 502, { error: { message: 'Stream interrupted' } }); } catch {}
          return;
        }

        // 429 = 真正限额:标记冷却,切下一个可用节点
        if (status === 429) {
          this.cooldown.mark429(cur);
          this.logger('warn', `[429] node="${cur}" 限流,冷却 ${COOLDOWN_MS/1000}s`);
          localTried.add(cur);
          curRetry = 0;

          let next = this.cooldown.pickAvailable(nodes, localTried);
          if (!next) {
            const summary = this.cooldown.summary();
            this.logger('error', `[chat] 全部节点冷却中: ${summary.length} 个`);
            return this.safe(res, 429, {
              error: {
                message: `All nodes rate-limited, retry in ~${summary[0]?.remain || 90}s`,
                type: 'all_nodes_429',
                cooldown: summary,
              },
            });
          }
          // 切节点前等 2 秒:避免重置后快速遍历全部节点导致全部 429(给上游限流恢复时间)
          await sleep(2000);
          const ok = await this.switchNode(next);
          if (ok) { cur = next; }
          else { localTried.add(next); }
          continue;
        }

        // status=0 = 网络错误:只重试当前节点,不切换(避免振荡)
        if (status === 0) {
          curRetry++;
          if (curRetry <= MAX_NET_RETRY) {
            this.logger('warn', `[net-retry ${curRetry}/${MAX_NET_RETRY}] node="${cur}" 网络错误,重试当前节点`);
            await sleep(1000);
            continue;
          }
          localTried.add(cur);
          curRetry = 0;
          this.logger('warn', `[timeout] node="${cur}" 重试 ${MAX_NET_RETRY} 次仍失败,切下一个`);
          let next = this.cooldown.pickAvailable(nodes, localTried);
          if (!next) {
            return this.safe(res, 504, { error: { message: 'All nodes timeout' } });
          }
          const ok = await this.switchNode(next);
          if (ok) { cur = next; }
          else { localTried.add(next); }
          continue;
        }

        // 其他 HTTP 错误(400/500 等):不切节点,直接返回
        this.logger('error', `[chat] HTTP ${status}: ${e.body}`);
        return this.safe(res, status, e.body ? JSON.parse(e.body) : { error: { message: `HTTP ${status}` } });
      }
    }
  }

  // ---- 转发到 opencode(非流式,通过 mihomo 代理)----
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
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'User-Agent': 'node',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        // 走本地 mihomo 代理
        agent: new https.Agent({
          proxy: `http://127.0.0.1:${MIHOMO_PROXY_PORT}`,
          rejectUnauthorized: false,
        }),
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

  // ---- 流式管道转发 opencode 的 SSE(不做任何拆分,原样透传)----
  // 关键:开始转发前(状态码!=200)可以安全切换节点重试;
  //       开始转发后(已 writeHead)不能切换,只能让 agent 重试整个请求。
  forwardStream(res, body) {
    return new Promise((resolve, reject) => {
      body.stream = true;  // 确保向 opencode 请求流式
      const bodyStr = JSON.stringify(body);
      const url = new URL(OPENCODE_ENDPOINT);
      const opts = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'User-Agent': 'node',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        agent: new https.Agent({
          proxy: `http://127.0.0.1:${MIHOMO_PROXY_PORT}`,
          rejectUnauthorized: false,
        }),
        timeout: 120000,  // 流式请求超时 2 分钟
      };

      const r = https.request(opts, (resp) => {
        if (resp.statusCode !== 200) {
          // 非 200(可能是 429):收集完整 body 用于判断错误,还没 writeHead,可以安全重试
          let data = '';
          resp.on('data', c => data += c);
          resp.on('end', () => {
            reject({ status: resp.statusCode, body: data, notStarted: true });
          });
          return;
        }
        // 200:开始流式转发,设置 SSE headers,直接管道
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        // 拦截 SSE 数据提取 usage(不修改数据,原样转发给客户端)
        let sseBuffer = '';
        let capturedUsage = null;
        resp.on('data', (chunk) => {
          res.write(chunk);
          // 解析 SSE 行,提取 usage(通常在最后一个 chunk 中)
          try {
            sseBuffer += chunk.toString();
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop();  // 保留最后不完整的行
            for (const line of lines) {
              if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                const json = JSON.parse(line.slice(6));
                if (json.usage) capturedUsage = json.usage;
              }
            }
          } catch {}
        });
        resp.on('end', () => {
          res.end();
          if (capturedUsage) {
            this.usage.record(FIXED_MODEL, capturedUsage, true);
          }
          resolve();
        });
        resp.on('error', (e) => {
          this.logger('error', `[stream] 中断: ${e.message}`);
          try { res.end(); } catch {}
          resolve();  // 已经发了一部分,不算失败
        });
      });
      r.on('error', (e) => reject({ status: 0, body: e.message, notStarted: true }));
      r.on('timeout', () => {
        r.destroy();
        reject({ status: 0, body: 'stream timeout', notStarted: true });
      });
      r.write(bodyStr);
      r.end();
    });
  }

  // ---- mihomo 控制 ----
  async getAllNodes() {
    // 缓存 30 秒
    if (this.nodeCache && Date.now() - this.nodeCacheTime < 30000) {
      return this.nodeCache;
    }
    try {
      const r = await this.mihomoApi(`/proxies/${POOL_NAME}`);
      const all = r.all || [];
      this.nodeCache = all;
      this.nodeCacheTime = Date.now();
      return all;
    } catch (e) {
      this.logger('error', `[mihomo] 获取节点失败: ${e.message}`);
      return [];
    }
  }

  async getCurrentNode() {
    try {
      const r = await this.mihomoApi(`/proxies/${POOL_NAME}`);
      return r.now;
    } catch { return null; }
  }

  async switchNode(name) {
    // 并发时等待前一次切换完成(而非直接返回 false)
    while (this.switching) {
      await sleep(100);
      // 切换完成后,检查当前节点是否已经是目标节点
      const cur = await this.getCurrentNode();
      if (cur === name) return true;
    }
    this.switching = true;
    try {
      const body = JSON.stringify({ name });
      await this.mihomoApi(`/proxies/${POOL_NAME}`, 'PUT', body);
      await sleep(1000);  // 切换后等 1 秒,确保新节点连接建立
      this.logger('info', `[switch] -> ${name}`);
      return true;
    } catch (e) {
      this.logger('error', `[switch] 失败: ${e.message}`);
      return false;
    } finally {
      this.switching = false;
    }
  }

  mihomoApi(p, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: MIHOMO_CTRL_PORT,
        path: p,
        method,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
        timeout: 5000,
      }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            if (method === 'GET') {
              try { resolve(JSON.parse(data)); }
              catch { resolve({}); }
            } else { resolve({}); }
          } else {
            reject(new Error(`HTTP ${resp.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }

  async restoreLastNode() {
    if (!fs.existsSync(this.lastNodeFile)) return;
    const last = fs.readFileSync(this.lastNodeFile, 'utf8').trim();
    if (!last) return;
    const cur = await this.getCurrentNode();
    if (cur === last) return;
    const nodes = await this.getAllNodes();
    if (nodes.includes(last)) {
      this.logger('info', `[memo] 恢复上次节点: ${last}`);
      await this.switchNode(last);
    }
  }

  saveLastNode(name) {
    try { fs.writeFileSync(this.lastNodeFile, name, 'utf8'); } catch {}
  }

  getUsage() {
    return this.usage.getStats();
  }

  resetUsage() {
    this.usage.reset();
  }

  safe(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { Gateway, FIXED_MODEL };
