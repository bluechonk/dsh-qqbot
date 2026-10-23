#Requires -Version 7.0
<#
.SYNOPSIS
    dsh-qqbot 插件层状态一键快照。

.DESCRIPTION
    排查「机器人不回话」时最费时的是到处翻日志。这个脚本一次把所有相关状态打出来：
    插件是否加载、机器人是否连上、生效配置、门控判定、群友档案、未知网关事件。

    它是**只读**的：不修改任何文件，不重启任何进程。

.PARAMETER Tail
    每个日志文件打印多少行。默认 8。

.PARAMETER Full
    打印完整日志（可能很长），默认只看尾部。

.EXAMPLE
    pwsh -NoProfile -ExecutionPolicy Bypass -File .agents\skills\qqbot-log-triage\scripts\qqbot-state.ps1

.EXAMPLE
    # 门控判定要看多几行
    pwsh -NoProfile -ExecutionPolicy Bypass -File .agents\skills\qqbot-log-triage\scripts\qqbot-state.ps1 -Tail 30
#>
[CmdletBinding()]
param(
    [int]$Tail = 8,
    [switch]$Full
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$AppName = 'DeepSeek Harness'
$DataDir = Join-Path $env:USERPROFILE '.dsh-qqbot'

function Section([string]$Title) {
    Write-Host ''
    Write-Host "── $Title " -ForegroundColor Cyan -NoNewline
    Write-Host ('─' * [Math]::Max(0, 60 - $Title.Length)) -ForegroundColor DarkGray
}
function Note([string]$Text) { Write-Host "   $Text" -ForegroundColor DarkGray }
function Good([string]$Text) { Write-Host "   $Text" -ForegroundColor Green }
function Bad([string]$Text) { Write-Host "   $Text" -ForegroundColor Red }
function Warn([string]$Text) { Write-Host "   $Text" -ForegroundColor Yellow }

function Show-Tail([string]$Path, [int]$Lines) {
    if (-not (Test-Path $Path)) { Warn "不存在：$Path"; return }
    $item = Get-Item $Path
    Note "文件：$Path"
    Note "大小 $([math]::Round($item.Length/1KB,2))KB  最后修改 $($item.LastWriteTime.ToString('MM-dd HH:mm:ss'))"
    if ($Full) { Get-Content $Path } else { Get-Content $Path -Tail $Lines }
}

# ── 1. 宿主与插件 ──
Section '宿主与插件'

$procs = @(Get-Process -Name $AppName -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
    Bad "宿主未运行（找不到 $AppName 进程）"
} else {
    $started = ($procs | Sort-Object StartTime | Select-Object -First 1).StartTime
    Good "宿主在跑：$($procs.Count) 个进程，最早启动于 $($started.ToString('MM-dd HH:mm:ss'))"

    $pids = $procs.Id
    $ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $pids -contains $_.OwningProcess } |
        Select-Object -ExpandProperty LocalPort -Unique | Sort-Object)

    if ($ports.Count -eq 0) {
        Warn '没找到监听端口'
    } else {
        Good "监听端口：$($ports -join ', ')"
        $port = $ports[-1]
        # 绑定路由：phase=bound 才说明机器人真的连上了 QQ
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/qqbot/im-qqbot/bind" -TimeoutSec 6 -UseBasicParsing
            $body = $r.Content
            if ($body -match '"phase":"bound"') { Good "插件已加载且机器人已连接：$body" }
            else { Warn "插件在，但绑定状态不是 bound：$body" }
        } catch {
            Bad "绑定路由请求失败：$($_.Exception.Message)"
            Note '插件可能没加载，看下面的 startup.log'
        }

        # 生效配置：核对默认值
        try {
            $cfg = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/qqbot/im-qqbot/config" -TimeoutSec 6 -UseBasicParsing).Content | ConvertFrom-Json
            $c = $cfg.config
            Section '生效配置（关键项）'
            Note "requireMention=$($c.requireMention)  streaming=$($c.streaming)  showToolResults=$($c.showToolResults)"
            Note "reasoningEffort=$($c.reasoningEffort)  rawEventLog=$($c.rawEventLog)"
            Note "admin.enabled=$($c.admin.enabled)  admin.openids=$($c.admin.openids -join ',')"
            Note "proactive.enabled=$($c.proactive.enabled)  minScore=$($c.proactive.minScore)  maxPerHour=$($c.proactive.maxPerHour)"
            Note "people.enabled=$($c.people.enabled)  antiRepeat.enabled=$($c.antiRepeat.enabled)  stickers.enabled=$($c.stickers.enabled)"
        } catch {
            Warn "配置路由读取失败：$($_.Exception.Message)"
        }
    }
}

# ── 2. 插件启动留痕 ──
Section '插件启动留痕（startup.log）'
Note '每条 apply() 对应一次插件加载；时间晚于你的代码提交才算加载了新代码'
Show-Tail (Join-Path $DataDir 'startup.log') 4

# ── 3. 门控判定 ──
Section '自主接话判定（proactive-scores.jsonl）'
$scores = Join-Path $DataDir 'proactive-scores.jsonl'
if (Test-Path $scores) {
    $lines = @(Get-Content $scores | Where-Object { $_.Trim() })
    Note "共 $($lines.Count) 条判定"
    # 决策分布，一眼看门控行为是否正常
    $dist = @{}
    foreach ($l in $lines) {
        try {
            $d = ($l | ConvertFrom-Json).decision
            if ($d) { $dist[$d] = ($dist[$d] + 1) }
        } catch { }
    }
    if ($dist.Count -gt 0) {
        Note ('决策分布：' + (($dist.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '  '))
    }
    Note 'mentioned=被点名必回  chose=自主接话  observed=只记录不接话'
    Get-Content $scores -Tail $Tail
} else {
    Warn '不存在 —— 说明**从未有群消息到达门控**'
    Note '若刚在群里发过消息，问题在平台推送或插件加载，不在门控'
}

# ── 4. 未知网关事件 ──
Section '未知网关事件（raw-events.jsonl）'
$raw = Join-Path $DataDir 'raw-events.jsonl'
if (Test-Path $raw) {
    Good '有记录 —— 平台推送过 SDK 未建模的事件'
    Get-Content $raw -Tail $Tail
} else {
    Note '不存在（正常）。做一次特定动作后仍无记录，说明平台不推该类事件'
    Note '用途：让某人「戳一戳」机器人，再看这里有没有东西'
}

# ── 5. 中间件链留痕 ──
Section '中间件链留痕（middleware-events.jsonl）'
$drops = Join-Path $DataDir 'middleware-events.jsonl'
if (Test-Path $drops) {
    $dlines = @(Get-Content $drops | Where-Object { $_.Trim() })
    Note "共 $($dlines.Count) 条留痕"
    # 类别分布：drop=消息被丢  denied=越权命令  merge=并发合并  handled=命令被处理
    $ddist = @{}
    foreach ($l in $dlines) {
        try {
            $k = ($l | ConvertFrom-Json).kind
            if ($k) { $ddist[$k] = ($ddist[$k] + 1) }
        } catch { }
    }
    if ($ddist.Count -gt 0) {
        Note ('类别分布：' + (($ddist.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '  '))
    }
    Note 'drop=消息没进 agent  denied=命令被拒（越权）  merge=N 条并成 1 轮  handled=命令被识别并处理'
    Get-Content $drops -Tail $Tail
} else {
    Note '不存在（正常）。有群消息后仍无记录，说明链上没有丢弃/合并/命令'
    Note '排查「命令没生效」：这里没有 handled → 命令没被识别（退化成聊天，看会话日志）；有 handled → 识别了，问题在发送侧'
}

# ── 6. 群友档案 ──
Section '群友档案（people.json）'
$people = Join-Path $DataDir 'people.json'
if (Test-Path $people) {
    try {
        $j = Get-Content $people -Raw | ConvertFrom-Json
        $keys = @($j.people.PSObject.Properties.Name)
        Good "已记录 $($keys.Count) 人"
        foreach ($k in $keys | Select-Object -First 5) {
            $p = $j.people.$k
            # name 是可选字段：私聊没有群成员表，取不到昵称就不会写。
            # StrictMode Latest 下读不存在的属性会抛错，整段档案被 catch 吞掉。
            $name = if ($p.PSObject.Properties.Name -contains 'name') { $p.name } else { '<未取到昵称>' }
            Note "$k"
            Note "    name=$name  aliases=[$($p.aliases -join ',')]  count=$($p.count)"
        }
    } catch {
        Bad "解析失败：$($_.Exception.Message)"
    }
    Note "文件：$people（$((Get-Item $people).LastWriteTime.ToString('MM-dd HH:mm:ss'))）"
} else {
    Warn '不存在 —— 说明插件**从未成功处理过一条消息**（档案在入站时创建）'
}

# ── 7. 表情包 ──
Section '表情包（stickers）'
$cat = Join-Path $DataDir 'stickers.json'
$assetDir = Join-Path $DataDir 'stickers'
if (Test-Path $cat) {
    try {
        $j = Get-Content $cat -Raw | ConvertFrom-Json
        Good "图库 $(@($j.stickers).Count) 条"
    } catch { Bad "stickers.json 解析失败：$($_.Exception.Message)" }
} else { Note '无 stickers.json（功能默认关闭，属正常）' }
if (Test-Path $assetDir) { Note "素材目录：$assetDir" } else { Note '无素材目录' }

# ── 8. 数据目录总览 ──
Section '数据目录总览'
if (Test-Path $DataDir) {
    Get-ChildItem $DataDir -Force | Sort-Object LastWriteTime -Descending |
        Select-Object @{n = '名称'; e = { $_.Name } },
                      @{n = 'KB'; e = { if ($_.PSIsContainer) { '<dir>' } else { [math]::Round($_.Length / 1KB, 2) } } },
                      @{n = '最后修改'; e = { $_.LastWriteTime.ToString('MM-dd HH:mm:ss') } } |
        Format-Table -AutoSize | Out-String | Write-Host
} else {
    Bad "数据目录不存在：$DataDir"
}

Write-Host ''
Write-Host '快照结束（只读，未改动任何东西）。' -ForegroundColor Green
Write-Host '若插件层一切正常但仍无回复，改用 qqbot-session-triage 查会话层。' -ForegroundColor DarkGray
