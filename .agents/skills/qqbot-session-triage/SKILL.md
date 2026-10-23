---
name: qqbot-session-triage
description: "排查 dsh-qqbot 的会话级故障：机器人不回话、回得不像人设、疑似卡死、切模型后会话坏了。通过读取 DSH 宿主侧的会话事件日志（~/.dsh/sessions/）判断模型到底有没有被调用、每轮以什么原因结束、会话用的是哪个 preset。当症状是「完全没有回复」「人格没生效」「回复带 emoji 或列表」「机器人带着 pwsh 工具」时用这个技能。先用 qqbot-log-triage 排除插件层，再来这里查会话层。"
user-invocable: true
allowed-tools: "Read Bash Glob Grep"
---

# QQ 机器人会话排查

## 这个技能解决什么

**插件日志能证明「消息到了」，但证明不了「模型有没有被调用」。**
会话事件日志能。这两层必须分开查，否则会一直在错误的方向上找。

判断顺序永远是：

```
qqbot-log-triage（插件层：消息到了吗？门控放行了吗？）
        ↓ 到了、放行了，但没回复
qqbot-session-triage（会话层：模型被调用了吗？为什么没产出？）
```

## 工具

```bash
cd .agents/skills/qqbot-session-triage/scripts

# 列出所有会话（按最近活动倒序，本地时间）
node session-log.mjs list

# 由 sessionKey 反推 sessionId 并定位文件，同时报出 agentPreset
node session-log.mjs find 'qqbot:<appId>:group:<群openid>'

# 只列关键事件：preset、用户消息、每轮结束原因 ← 最常用
node session-log.mjs scan 'qqbot:<appId>:group:<群openid>'

# 最后 n 个事件
node session-log.mjs tail '<会话id或sessionKey>' 30

# 某个 seq 区间的完整事件（要看细节时）
node session-log.mjs range '<会话id或sessionKey>' 84 95
```

`<目标>` 可以是会话文件路径、会话 id、或 sessionKey——脚本自动识别。

## 会话 id 是怎么来的

**不是随机数**，是 sessionKey 的 sha256 按 `8-4-4-4-12` 切分：

```
sessionKey = qqbot:<appId>:<c2c|group>:<peerId>
sessionId  = sha256(sessionKey) 的前 32 个 hex 字符，按 8-4-4-4-12 加连字符
```

所以拿到 sessionKey 就能直接算出会话 id，不用去翻目录。脚本的 `find` 就是干这个的。

会话文件位置：

```
~/.dsh/sessions/--C-Users-<用户名>-<路径转义>--/<sessionId>/session.v4.jsonl.zstd
```

cwd 分组名是把 `cwd` 里的 `\` 和 `:` 换成 `-`。QQ 会话的 cwd 通常是宿主进程的 cwd。

## 事件类型速查

| 事件 | 含义 |
|---|---|
| `session` | 会话头（只在第一条）。**`agentPreset` 字段是判断人格是否生效的唯一依据** |
| `user/message` | 注入给模型的消息（可能有多条：正文 + 各种 system-reminder） |
| `turn/start` | 一轮开始 |
| `step/end` | 一个 step 结束 |
| `assistant/message` | 模型产出（reasoning / text / tool-call） |
| `tool/result` | 工具返回 |
| `turn/end` | 一轮结束，**`data.reason.kind` 是关键** |
| `agent/inbox/spliced` | 有新消息被塞进 agent 收件箱 |
| `session/end-seed` | 一轮结束后收尾 |

### `turn/end` 的 reason.kind

| kind | 含义 | 要紧吗 |
|---|---|---|
| `completed` | 正常跑完 | 否 |
| `error` | 出错，`reason.error.code/message` 有详情 | 是 |
| **`blocked`** | **这一轮根本没跑**（宿主 preStep 直接拒绝） | **是，最要紧** |
| `aborted` | 被中断 | 看情况 |

## 故障模式

### 模式一：永久 `blocked` → 机器人彻底哑掉

```
[86] turn/end  reason=completed   ← 最后一次成功
[89] turn/start
[91] turn/end  reason=blocked     ← 从这里开始
[94] turn/start
[96] turn/end  reason=blocked
...                                ← 之后每一轮都 blocked
```

**特征**：`turn/start` 后紧接 `turn/end {blocked}`，中间**没有 `assistant/message`**。

**含义**：模型从未被调用。`blocked` 轮次没有任何产出，所以用户看到的是**纯静默**——
不报错、不提示、不恢复。

**为什么会这样**：宿主 `preStep` 返回 reject（例如 agent 的 claim 被改写掉了）。
一旦进入这个状态**不会自愈**，每一条新消息都重复同样的 start→blocked。

**处置**：
- 插件已内置自动恢复（检测到 blocked 就丢弃会话，下一条消息重建）
- 手动：`/new`，或删掉会话目录

### 模式二：preset 不对 → 人格不生效、工具泄漏

先看会话头：

```bash
node session-log.mjs find '<sessionKey>'
# agentPreset: standard   ← 不对，应该是 qqchat
```

**两个一眼可判的旁证**（在 `scan` 输出里）：

1. **出现了运行时上下文注入**——`user/message` 里有这些内容，就说明人格预设没生效：

```
[9]  user/message  <system-reminder> The following workspace instructions...
[10] user/message  Current runtime context. This snapshot supersedes...
[11] user/message  <system-reminder> A skill is a reusable set of task-specific...
[12] user/message  Time sampled while preparing turn 1, step 1: ...
```

   因为 `qqchat` 设了 `includeRuntimeContext: false` + `complete: true` 来压掉它们。

2. **`assistant/message` 里有 `tool-call` 块**——qqchat 是零工具预设，不该有任何工具调用。

**根因**：preset 在会话**创建时**固定，`agents.resume()` **改不了它**
（只接受 `agentOptions` 与 `setup`，没有 preset 参数）。
所以早期用别的 preset 建的会话会一直跑错预设，而它「能回话」，所以极难发现。

**处置**：插件已内置检测（记录创建时的 preset，不一致就丢弃重建）。
手动：删掉会话目录让下次重建。

> 实测规律：`blocked` 的会话往往**同时**是 preset 错的。两者可能相关，先按 preset 查。

### 模式三：`error`

```bash
node session-log.mjs scan '<目标>' | Select-String 'error'
```

`reason.error.code` 是定位关键。插件只会把非静默错误码发给用户，
所以「用户没看到报错」不代表「没出错」——查日志。

## 排查步骤（照着走）

1. **先算 sessionKey**：`qqbot:<appId>:<group|c2c>:<peerId>`
   - 群聊 peerId = 群 openid（不是群号！）
   - 私聊 peerId = 用户 openid
2. `node session-log.mjs find '<sessionKey>'` → 确认文件存在、看 `agentPreset`
3. `node session-log.mjs scan '<sessionKey>'` → 看最后几轮的 `turn/end` 原因
4. 对症下药：
   - 全是 `blocked` → 模式一
   - `agentPreset` 不是 `qqchat` → 模式二
   - 有 `error` → 模式三
   - 有 `assistant/message` 且 `turn/end completed`，但用户没收到 → **问题在出站层**，
     不是会话层。回去查插件的出站日志（`send failed` 之类）

## 踩过的坑

| 坑 | 说明 |
|---|---|
| **直接解压只得 1 个事件** | 会话文件是**多帧追加**的 zstd。Node 的 `zstdDecompressSync` 只解第一帧。必须按魔数 `28 B5 2F FD` 切帧逐帧解——脚本已处理 |
| **`session_projcache` 不是事件日志** | `~/.dsh/storages/session_projcache/sessions/<id>.json` 是**投影缓存**（`record.rows`），只有状态没有事件流。要事件去 `~/.dsh/sessions/` |
| **时间显示成 UTC** | 脚本已改成本地时间；自己写脚本时注意 `toISOString()` 是 UTC，和聊天记录对不上 |
| **拿群号当 peerId** | 平台推的是 **openid**，不是群号。用群号算出来的 sessionId 是错的 |
| **只看最后一条事件** | `blocked` 要连着看几轮才能确认是「永久」而不是偶发 |

## 相关

- `qqbot-log-triage` —— 插件层排查（先跑这个）
- `docs/内部机制.md` —— 中间件链与数据目录
- `docs/验收清单.md` —— 人工验收清单
