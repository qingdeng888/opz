# Zen Free Gateway

本地运行的 AI 编程网关,把 OpenCode Zen 免费模型(`deepseek-v4-flash-free`,即 DeepSeek-V4-Flash-0731)包装成 OpenAI 兼容接口,供 Cursor / Cline / Claude Code 等工具接入。

## 快速开始

### 方式一:直接运行打包版(推荐)

1. 下载 `Zen Free Gateway-1.0.0-win64.zip`,解压
2. 运行 `Zen Free Gateway.exe`
3. 在应用界面的"配置"区域填入你的机场订阅 URL(见下方说明)
4. 点击"保存并应用"
5. 把 Base URL / API Key / Model 填入你的 AI 工具

### 方式二:从源码运行

```bash
cd desktop-app
npm install
npm start
```

### 方式三:重新打包

```bash
cd desktop-app
npm install
npx electron-builder --win zip
# 产物在 desktop-app/dist/
```

## 配置你的机场订阅(重要)

本网关通过 mihomo 代理转发请求到 opencode.ai。你需要有自己的机场(翻墙服务)订阅链接,程序才能正常工作。

### 什么是订阅链接

订阅链接是一段 URL,你的机场(代理服务商)会提供给你。它通常长这样:

```
https://你的机场域名.com/api/v1/client/subscribe?token=xxxxx
```

或者 Clash 专用的:

```
https://你的机场域名.com/api/v1/client/subscribe?token=xxxxx&flag=clash
```

### 如何获取

1. 登录你的机场网站(购买代理服务后会有面板)
2. 找到"一键订阅"或"订阅链接"页面
3. 复制 **Clash** 格式的订阅链接(不是 v2ray 的)

常见机场面板的获取路径:
- **Clash 面板型**:首页 → 复制订阅链接
- **V2Board 型**:订阅页面 → Clash → 复制链接
- **通用型**:找带 `clash` 或 `yaml` 字样的订阅链接

### 填入程序

1. 打开 Zen Free Gateway
2. 在"配置"区域找到"订阅 URL"输入框
3. 粘贴你的订阅链接
4. 点击"保存并应用"

程序会自动:
- 拉取订阅,解析节点列表
- 生成 mihomo 配置(独立实例,不影响你的 Clash Verge 等软件)
- 启动代理,将请求通过你的节点转发到 opencode.ai

### 验证是否生效

保存后,在"代理状态"区域应该看到:
- mihomo: 运行中
- 节点数: > 0

然后发一个测试请求:

```bash
curl http://127.0.0.1:9527/v1/chat/completions \
  -H "Authorization: Bearer 你的APIKey" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash-free","messages":[{"role":"user","content":"hi"}]}'
```

如果返回正常的 AI 回复,说明配置成功。

### 没有机场怎么办

本程序**必须**有代理节点才能工作(opencode.ai 在境外)。如果没有机场:
- 免费机场通常不稳定,不推荐用于生产
- 推荐购买正规付费机场,月费 10-30 元即可
- 也可以用自建的 V2Ray/Xray 节点,手动编写 Clash 配置

## 接入 AI 工具

应用启动且配置好订阅后,在 AI 工具中填:

| 字段 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:9527/v1` |
| API Key | 应用界面显示的 `zen-xxxx` |
| Model | `deepseek-v4-flash-free` |

### 支持的工具

任何支持自定义 OpenAI API 地址的工具:
- Cursor
- Cline (VS Code 插件)
- Claude Code
- Roo Code
- Continue
- 其他 OpenAI 兼容客户端

## 工作原理

```
你的 Agent ──▶ 本地网关(:9527) ──▶ mihomo代理(:17897) ──▶ opencode.ai/zen
                   │                      │
                   │ 429自动切节点          │ 你的机场节点池
                   │ 用量统计采集           │
                   ▼                      ▼
              usage.json            日本/新加坡/美国等节点
```

## 核心特性

- **完全免费**:接入 OpenCode Zen 免费端点,零成本无限对话
- **自动抗限流**:429 自动切换代理节点,90 秒冷却恢复,调用方无感知
- **OpenAI 协议兼容**:标准 `/v1/chat/completions` + `/v1/models` 接口
- **Token 用量统计**:实时追踪请求量、输入/输出/推理 token,按天分组,持久化
- **一键重置**:额度耗尽时重新拉订阅 + 重启代理 + 清空冷却
- **独立 mihomo 实例**:不干扰你已有的 Clash Verge / v2ray 等软件

## 项目结构

```
zen-proxy/
├── desktop-app/          # Electron 桌面应用(主程序)
│   ├── main.js           # 主进程:窗口/IPC/生命周期
│   ├── gateway.js        # 网关核心:请求转发/429切换/用量统计
│   ├── config.js         # 配置管理 + 订阅处理
│   ├── mihomo.js         # mihomo 代理进程管理
│   ├── preload.js        # IPC 桥接
│   ├── renderer/         # 渲染进程(UI)
│   │   ├── index.html
│   │   └── renderer.js
│   ├── resources/        # 内置 mihomo 内核 + GeoIP 数据
│   └── package.json
├── gen-zen-config.py     # 从订阅生成 mihomo 配置的独立脚本
├── worker.js             # Cloudflare Worker 备用方案
└── wrangler.toml         # Cloudflare 部署配置
```

## 技术栈

Electron + Node.js + mihomo 代理内核,Windows 平台,解压即用。

## 常见问题

**Q: 提示"无节点可用"?**
A: 检查订阅 URL 是否正确填入配置,保存后看日志是否成功拉取节点。

**Q: 请求一直转圈?**
A: deepseek-v4-flash-free 默认开启 thinking 模式,复杂问题会先内部推理,耐心等待。简单问题通常 3-5 秒。

**Q: 频繁 429?**
A: 免费端点有速率限制。节点越多越好,程序会自动轮换 IP。点击标题栏"手动重置"可清空冷却状态重新开始。

**Q: 能用付费模型吗?**
A: 当前版本固定使用 `deepseek-v4-flash-free`。如需付费模型,需要修改 `gateway.js` 中的 `FIXED_MODEL` 并在 opencode.ai 充值获取正式 API Key。
