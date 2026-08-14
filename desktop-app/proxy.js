/**
 * proxy.js - ProxyAgent(核心)
 *
 * 支持三种出站方式,统一对 gateway 暴露为 https.Agent:
 *   - none  : 直连目标(opencode.ai:443),本地 DNS
 *   - http  : HTTP CONNECT 隧道(可选 Basic 认证)
 *   - socks5: SOCKS5 隧道(RFC 1928 + 用户名密码认证 RFC 1929)
 *
 * 实现方式:继承 https.Agent,只重写 createConnection(options, cb)。
 * 先建立到「目标或代理」的 TCP 连接,完成 CONNECT/SOCKS5 握手后,
 * 用 tls.connect({socket: raw, ...}) 在同一 socket 上套 TLS。
 * 域名由代理远端 DNS 解析(规避本地 DNS 污染),SNI 仍是目标域名。
 *
 * 零新增依赖:net / tls / crypto 均为 Node 内置。
 */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const https = require('https');

const HANDSHAKE_TIMEOUT = 15000;   // 握手/连接超时
const CRLF = '\r\n';

/** 包装回调,保证只触发一次 */
function cbOnce(cb) {
  let done = false;
  return (...args) => {
    if (done) return;
    done = true;
    cb(...args);
  };
}

/**
 * 从 socket 累积读取恰好 n 字节,把溢出的字节 unshift 回读缓冲。
 * 防止代理回包首包就混入 TLS 字节时被 `data` 事件吞掉。
 */
function readN(raw, n, cb) {
  const done = cbOnce(cb);
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length >= n) {
      raw.removeListener('data', onData);
      const need = buf.subarray(0, n);
      const extra = buf.subarray(n);
      if (extra.length) raw.unshift(extra);
      done(null, need);
    }
  };
  raw.on('data', onData);
  raw.on('error', (e) => { raw.removeListener('data', onData); done(e); });
}

// ---- 认证编码 ----

function basicAuth(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

/** SOCKS5 ATYP 地址编码:RFC 1928 4.1 节 */
function encodeSocksAddr(host) {
  // IPv6
  if (host.includes(':')) {
    const b = net.isIP(host);
    if (b === 6) return Buffer.concat([Buffer.from([0x04]), parseIPv6(host)]);
    // 带端口的裸 IPv6 之类,交给域名编码兜底
  }
  // IPv4
  if (net.isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    return Buffer.concat([Buffer.from([0x01]), Buffer.from(parts)]);
  }
  // 域名
  const h = Buffer.from(host, 'utf8');
  return Buffer.concat([Buffer.from([0x03, h.length]), h]);
}

function parseIPv6(host) {
  const groups = host.split(':');
  const out = Buffer.alloc(16);
  let i = 0;
  // 处理 :: 压缩
  const dbl = groups.indexOf('');
  let idx = 0;
  if (dbl >= 0) {
    const head = groups.slice(0, dbl).filter(x => x !== '');
    const tail = groups.slice(dbl + 1).filter(x => x !== '');
    for (const g of head) {
      out.writeUInt16BE(parseInt(g || '0', 16) || 0, idx);
      idx += 2;
    }
    const skip = 16 - tail.length * 2 - idx;
    idx += skip;
    for (const g of tail) {
      out.writeUInt16BE(parseInt(g || '0', 16) || 0, idx);
      idx += 2;
    }
  } else {
    for (const g of groups) {
      out.writeUInt16BE(parseInt(g || '0', 16) || 0, idx);
      idx += 2;
    }
  }
  return out;
}

class ProxyAgent extends https.Agent {
  /**
   * @param {object} proxy  {type, host, port, username, password}
   * @param {object} opts   https.Agent 选项(可覆盖默认)
   */
  constructor(proxy, opts = {}) {
    super({
      keepAlive: true,
      maxSockets: 16,
      keepAliveMsecs: 30000,
      rejectUnauthorized: false,
      ...opts,
    });
    this.proxy = proxy;
  }

  /** https.request 会调用 createConnection(options, cb) 建立底层连接 */
  createConnection(options, callback) {
    const cb = cbOnce(callback);
    const targetHost = options.servername || options.host;
    const targetPort = options.port || 443;
    const type = this.proxy && this.proxy.type;

    // 直连
    if (type === 'none' || !type) {
      const raw = net.connect({ host: targetHost, port: targetPort });
      raw.once('error', cb);
      raw.once('connect', () => this._handoffToTls(raw, targetHost, options, cb));
      return; // 不返回裸 socket,避免 Node 提前使用未握手的连接
    }

    // 走代理:先连代理,再握手
    const p = this.proxy;
    const proxyPort = p.port || (type === 'socks5' ? 1080 : 3128);
    const raw = net.connect({ host: p.host, port: proxyPort });
    raw.setTimeout(HANDSHAKE_TIMEOUT);
    raw.once('error', cb);
    raw.once('timeout', () => {
      raw.destroy(new Error('代理连接超时'));
    });
    raw.once('connect', () => {
      if (type === 'http') this._httpConnect(raw, targetHost, targetPort, p, options, cb);
      else if (type === 'socks5') this._socks5(raw, targetHost, targetPort, p, options, cb);
      else {
        raw.destroy(new Error('未知代理类型: ' + type));
      }
    });
    return; // 不返回裸 socket,Node 只认回调返回的握手完成 socket
  }

  /** 底层 socket 就绪(隧道已建立),套上 TLS 后交给 https */
  _handoffToTls(raw, targetHost, options, cb) {
    raw.setTimeout(0); // 清掉握手超时,勿杀长连接
    try {
      const tlsSocket = tls.connect({
        socket: raw,
        servername: targetHost,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      });
      tlsSocket.once('error', cb);
      cb(null, tlsSocket);
    } catch (e) {
      cb(e);
    }
  }

  /** HTTP CONNECT 隧道(RFC 7231) */
  _httpConnect(raw, host, port, p, options, cb) {
    const reqHead = [
      `CONNECT ${host}:${port} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Proxy-Connection: Keep-Alive',
    ];
    if (p.username) {
      reqHead.push(`Proxy-Authorization: ${basicAuth(p.username, p.password)}`);
    }
    reqHead.push('', '');

    let statusLine = '';
    let headerBuf = Buffer.alloc(0);
    const onData = (chunk) => {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf(CRLF + CRLF);
      if (idx === -1) return;
      raw.removeListener('data', onData);
      statusLine = headerBuf.subarray(0, headerBuf.indexOf(CRLF)).toString('utf8');
      const body = headerBuf.subarray(idx + 4);
      if (/^\s*HTTP\/1\.[01] 200/i.test(statusLine)) {
        if (body.length) raw.unshift(body); // 残余字节还给 TLS
        this._handoffToTls(raw, host, options, cb);
      } else {
        const code = statusLine.split(' ')[1];
        if (code === '407') {
          raw.destroy(new Error('代理要求认证(407),请检查用户名密码'));
        } else {
          raw.destroy(new Error('代理 CONNECT 失败: ' + statusLine));
        }
      }
    };
    raw.on('data', onData);
    raw.write(reqHead.join(CRLF));
  }

  /** SOCKS5 隧道(RFC 1928 + 1929) */
  _socks5(raw, host, port, p, options, cb) {
    const doConnect = () => {
      const addr = encodeSocksAddr(host);
      const portBuf = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
      raw.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));

      readN(raw, 4, (err, rep) => {
        if (err) return cb(err);
        if (rep[1] !== 0x00) {
          const reason = {
            1: '通用失败', 2: '规则不允许', 3: '网络不可达',
            4: '主机不可达', 5: '连接被拒', 6: 'TTL 超时',
            7: '命令不支持', 8: '地址类型不支持',
          }[rep[1]] || `错误码 ${rep[1]}`;
          return raw.destroy(new Error(`SOCKS5 连接失败: ${reason}`));
        }
        // REP=0 成功,读 BND.ADDR+BND.PORT(隧道后不再关心其内容)
        const atype = rep[3];
        const tailLen = atype === 0x01 ? 6 : (atype === 0x04 ? 18 : (atype === 0x03 ? 1 + 1 + 2 : 0));
        if (!tailLen) return raw.destroy(new Error('SOCKS5 BND 地址类型未知: 0x' + atype.toString(16)));
        readN(raw, tailLen, (err2) => {
          if (err2) return cb(err2);
          this._handoffToTls(raw, host, options, cb);
        });
      });
    };

    // 方法协商
    const methods = p.username ? [0x00, 0x02] : [0x00];
    raw.write(Buffer.from([0x05, methods.length, ...methods]));
    readN(raw, 2, (err, resp) => {
      if (err) return cb(err);
      if (resp[0] !== 0x05) return raw.destroy(new Error('SOCKS5 版本协商失败'));
      const method = resp[1];
      if (method === 0xff) return raw.destroy(new Error('SOCKS5 无可接受的认证方式'));

      if (method === 0x02) {
        // RFC 1929 用户名/密码子协商
        const u = Buffer.from(p.username || '', 'utf8');
        const pw = Buffer.from(p.password || '', 'utf8');
        if (u.length > 255 || pw.length > 255) return raw.destroy(new Error('SOCKS5 用户名/密码过长'));
        raw.write(Buffer.concat([
          Buffer.from([0x01, u.length]), u,
          Buffer.from([pw.length]), pw,
        ]));
        readN(raw, 2, (err2, authResp) => {
          if (err2) return cb(err2);
          if (authResp[1] !== 0x00) return raw.destroy(new Error('SOCKS5 用户名密码认证失败'));
          doConnect();
        });
      } else if (method === 0x00) {
        doConnect();
      } else {
        return raw.destroy(new Error('SOCKS5 服务器要求未知认证方式: 0x' + method.toString(16)));
      }
    });
  }
}

module.exports = { ProxyAgent };
