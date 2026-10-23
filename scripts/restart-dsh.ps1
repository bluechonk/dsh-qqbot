#Requires -Version 7.0
<#
.SYNOPSIS
    重启 DeepSeek Harness 桌面端（含完整退出与就绪检测）。

.DESCRIPTION
    为什么要整个应用重启，而不是重载插件：

      · 插件代码通过 link: 从 dist/ 加载，而 Node 有**模块缓存**——
        同一路径再次 import 会直接返回缓存，改过的代码不一定生效。
      · QQ 机器人不需要单独重启：它只是插件里的一条 WebSocket 连接，
        由插件自己 bot.start()，插件重新加载时会自己重连。
      · 宿主进程重启 → 必然重新 import 插件 → 一定加载最新 dist/。

    脚本做四件事：
      1. 优雅关闭主窗口，超时则强杀全部相关进程
      2. 等到进程彻底消失（关窗口 ≠ 退出，Electron 常驻托盘）
      3. 重新启动
      4. 等新进程出现、端口就绪，并**等 startup.log 出现新的 apply() 记录**
         —— 这一条才真正证明「插件加载成功了」

.PARAMETER StopTimeoutSec
    优雅关闭的等待秒数，超时后强杀。默认 20。

.PARAMETER ReadyTimeoutSec
    等待插件 apply() 的最长秒数。默认 90（宿主冷启动较慢）。

.PARAMETER ExePath
    可执行文件路径。默认在 %LOCALAPPDATA%\Programs\DeepSeek Harness 下自动查找。

.PARAMETER NoWait
    启动后立即返回，不等待就绪。

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\restart-dsh.ps1

.EXAMPLE
    # 只重启不等待（快速反复调试时用）
    pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\restart-dsh.ps1 -NoWait

.NOTES
    ⚠️ 必须在 DSH **之外**运行（普通终端 / Git Bash）。
    它会杀掉 DSH 进程，包括正在运行的 AI 会话——在 DSH 内部跑等于自杀。
#>
[CmdletBinding()]
param(
    [int]$StopTimeoutSec = 20,
    [int]$ReadyTimeoutSec = 90,
    [string]$ExePath,
    [switch]$NoWait
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 注意：下面所有失败分支都用 Write-Host + exit，**不用 Write-Error**——
# $ErrorActionPreference='Stop' 会让 Write-Error 变成终止性异常，
# 用户看到的是一堆堆栈而不是一句人话。
function Fail([string]$Text) {
    Write-Host "错误：$Text" -ForegroundColor Red
    exit 1
}

# 被 powershell.exe（5.1）调用时直接退出：本脚本用了 PS7 语法
if ($PSVersionTable.PSVersion.Major -lt 7) {
    Fail "需要 PowerShell 7+，当前为 $($PSVersionTable.PSVersion)。请用 pwsh.exe 运行。"
}

$AppName = 'DeepSeek Harness'
$StartupLog = Join-Path $env:USERPROFILE '.dsh-qqbot\startup.log'

function Write-Step([string]$Text) {
    Write-Host "==> $Text" -ForegroundColor Cyan
}
function Write-Ok([string]$Text) {
    Write-Host "    $Text" -ForegroundColor Green
}
function Write-Warn2([string]$Text) {
    Write-Host "    $Text" -ForegroundColor Yellow
}

function Get-DshProcesses {
    Get-Process -Name $AppName -ErrorAction SilentlyContinue
}

# ── 1. 定位可执行文件 ──
if (-not $ExePath) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\$AppName\$AppName.exe"),
        (Join-Path $env:ProgramFiles "$AppName\$AppName.exe")
    )
    $ExePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ExePath -or -not (Test-Path $ExePath)) {
    Fail "找不到 $AppName.exe。请用 -ExePath 指定路径。"
}
Write-Step "可执行文件：$ExePath"

# ── 2. 记录重启前的基线 ──
$logSizeBefore = if (Test-Path $StartupLog) { (Get-Item $StartupLog).Length } else { 0 }
$before = @(Get-DshProcesses)
Write-Step "当前进程数：$($before.Count)"

# ── 3. 优雅关闭，超时强杀 ──
if ($before.Count -gt 0) {
    # 主进程 = 不带 --type 参数的那个
    $main = Get-CimInstance Win32_Process -Filter "Name = '$AppName.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' } |
        Select-Object -First 1

    if ($main) {
        Write-Step "请求主窗口关闭（PID $($main.ProcessId)）"
        try {
            (Get-Process -Id $main.ProcessId -ErrorAction Stop).CloseMainWindow() | Out-Null
        } catch {
            Write-Warn2 "优雅关闭失败，稍后强杀"
        }
    }

    $deadline = (Get-Date).AddSeconds($StopTimeoutSec)
    while ((Get-Date) -lt $deadline -and @(Get-DshProcesses).Count -gt 0) {
        Start-Sleep -Milliseconds 400
    }

    $left = @(Get-DshProcesses)
    if ($left.Count -gt 0) {
        Write-Warn2 "仍有 $($left.Count) 个进程，强制结束"
        $left | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    # 确认彻底退出（关窗口 ≠ 退出）
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline -and @(Get-DshProcesses).Count -gt 0) {
        Start-Sleep -Milliseconds 300
    }
    $remaining = @(Get-DshProcesses).Count
    if ($remaining -gt 0) {
        Fail "仍有 $remaining 个进程未能结束，请手动处理后再试。"
    }
    Write-Ok '已完全退出'
} else {
    Write-Ok '原本没有在运行'
}

# ── 4. 重新启动 ──
Write-Step '启动中…'
Start-Process -FilePath $ExePath | Out-Null

if ($NoWait) {
    Write-Ok '已启动（未等待就绪）'
    exit 0
}

# ── 5. 等进程出现 ──
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline -and @(Get-DshProcesses).Count -eq 0) {
    Start-Sleep -Milliseconds 400
}
$after = @(Get-DshProcesses)
if ($after.Count -eq 0) {
    Fail '启动后 30 秒内没看到进程，可能启动失败。'
}
Write-Ok "进程已出现（$($after.Count) 个）"

# ── 6. 等插件 apply()：这一条才真正证明插件加载成功 ──
Write-Step "等待插件加载（最多 $ReadyTimeoutSec 秒）…"
$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
$applied = $false
while ((Get-Date) -lt $deadline) {
    if (Test-Path $StartupLog) {
        $now = (Get-Item $StartupLog).Length
        if ($now -gt $logSizeBefore) {
            $applied = $true
            break
        }
    }
    Start-Sleep -Milliseconds 500
}

if ($applied) {
    $line = Get-Content $StartupLog -Tail 1
    Write-Ok "插件已加载：$line"
} else {
    Write-Warn2 "等待超时，未见新的 apply() 记录。"
    Write-Warn2 "插件可能没起来，看日志：$StartupLog"
}

# ── 7. 报告监听端口（诊断要用） ──
$pids = (Get-DshProcesses).Id
$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $pids -contains $_.OwningProcess } |
    Select-Object -ExpandProperty LocalPort -Unique | Sort-Object
if ($ports) {
    Write-Ok "监听端口：$($ports -join ', ')"
    Write-Host ''
    Write-Host "  插件状态： curl http://127.0.0.1:$($ports[-1])/qqbot/im-qqbot/bind" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '重启完成。' -ForegroundColor Green
if (-not $applied) { exit 2 }
