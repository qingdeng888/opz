<#
.SYNOPSIS
    zen-proxy 专用独立 mihomo 实例管理器
    与 Clash Verge 完全隔离:独立端口 17897(代理)/ 19090(API),不动系统代理。
#>
param(
    [switch]$Start,
    [switch]$Stop,
    [switch]$Status,
    [switch]$Restart
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$mhExe = "D:\Program Files\Clash Verge\verge-mihomo.exe"
$config = Join-Path $scriptDir "mihomo-zen.yaml"
$dataDir = Join-Path $scriptDir "mihomo-data"
$logFile = Join-Path $dataDir "mihomo-zen.log"
$errFile = Join-Path $dataDir "mihomo-zen.err.log"
$pidFile = Join-Path $dataDir "mihomo-zen.pid"

$MIXED_PORT = 17897
$CTRL_PORT = 19090

function Test-MihomoRunning {
    $conn = Get-NetTCPConnection -LocalPort $MIXED_PORT -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) { return $false }
    $proc = Get-Process -Id $conn[0].OwningProcess -ErrorAction SilentlyContinue
    if (-not $proc) { return $false }
    # 确认是 mihomo 进程,不是别的程序误占
    if ($proc.ProcessName -notmatch "mihomo|verge-mihomo") { return $false }
    return $true
}

function Get-MihomoPid {
    $conn = Get-NetTCPConnection -LocalPort $MIXED_PORT -State Listen -ErrorAction SilentlyContinue
    if ($conn) { return $conn[0].OwningProcess }
    return $null
}

function Copy-GeoFiles {
    # 从 Clash Verge 数据目录复制 geo 文件,避免 mihomo 首次启动下载
    $cvDir = "$env:APPDATA\io.github.clash-verge-rev.clash-verge-rev"
    if (-not (Test-Path $cvDir)) { return }
    $geoFiles = @("Country.mmdb", "geoip.dat", "geosite.dat")
    foreach ($f in $geoFiles) {
        $src = Join-Path $cvDir $f
        $dst = Join-Path $dataDir $f
        if ((Test-Path $src) -and -not (Test-Path $dst)) {
            try {
                Copy-Item -Path $src -Destination $dst -Force -ErrorAction Stop
                Write-Host "    复制 $f OK" -ForegroundColor DarkGray
            } catch {}
        }
    }
}

function Start-ZenMihomo {
    if (-not (Test-Path $mhExe)) {
        Write-Host "[X] 找不到 verge-mihomo.exe: $mhExe" -ForegroundColor Red
        Write-Host "    请确认 Clash Verge 安装路径" -ForegroundColor Yellow
        return $false
    }
    if (-not (Test-Path $config)) {
        Write-Host "[X] 找不到配置: $config" -ForegroundColor Red
        Write-Host "    请先运行: python gen-zen-config.py" -ForegroundColor Yellow
        return $false
    }

    if (Test-MihomoRunning) {
        $pid_ = Get-MihomoPid
        Write-Host "[OK] zen-mihomo 已在运行 (PID $pid_)" -ForegroundColor Green
        Write-Host "     代理: http://127.0.0.1:$MIXED_PORT" -ForegroundColor Gray
        Write-Host "     API : http://127.0.0.1:$CTRL_PORT" -ForegroundColor Gray
        return $true
    }

    if (-not (Test-Path $dataDir)) {
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    }

    # 复制 geo 文件(避免首次启动卡在下载 MMDB)
    Copy-GeoFiles

    Write-Host "[..] 启动 zen-mihomo..." -ForegroundColor Cyan
    # 注意:路径含空格(opencode -free),必须用单字符串 + 引号,不能用数组
    $argStr = "-d `"$dataDir`" -f `"$config`""
    $p = Start-Process -FilePath $mhExe -ArgumentList $argStr `
        -WorkingDirectory $dataDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError $errFile `
        -PassThru

    # 等待端口起来(首次可能要加载 geo,给足时间)
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-MihomoRunning) { $ok = $true; break }
    }

    if (-not $ok) {
        Write-Host "[X] 启动失败,端口 $MIXED_PORT 未监听" -ForegroundColor Red
        Write-Host "    日志: $logFile" -ForegroundColor Yellow
        if (Test-Path $errFile) {
            Write-Host "--- 错误日志 ---" -ForegroundColor DarkGray
            Get-Content $errFile -Tail 20 -ErrorAction SilentlyContinue
        }
        if (Test-Path $logFile) {
            Write-Host "--- 标准输出日志 ---" -ForegroundColor DarkGray
            Get-Content $logFile -Tail 20 -ErrorAction SilentlyContinue
        }
        return $false
    }

    $actualPid = Get-MihomoPid
    Set-Content -Path $pidFile -Value $actualPid -Encoding ascii
    Write-Host "[OK] zen-mihomo 已启动 (PID $actualPid)" -ForegroundColor Green
    Write-Host "     代理: http://127.0.0.1:$MIXED_PORT" -ForegroundColor Gray
    Write-Host "     API : http://127.0.0.1:$CTRL_PORT" -ForegroundColor Gray
    Write-Host "     日志: $logFile" -ForegroundColor DarkGray
    return $true
}

function Stop-ZenMihomo {
    if (-not (Test-MihomoRunning)) {
        Write-Host "[OK] zen-mihomo 未在运行" -ForegroundColor Yellow
        return $true
    }
    $pid_ = Get-MihomoPid
    Write-Host "[..] 停止 zen-mihomo (PID $pid_)..." -ForegroundColor Cyan
    try {
        Stop-Process -Id $pid_ -Force -ErrorAction Stop
        Start-Sleep -Milliseconds 500
    } catch {}
    if (Test-MihomoRunning) {
        Write-Host "[X] 停止失败" -ForegroundColor Red
        return $false
    }
    Write-Host "[OK] 已停止" -ForegroundColor Green
    return $true
}

function Show-Status {
    if (Test-MihomoRunning) {
        $pid_ = Get-MihomoPid
        Write-Host "[OK] zen-mihomo 运行中 (PID $pid_)" -ForegroundColor Green
        Write-Host "     代理: http://127.0.0.1:$MIXED_PORT" -ForegroundColor Gray
        Write-Host "     API : http://127.0.0.1:$CTRL_PORT" -ForegroundColor Gray

        # 试着查 API
        try {
            $ver = Invoke-RestMethod -Uri "http://127.0.0.1:$CTRL_PORT/version" -TimeoutSec 3
            Write-Host "     版本: $($ver.version)" -ForegroundColor DarkGray
        } catch {}

        # 当前选中的节点
        try {
            $pr = Invoke-RestMethod -Uri "http://127.0.0.1:$CTRL_PORT/proxies/zen-pool" -TimeoutSec 3
            Write-Host "     当前节点: $($pr.now)" -ForegroundColor Cyan
            Write-Host "     节点总数: $($pr.all.Count)" -ForegroundColor DarkGray
        } catch {}
        return $true
    } else {
        Write-Host "[--] zen-mihomo 未运行" -ForegroundColor Yellow
        return $false
    }
}

# ---- 主入口 ----
if ($Status) { Show-Status; return }
if ($Stop) { Stop-ZenMihomo; return }
if ($Restart) { Stop-ZenMihomo; Start-Sleep -Milliseconds 800; Start-ZenMihomo; return }
# 默认 = Start
if ($Start -or (-not ($Status -or $Stop -or $Restart))) {
    Start-ZenMihomo
    return
}
