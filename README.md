# Zen Free Gateway

本地运行的 AI 编程网关,把 OpenCode Zen 免费模型(`deepseek-v4-flash-free`)包装成 OpenAI 兼容接口,供 Cursor / Cline / Claude Code 等工具接入。

零依赖(仅 Node.js >= 20 内置模块),支持**直连 / HTTP 代理 / SOCKS5 代理**三种出站方式,内嵌密码保护的管理面板。

## 快速开始

### 方式一:直接运行(推荐)

```bash
./start.sh              # 启动网关(前台,Ctrl+C 停止)
./start.sh status       # 查看运行状态
```

首次启动自动生成 API Key 和管理面板密码,打印在终端横幅上,同时写入 `<数据目录>/info.txt`。

### 方式二:从源码运行

```bash
cd desktop-app
node cli.js             # 或 npm start
```

### 方式三:构建单文件可执行程序

```bash
./build.sh              # 需要 bun,产物在 desktop-app/dist/zen-gateway
```

### 方式四:Docker 部署

需要 Docker 与 Docker Compose。配置经 `.env` 传递(含管理面板密码)。

```bash
cp .env.example .env    # 务必修改 ZEN_ADMIN_PASSWORD
docker compose up -d --build
docker compose logs -f  # 查看 API Key 等连接信息
```

- 数据持久化在 Docker 卷 `zen-data`(`config.json` / `usage.json` / `info.txt`)
- 改端口只需改 `.env` 的 `ZEN_PORT`,端口映射自动同步
- 健康检查自动探测 `/health`;停止:`docker compose down`
- 也可直接用 `docker run`:`docker run -d -p 9527:9527 -v zen-data:/data -e ZEN_ADMIN_PASSWORD=xxx zen-gateway`

`.env` 支持的环境变量:

| 变量 | 说明 | 默认 |
|---|---|---|
| `ZEN_PORT` | 网关端口 | `9527` |
| `ZEN_ADMIN_PASSWORD` | 管理面板密码 | 空则首启随机生成 |
| `ZEN_HOST` | 监听地址 | `0.0.0.0` |
| `ZEN_PROXY` | 出站代理 `http:host:port` / `socks5:host:port`(可带 `user:pass@`) | 空=直连 |
| `ZEN_FREE_MODELS` | 免费模型白名单(逗号分隔),覆盖内置默认 | 内置默认列表 |

## 配置代理(重要)

opencode.ai 在境外。如果你没有国际网络,需要配置代理,向 opencode 的请求才会走代理,否则直连。

两种方式配置:

1. **管理面板**(浏览器打开 `http://127.0.0.1:9527`,输入密码登录),在"代理设置"里选直连 / HTTP / SOCKS5,填 host / port / 用户名 / 密码(可选)。
2. **环境变量**(首次启动时写入配置):

```bash
ZEN_PROXY=http:127.0.0.1:7890 ./start.sh            # HTTP 代理
ZEN_PROXY=socks5:127.0.0.1:1080 ./start.sh          # SOCKS5 代理
ZEN_PROXY=http:user:pass@127.0.0.1:7890 ./start.sh  # 带认证
```

支持 HTTP/HTTPS CONNECT 与 SOCKS5(RFC 1928 + 用户名密码认证 RFC 1929)。代理配置修改后**热生效**,无需重启。

## 接入 AI 工具

应用启动后,在 AI 工具中填:

| 字段 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:9527/v1` |
| API Key | 面板或启动横幅显示的 `zen-xxxx` |
| Model | `deepseek-v4-flash-free` |

### 支持的工具

任何支持自定义 OpenAI API 地址的工具:Cursor、Cline、Claude Code、Roo Code、Continue 等。

## 管理面板

浏览器打开 `http://127.0.0.1:9527`,输入管理密码登录后可:

- 查看运行状态(运行时长、请求/token 统计、当前代理模式)
- 设置 API Key
- 设置代理(直连 / HTTP / SOCKS5,含用户名密码认证)
- **增删免费模型白名单**(OpenCode 免费模型会变动,保存后热生效,无需重启)
- 一键测试到上游的连通性与延时

## API 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 无 | 健康检查 |
| GET | `/` | 无 | 管理面板 HTML |
| POST | `/api/login` | 无 | 密码登录,返回 token |
| GET | `/api/config` | token | 查看配置(密码脱敏) |
| PUT | `/api/config` | token | 修改配置 |
| POST | `/api/test` | token | 测试上游连通 |
| GET | `/v1/models` | API Key | 模型列表 |
| POST | `/v1/chat/completions` | API Key | 聊天补全(支持流式) |

### 命令行示例

```bash
# 健康检查
curl http://127.0.0.1:9527/health

# 登录拿 token
TOKEN=$(curl -s -X POST http://127.0.0.1:9527/api/login \
  -H "Content-Type: application/json" \
  -d '{"password":"你的管理密码"}' | node -pe "JSON.parse(require('fs').readFileSync(0)).token")

# 查看配置
curl -s http://127.0.0.1:9527/api/config -H "X-Auth-Token: $TOKEN"

# 切到 HTTP 代理
curl -s -X PUT http://127.0.0.1:9527/api/config -H "X-Auth-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"proxy":{"type":"http","host":"127.0.0.1","port":7890,"username":"","password":""}}'

# 聊天请求
curl http://127.0.0.1:9527/v1/chat/completions \
  -H "Authorization: Bearer 你的APIKey" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}]}'
```

## 工作原理

```
你的 Agent ──▶ 本地网关(:9527) ──▶ 直连 / HTTP代理 / SOCKS5 ──▶ opencode.ai/zen
                    │
                    │ 用量统计采集
                    ▼
               usage.json
```

## 核心特性

- **完全免费**:接入 OpenCode Zen 免费端点,零成本对话
- **抗限流**:向 opencode 的请求带 opencode CLI 请求头(`User-Agent: opencode/...` + `X-Opencode-Client: cli`),规避免费模型限流(429)
- **三种出站方式**:直连 / HTTP(S) CONNECT / SOCKS5,代理支持用户名密码认证
- **OpenAI 协议兼容**:标准 `/v1/chat/completions` + `/v1/models` 接口,支持 SSE 流式
- **Token 用量统计**:实时追踪请求量、输入/输出/推理 token,按天分组,持久化
- **内嵌管理面板**:密码保护,热更 API Key / 代理 / 免费模型白名单,无需重启
- **零依赖**:仅 Node.js 内置模块,单文件可打包(bun)
- **Docker 部署**:零依赖镜像,`.env` 配置,数据卷持久化

## 项目结构

```
zen-proxy/
├── desktop-app/          # 网关主程序(Node.js,零依赖)
│   ├── cli.js            # 入口:启动 / --reload / --print-config
│   ├── config.js         # 配置管理(API Key / 管理密码 / 代理 / 免费模型)
│   ├── gateway.js        # 网关核心:路由 / 鉴权 / 请求转发 / 用量统计
│   ├── proxy.js          # ProxyAgent:直连 / HTTP CONNECT / SOCKS5
│   ├── ui.js             # 内嵌管理面板 HTML
│   └── package.json
├── build.sh              # bun 单文件构建脚本
├── start.sh              # 一键启动脚本(Linux/macOS)
├── Dockerfile            # Docker 镜像
├── docker-compose.yml    # Docker Compose 部署
├── .env.example          # 环境变量示例(复制为 .env 使用)
├── .dockerignore         # 镜像构建排除项
├── worker.js             # Cloudflare Worker 备用方案
└── wrangler.toml         # Cloudflare 部署配置
```

## 常见问题

**Q: 请求一直转圈?**
A: 检查是否配置了代理。若无代理且本机无法直连 opencode.ai,请求会超时。可打开面板点"测试连接"查看延时与错误。

**Q: 频繁 429?**
A: 确认请求头已带 opencode CLI 标识(本网关已内置)。免费端点仍有速率限制,稍后重试。

**Q: 能换付费模型吗?**
A: 网关内置免费模型白名单(默认含 `deepseek-v4-flash-free`、`hy3-free` 等),可在管理面板增删。请求体里的模型若在白名单内则透传,否则回退 `deepseek-v4-flash-free`。如需接入付费模型,修改 `gateway.js` 的 `FIXED_MODEL` 并在 opencode.ai 充值获取正式 API Key。
