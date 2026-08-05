<#
.SYNOPSIS
    OpenCode Zen Free API 工具(带 IP 轮换自动重置)
    直接 POST opencode.ai/zen/v1/chat/completions,通过独立 mihomo 实例换 IP 绕过 429 限流。
    只用 deepseek-v4-flash-free 一个免费模型。
#>
param(
    [Alias("q")][string]$Message,
    [Alias("m")][string]$Model = "deepseek-v4-flash-free",
    [Alias("t")][int]$MaxTokens = 1024,
    [switch]$Interactive,
    [switch]$ListFree,
    [switch]$Status,
    [switch]$NoEnsureMihomo
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---- 配置 ----
$ENDPOINT = "https://opencode.ai/zen/v1/chat/completions"
$MIHOMO_PROXY = "http://127.0.0.1:17897"
$MIHOMO_API = "http://127.0.0.1:19090"
$POOL_NAME = "zen-pool"
$MODEL = if ($Model) { $Model } else { "deepseek-v4-flash-free" }
$SWITCH_DELAY_MS = 500   # 切节点后等待连接建立
$REQ_TIMEOUT_S = 30      # 单节点请求超时(成功响应通常 <20s,超时说明节点不通)
$MAX_NODE_TRIES = 0      # 0 = 遍历所有节点;>0 = 最多试这么多
$LAST_NODE_FILE = Join-Path $scriptDir "last-node.txt"  # 记忆上次成功节点

# 免费模型白名单(都用同一个端点)
$FreeModels = @(
    "deepseek-v4-flash-free",
    "big-pickle",
    "mimo-v2.5-free",
    "laguna-s-2.1-free",
    "ling-3.0-flash-free",
    "north-mini-code-free",
    "nemotron-3-ultra-free"
)

# ---- 工具函数 ----
function Write-Info { param($Msg) Write-Host $Msg -ForegroundColor DarkGray }
function Write-OK   { param($Msg) Write-Host $Msg -ForegroundColor Green }
function Write-Warn { param($Msg) Write-Host $Msg -ForegroundColor Yellow }
function Write-Err  { param($Msg) Write-Host $Msg -ForegroundColor Red }

function Ensure-MihomoRunning {
    $conn = Get-NetTCPConnection -LocalPort 17897 -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $proc = Get-Process -Id $conn[0].OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match "mihomo|verge-mihomo") { return $true }
    }
    Write-Warn "[!] zen-mihomo 未运行,自动启动..."
    $mgr = Join-Path $scriptDir "zen-mihomo-manager.ps1"
    if (-not (Test-Path $mgr)) {
        Write-Err "[X] 找不到管理脚本: $mgr"
        return $false
    }
    & $mgr -Start | Out-Null
    Start-Sleep -Milliseconds 500
    $conn = Get-NetTCPConnection -LocalPort 17897 -State Listen -ErrorAction SilentlyContinue
    return [bool]$conn
}

function Get-AllNodes {
    try {
        $pr = Invoke-RestMethod -Uri "$MIHOMO_API/proxies/$POOL_NAME" -TimeoutSec 5 -ErrorAction Stop
        return $pr.all
    } catch {
        Write-Err "[X] 无法获取节点列表: $_"
        return @()
    }
}

function Get-CurrentNode {
    try {
        $pr = Invoke-RestMethod -Uri "$MIHOMO_API/proxies/$POOL_NAME" -TimeoutSec 5 -ErrorAction Stop
        return $pr.now
    } catch { return $null }
}

function Switch-Node {
    param([string]$Node)
    try {
        $body = @{ name = $Node } | ConvertTo-Json
        Invoke-RestMethod -Uri "$MIHOMO_API/proxies/$POOL_NAME" -Method Put -Body $body -ContentType "application/json" -TimeoutSec 5 -ErrorAction Stop | Out-Null
        Start-Sleep -Milliseconds $SWITCH_DELAY_MS
        return $true
    } catch {
        return $false
    }
}

function Restore-LastNode {
    # 优先切到上次成功的节点,避免每次从头遍历
    if (-not (Test-Path $LAST_NODE_FILE)) { return }
    $last = (Get-Content $LAST_NODE_FILE -Raw -ErrorAction SilentlyContinue).Trim()
    if (-not $last) { return }
    $cur = Get-CurrentNode
    if ($cur -eq $last) { return }  # 已经在这个节点了
    $nodes = Get-AllNodes
    if ($nodes -contains $last) {
        Write-Info "  [memo] 优先用上次成功节点: $last"
        Switch-Node -Node $last | Out-Null
    }
}

function Save-LastNode {
    param([string]$Node)
    try {
        Set-Content -Path $LAST_NODE_FILE -Value $Node -Encoding utf8 -ErrorAction Stop
    } catch {}
}

# ---- 核心请求函数:带 IP 轮换 ----
function Invoke-ZenChat {
    param([string]$Question, [string]$ChatModel, [int]$Tokens)

    $body = @{
        model = $ChatModel
        messages = @(@{ role = "user"; content = $Question })
        max_tokens = [Math]::Min($Tokens, 8192)
        stream = $false
    } | ConvertTo-Json -Depth 5

    $headers = @{
        "Content-Type" = "application/json"
        "Accept" = "*/*"
        "User-Agent" = "node"
    }

    # 收集"本次已试过且 429"的节点,避免重复
    $tried429 = @{}
    $triedCount = 0
    $nodes = Get-AllNodes
    if ($nodes.Count -eq 0) {
        return @{ ok = $false; error = "无法获取节点列表" }
    }

    # 优先恢复上次成功的节点(加速首次命中)
    Restore-LastNode

    # 第一次用当前节点试
    while ($true) {
        $triedCount++
        if ($MAX_NODE_TRIES -gt 0 -and $triedCount -gt $MAX_NODE_TRIES) {
            return @{ ok = $false; error = "已试 $MAX_NODE_TRIES 个节点仍被限流" }
        }
        if ($triedCount -gt $nodes.Count) {
            return @{ ok = $false; error = "全部 $($nodes.Count) 个节点都被限流,请稍后再试" }
        }

        $cur = Get-CurrentNode
        if (-not $cur) {
            return @{ ok = $false; error = "无法读取当前节点" }
        }

        try {
            $r = Invoke-RestMethod -Uri $ENDPOINT -Method Post -Headers $headers -Body $body -Proxy $MIHOMO_PROXY -TimeoutSec $REQ_TIMEOUT_S -ErrorAction Stop
            Save-LastNode -Node $cur
            return @{
                ok = $true
                content = $r.choices[0].message.content
                reasoning = $r.choices[0].message.reasoning_content
                model = $r.model
                tokens = $r.usage.total_tokens
                node = $cur
            }
        } catch {
            $status = 0
            if ($_.Exception.Response) { $status = $_.Exception.Response.StatusCode.value__ }

            if ($status -eq 429) {
                # 限流:标记并切换到下一个未试过的节点
                $tried429[$cur] = $true
                $next = $nodes | Where-Object { -not $tried429.ContainsKey($_) } | Select-Object -First 1
                if (-not $next) {
                    return @{ ok = $false; error = "全部 $($nodes.Count) 个节点都被限流(429)" }
                }
                Write-Info "  [429] $cur 限流,切到: $next"
                if (-not (Switch-Node -Node $next)) {
                    $tried429[$next] = $true
                    continue
                }
                continue
            } elseif ($status -eq 0) {
                # 连接超时/网络错误:可能是节点不通,切下一个
                $tried429[$cur] = $true
                $next = $nodes | Where-Object { -not $tried429.ContainsKey($_) } | Select-Object -First 1
                if (-not $next) {
                    return @{ ok = $false; error = "节点连接失败且无更多节点" }
                }
                Write-Info "  [超时] $cur 不通,切到: $next"
                if (-not (Switch-Node -Node $next)) { $tried429[$next] = $true; continue }
                continue
            } else {
                # 其他 HTTP 错误(400/500 等):不切节点,直接返回
                $detail = ""
                if ($_.ErrorDetails) { $detail = $_.ErrorDetails.Message }
                return @{ ok = $false; error = "HTTP $status - $detail" }
            }
        }
    }
}

# ---- 状态查询 ----
function Show-Status {
    Write-Host "=== zen-proxy 状态 ===" -ForegroundColor Cyan
    $running = Ensure-MihomoRunning
    if (-not $running) {
        Write-Err "mihomo 未运行"
        return
    }
    $cur = Get-CurrentNode
    $nodes = Get-AllNodes
    Write-OK "mihomo: 运行中"
    Write-Info "代理: $MIHOMO_PROXY"
    Write-Info "API : $MIHOMO_API"
    Write-Info "端点: $ENDPOINT"
    Write-Info "模型: $MODEL"
    Write-Info "当前节点: $cur"
    Write-Info "节点总数: $($nodes.Count)"

    # 测试当前节点是否能通
    Write-Host ""
    Write-Host "测试当前节点连通性..." -ForegroundColor Cyan
    $r = Invoke-ZenChat -Question "ping" -ChatModel $MODEL -Tokens 10
    if ($r.ok) {
        Write-OK "当前节点可用,响应: $($r.content) (tokens=$($r.tokens))"
    } else {
        Write-Warn "当前节点不可用: $($r.error)"
        Write-Host "提示: 用 -q 发消息时会自动切换可用节点" -ForegroundColor DarkGray
    }
}

# ---- 列出免费模型 ----
if ($ListFree) {
    Write-Host "免费模型(opencode.ai/zen/v1/chat/completions):" -ForegroundColor Green
    foreach ($m in $FreeModels) {
        $mark = if ($m -eq $MODEL) { " *" } else { "  " }
        Write-Host "$mark $m"
    }
    Write-Host ""
    Write-Info "当前选择: $MODEL"
    Write-Info "端点: $ENDPOINT"
    return
}

# ---- 状态 ----
if ($Status) { Show-Status; return }

# ---- 确保 mihomo 在跑 ----
if (-not $NoEnsureMihomo) {
    if (-not (Ensure-MihomoRunning)) {
        Write-Err "[X] 无法启动 zen-mihomo,请手动运行: .\zen-mihomo-manager.ps1 -Start"
        return
    }
}

# ---- 单次问答模式 ----
if ($Message) {
    $result = Invoke-ZenChat -Question $Message -ChatModel $MODEL -Tokens $MaxTokens
    if ($result.ok) {
        if ($result.reasoning) {
            Write-Host "[think] " -NoNewline -ForegroundColor DarkGray
            Write-Host $result.reasoning -ForegroundColor DarkGray
        }
        Write-Output $result.content
        Write-Host "--- [" -NoNewline -ForegroundColor DarkGray
        Write-Host $result.model -NoNewline -ForegroundColor DarkGray
        Write-Host "] tokens:" -NoNewline -ForegroundColor DarkGray
        Write-Host $result.tokens -NoNewline -ForegroundColor DarkGray
        Write-Host " node:" -NoNewline -ForegroundColor DarkGray
        Write-Host $result.node -ForegroundColor DarkGray
    } else {
        Write-Err "ERROR: $($result.error)"
    }
    return
}

# ---- 交互模式 ----
if ($Interactive) {
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  OpenCode Zen Free Chat (IP 自动轮换)" -ForegroundColor Cyan
    Write-Host "  模型: $MODEL" -ForegroundColor DarkGray
    Write-Host "  429 时自动切节点重置额度" -ForegroundColor DarkGray
    Write-Host "  命令: /models /model <name> /status q" -ForegroundColor DarkGray
    Write-Host "========================================" -ForegroundColor Cyan

    $history = @()
    while ($true) {
        Write-Host ""
        $input = Read-Host "[$MODEL] >>"
        if ($input -eq "quit" -or $input -eq "exit" -or $input -eq "q") { break }
        if ($input -eq "/models") {
            Write-Host "免费模型:" -ForegroundColor Yellow
            foreach ($m in $FreeModels) {
                $mark = if ($m -eq $MODEL) { " *" } else { "  " }
                Write-Host "$mark $m" -ForegroundColor Gray
            }
            continue
        }
        if ($input -match "^/model (.+)$") {
            $MODEL = $matches[1]
            Write-OK "切换模型: $MODEL"
            continue
        }
        if ($input -eq "/status") { Show-Status; continue }
        if ($input.Trim() -eq "") { continue }

        $history += ">>> $input"
        $result = Invoke-ZenChat -Question $input -ChatModel $MODEL -Tokens $MaxTokens
        if ($result.ok) {
            if ($result.reasoning) {
                Write-Host "[think] $($result.reasoning)" -ForegroundColor DarkGray
            }
            if ($result.content) {
                Write-Host ""
                Write-Host $result.content
                $history += $result.content
            }
            Write-Host "--- [$($result.model)] $($result.tokens) tokens [$($result.node)]" -ForegroundColor DarkGray
        } else {
            Write-Err "[!] $($result.error)"
        }
    }
    Write-Host "Bye!" -ForegroundColor Cyan
    return
}

# ---- 帮助 ----
$help = @"
zen.ps1 - OpenCode Zen Free (IP 自动轮换版)

用法:
  .\zen.ps1 -q "你的问题"                  单次问答(429 自动切节点)
  .\zen.ps1 -q "问题" -m deepseek-v4-flash-free  指定模型
  .\zen.ps1 -q "问题" -t 500               设置 max_tokens
  .\zen.ps1 -Interactive                   交互式聊天
  .\zen.ps1 -ListFree                      列出免费模型
  .\zen.ps1 -Status                        查看 mihomo/节点状态

工作原理:
  1. 通过独立 mihomo 实例(端口 17897)POST opencode.ai/zen/v1/chat/completions
  2. 遇到 429(额度用完)自动切换到下一个节点(换 IP = 重置额度)
  3. 遍历节点直到成功,几乎无感重置

依赖:
  - zen-mihomo-manager.ps1  管理 mihomo 实例(自动启动)
  - mihomo-zen.yaml         独立配置(端口 17897/19090)
  - gen-zen-config.py       从订阅生成配置

端点: $ENDPOINT
代理: $MIHOMO_PROXY
"@
Write-Host $help -ForegroundColor Gray
