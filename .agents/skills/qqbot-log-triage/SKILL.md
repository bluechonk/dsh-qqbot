---
name: qqbot-log-triage
description: "排查 dsh-qqbot 的插件层问题：机器人不回话、回复异常、插件没加载、配置没生效、消息没到达。通过检查 ~/.dsh-qqbot/ 下的各类日志（startup.log 启动留痕、proactive-scores.jsonl 门控判定、raw-events.jsonl 未知网关事件、people.json 群友档案）与插件的 HTTP 路由判断问题出在平台推送、插件加载、门控还是下游。当症状是「完全没有回复」「@ 了不理」「喊名字不理」「配置改了没效果」「想确认机器人是否连上 QQ」时用这个技能。会话层的问题（模型有没有被调用、preset 对不对）交给 qqbot-session-triage。"
user-invocable: true
allowed-tools: "Read Bash Glob Grep"
---

# QQ 机器人插件层排查

## 这个技能解决什么

**「机器人不回话」有四种完全不同的原因，必须按层排除，否则会一直修错地方：**

```
① 平台没推给插件      → 任何日志都不会有新记录
② 插件没加载          → startup.log 没有新的 apply()
③ 门控把它拦了        → proactive-scores.jsonl 有记录，decision=observed
④ 门控放行了但下游坏了 → decision=mentioned/chose，但没有回复
                         → 会话层问题，转 qqbot-session-triage
```

## 工具：一键状态快照

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/qqbot-log-triage/scripts/qqbot-state.ps1
```

只读、不改任何东西。一次打印：宿主与插件状态、绑定路由结果、生效配置、
启动留痕、门控判定（含决策分布）、未知网关事件、群友档案、表情包、数据目录总览。

```bash
# 判定要多看几行
... qqbot-state.ps1 -Tail 30
```

## 数据目录：每个文件能证明什么

```
~/.dsh-qqbot/
├── startup.log              每条 apply() = 一次插件加载
├── proactive-scores.jsonl   门控判定（消息到了没有、放行了没有）
├── raw-events.jsonl         SDK 未建模的网关事件（探测平台推不推某类事件）
├── people.json              群友档案（**在 handleInbound 内部创建**）
├── stickers.json + stickers/ 表情包图库与素材
└── model-prefs.json         per-peer 模型与预设偏好
```

**关键：这几个文件的写入位置决定了它们的证明力。**

| 文件 | 写入时机 | 所以它能证明 |
|---|---|---|
| `startup.log` | 插件 `apply()` | 插件**加载**了 |
| `proactive-scores.jsonl` | 门控判定时 | 消息**到达门控**了、判定结果是什么 |
| `people.json` | **`handleInbound` 内部**（门控之后） | 消息**穿过了整条中间件链** |
| 会话事件日志 | agent 收到消息时 | 模型**被调用**了 |

**`people.json` 是最有用的分界线**：它比门控晚、比 agent 早。
门控有记录但 `people.json` 没更新 ⇒ 消息在**门控之后、agent 之前**被丢掉了。

## HTTP 路由（插件活着且连上 QQ 的硬证据）

```bash
# 先拿端口
$pids = (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue).Id
Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess } |
  Select-Object -ExpandProperty LocalPort -Unique
```

| 路由 | 期望 | 说明 |
|---|---|---|
| `GET /qqbot/im-qqbot/bind` | `{"phase":"bound","appId":"..."}` | **`bound` 才说明机器人连上 QQ 了** |
| `GET /qqbot/im-qqbot/config` | 生效配置 | 核对默认值与开关是否真的生效 |
| `POST /qqbot/im-qqbot/bind/refresh` | — | 刷新绑定 |
| `POST /qqbot/im-qqbot/bind/unbind` | — | 解绑 |
| `GET /qqbot/im-qqbot/bind/manual` | — | 手动绑定 |

端口每次启动都可能变，别记死。

## 门控判定怎么读

`proactive-scores.jsonl` 每行一条判定：

```json
{"ts":1792725125498,"gid":"5CD5...","decision":"mentioned",
 "rawEventType":"GROUP_MESSAGE_CREATE","atMarkerInContent":false,"chars":39,
 "mentionState":{"wasMentioned":true,"shouldAnswer":true,"reason":"passthrough"}}
```

| 字段 | 含义 |
|---|---|
| `decision` | `mentioned` 被点名必回 / `chose` 自主接话 / `observed` 只记录不接话 |
| `gid` | 群 openid（**不是群号**） |
| `rawEventType` | 平台推的事件类型 |
| `atMarkerInContent` | 正文里有没有 `@` 标记 |
| `chars` | 剥掉 @ 标记后的正文字数 |
| `score` / `reason` | 仅 `chose`/`observed` 有：打分与理由 |
| `recentMessages` / `consecutiveSameSender` / `sinceBotSpokeMs` | 时机特征（M1） |
| `blocked` | 被拦的原因：`not-worth` / `cooldown` / `hourly-cap` |

### 常见误读

- **`decision=observed` 不等于「坏了」**——那是门控正常判断「这条不值得接」。
  只有 `blocked=not-worth` 且你觉得该接时才是阈值问题。
- **`observed` 不会出现在日志里两次以上同一条**——消息去重由 `messageFilter` 负责。
- **`chars` 偏大不奇怪**：平台推的原始正文可能含 `<@...>` 标记，
  门控记的是剥掉标记后的长度。

## 排查决策树

```
机器人不回话
├─ 宿主没在跑？                        → 启动它
├─ /bind 不是 bound？                  → 插件没加载或凭据无效 → 看 startup.log
│   ├─ startup.log 无新 apply()        → 插件加载失败（导入错误？看宿主 stdout）
│   └─ 有 apply() 但时间早于你的改动    → 宿主跑的是旧代码 → 重启宿主
├─ proactive-scores.jsonl 无新记录？    → 消息没到插件（平台推送/权限/额度问题）
├─ decision=observed？                 → 门控拦了，看 blocked 原因与 score
└─ decision=mentioned 但没回复？
    ├─ people.json 没更新              → 消息在门控之后被中间件链丢掉
    └─ people.json 更新了              → 到了 agent → 转 qqbot-session-triage
```

## 「重启」到底重启什么

**重启整个宿主应用**，不是重载插件、也不是重启 QQ 机器人。

| 说法 | 对不对 |
|---|---|
| 重启 DSH Desktop 应用 | **对，唯一可靠** |
| 重载插件 | 不够——Node 有**模块缓存**，同一路径再次 import 返回缓存，改的代码不一定生效 |
| 重启 QQ 机器人 | 不需要——它只是插件里的一条 WebSocket 连接，插件重载时自己重连 |

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/restart-dsh.ps1
```

脚本会等 `startup.log` 出现新的 `apply()` 才算成功——**这一条才真正证明插件加载了**。

## 踩过的坑

| 坑 | 说明 |
|---|---|
| **拿群号当 gid** | 平台推的是 **openid**（`5CD5D4EA...` 这种），群号（`662966742`）是另一回事。对不上就会以为「消息没到」 |
| **`startup.log` 时间看错** | 里面是 **UTC**（`...Z` 结尾），要 +8 才是北京时间 |
| **把「进程起来了」当「插件加载了」** | 两回事。只有 `apply()` 才算 |
| **只看最后一个日志文件** | `people.json` 和 `proactive-scores.jsonl` 的**时间差**才是定位分界线的关键 |
| **改了配置没效果** | 看 `/config` 路由确认真的生效了；写 profile 会触发热重载，但插件代码不一定换新 |

## 相关

- `qqbot-session-triage` —— 会话层排查（本技能排除插件层之后用）
- `scripts/restart-dsh.ps1` —— 重启宿主
- `docs/内部机制.md` —— 中间件链顺序与数据目录
- `docs/验收清单.md` —— 人工验收清单
