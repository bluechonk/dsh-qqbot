# AGENTS.md

本文件是 dsh-qqbot 仓库的协作约定，面向在此仓库工作的 AI 助手与开发者。

## 排查问题：先用这两个技能

机器人不回话、回复不对、配置没生效时，**不要靠猜，按层排除**。
本仓库自带两个排查技能，位于 `.agents/skills/`：

### 1. `qqbot-log-triage` —— 插件层

**什么时候用**：完全没有回复、@ 了不理、喊名字不理、配置改了没效果、
想确认机器人是否连上 QQ。

**怎么用**：

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/qqbot-log-triage/scripts/qqbot-state.ps1
```

只读快照，一次打印宿主与插件状态、绑定路由、生效配置、启动留痕、
门控判定、未知网关事件、群友档案、数据目录总览。

**它回答的问题**：消息到了吗？门控放行了吗？插件加载了吗？机器人连上 QQ 了吗？

### 2. `qqbot-session-triage` —— 会话层

**什么时候用**：插件层正常但仍无回复、人格没生效（回复带 emoji 或列表）、
机器人带着 pwsh 工具、疑似卡死、切模型后会话坏了。

**怎么用**：

```bash
cd .agents/skills/qqbot-session-triage/scripts

node session-log.mjs list                       # 列出所有会话
node session-log.mjs find  'qqbot:<appId>:group:<群openid>'   # 定位 + 看 preset
node session-log.mjs scan  'qqbot:<appId>:group:<群openid>'   # 关键事件（最常用）
node session-log.mjs range '<目标>' 84 95       # 某段完整事件
```

**它回答的问题**：模型被调用了吗？每轮以什么原因结束？会话用的是哪个 preset？

### 为什么必须分两层

```
① 平台没推给插件        → 任何日志都不会有新记录
② 插件没加载            → startup.log 没有新的 apply()
③ 门控把它拦了          → proactive-scores.jsonl 有记录，decision=observed
④ 门控放行但下游坏了    → 转 qqbot-session-triage
```

**`people.json` 是最有用的分界线**：它在 `handleInbound` 内部创建，
比门控晚、比 agent 早。门控有记录但 `people.json` 没更新
⇒ 消息在门控之后、agent 之前被丢掉了。

## 改完代码怎么生效

**必须重启宿主应用**，不是重载插件：

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/restart-dsh.ps1
```

| 说法 | 对不对 |
|---|---|
| 重启 DSH Desktop 应用 | **对，唯一可靠** |
| 重载插件 | 不够——Node 有模块缓存，同路径再次 import 返回缓存 |
| 重启 QQ 机器人 | 不需要——它只是插件里的一条 WebSocket 连接，插件重载时自己重连 |

脚本会等 `startup.log` 出现新的 `apply()` 才算成功——
**「进程起来了」不等于「插件加载了」**。

## 开发约定

### 语言与注释

- 代码注释、文档、提交信息一律**中文**；**日志信息一律英文**
- 文档禁用 emoji
- `README.md` 必须是全中文

### 提交

遵循 Conventional Commits，**type 英文 + 描述中文**：

```
feat(proactive): M1 时机特征——同样一句话，什么时候说很重要
fix(session): 修两个让机器人彻底哑掉的静默故障
```

提交信息先写入 `.tmp/commit-msg.txt`，再 `git commit -F .tmp/commit-msg.txt`
——多行中文直接内联进 shell 会被转义破坏。

### 文件

- 仓库文本一律 LF，`.gitattributes` 已含 `* text=auto eol=lf`
- 临时脚本与中间产物放 `.tmp/`（已 gitignore），任务结束前清理
- 严禁提交任何凭据（`appSecret` 等），敏感内容走环境变量
- 计划文件在 `.planning/<日期>-<主题>/`（task_plan / progress / findings），
  同样是 gitignore 的过程文件，**随进展及时更新**

### 测试与推送

```bash
pnpm build              # tsc（宿主半 → dist/）+ tsdown（浏览器半 → lib/client.js）
pnpm typecheck:client   # 浏览器半单独类型检查（主 tsconfig 排除了 src/client）
pnpm test               # vitest
```

推送前本地测试必须全绿；CI 红着时不要继续推新提交。

## 这个项目的核心约束

### qqchat 是零工具预设

`qqchat` 预设**不挂任何工具**（`persistent-shell` / `tool-fs` 都没有），
`persona.complete=true` 让那段 prefix 直接作为完整 system prompt。

**这意味着：任何「让模型做决定」的功能都要先确认它在当前预设下有没有通道。**
已经因此改过两个设计：

| 功能 | 原设计 | 实际 |
|---|---|---|
| M4 群友档案 | 给模型工具「记住他」 | 无通道 → 只能本地启发式抽别名 |
| M5 表情包 | `send_sticker` 工具让模型选图 | 无通道 → 改为插件自主配图 |

### preset 在会话创建时固定

`agents.resume()` **改不了 preset**（只接受 `agentOptions` 与 `setup`）。
所以早期用别的 preset 建的会话会一直跑错预设——人格不生效、工具泄漏。
插件已内置检测（记录创建时的 preset，不一致就丢弃重建）。

### 平台的硬限制

| 限制 | 影响 |
|---|---|
| 被动回复只有约 5 分钟窗口 | 冷场起话题（M8）只能走主动消息，而主动消息有按群按月配额 |
| 图片消息只透传 `msg_id`，**忽略 `eventId`** | 按钮互动触发的回复不能配图（会退化成主动消息） |
| 群消息推的是 **openid**，不是群号 | 算 sessionId 时别拿群号 |

### 静默失效是本项目最大的风险

已经修过 4 个「不报错、不掉线、测试全绿，只是功能悄悄不对」的 bug：

| bug | 症状 |
|---|---|
| 流式路径绕过 `send()` | 开流式后防复读/表情包/时机特征全部失效 |
| `turn/end{blocked}` 不处理 | 机器人彻底哑掉，日志干净 |
| 会话跑错 preset | 人格不生效、工具泄漏，但它「能回话」 |
| 档案写盘被节流吞掉 | 密集群聊时关掉宿主就丢别名 |

**写降级逻辑时务必留痕**——降级本身没错，但「功能没了没人知道」是最贵的 bug。

## 文档索引

| 文档 | 内容 |
|---|---|
| [README.md](README.md) | 安装、配置、命令 |
| [docs/内部机制.md](docs/内部机制.md) | 中间件链、数据目录、开发模式 |
| [docs/自主接话.md](docs/自主接话.md) | 门控判定与开口策略 |
| [docs/拟人化路线图.md](docs/拟人化路线图.md) | 拟人化能力清单与各模块状态 |
| [docs/表情包.md](docs/表情包.md) | 图库格式、情绪标签、时机规则 |
| [docs/验收清单.md](docs/验收清单.md) | 人工验收清单（照着走一遍） |
| [docs/多机器人.md](docs/多机器人.md) | 多账号接入方案（未实现） |
