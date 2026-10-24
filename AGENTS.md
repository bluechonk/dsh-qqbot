# AGENTS.md

本文件是 dsh-qqbot 仓库的协作约定，面向在此仓库工作的 AI 助手与开发者。
**通用规则见全局 `~/.zcode/AGENTS.md`**，本文件只写本项目特有的；当前进度看 `.planning/`。

## 排查与维护

### 排查技能

1. 机器人不回话、回复不对、配置没生效时**不要靠猜**，按层排除：平台没推 → 插件没加载 → 门控拦了 → 下游坏了。
2. 插件层（消息到了吗 / 门控放行了吗 / 连上 QQ 了吗）用 `qqbot-log-triage`，一键只读快照：`pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/qqbot-log-triage/scripts/qqbot-state.ps1`
3. 会话层（模型被调用了吗 / 每轮为什么结束 / 用的哪个 preset）用 `qqbot-session-triage`：`node session-log.mjs scan 'qqbot:<appId>:group:<群openid>'`
4. 群友档案记错了要改用 `qqbot-people`：`node people.mjs list` / `show` / `forget` / `export`。
5. 表情包要导入素材、核对素材文件用 `qqbot-stickers`：`node stickers.mjs list` / `import` / `forget`。
6. 分层理由与证据分级见 [docs/内部机制.md](docs/内部机制.md)。

## 改完代码怎么生效

1. 必须重启宿主应用，不是重载插件：`pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/restart-dsh.ps1`。
2. 重载插件不够——Node 有模块缓存，同路径再次 import 返回缓存。
3. 不用重启 QQ 机器人——它只是插件里的一条 WebSocket 连接，插件重载时自己重连。
4. 脚本会等 `startup.log` 出现新的 `apply()` 才算成功；「进程起来了」不等于「插件加载了」。

## 核心约束

### qqchat 是零工具预设

1. `qqchat` 不挂任何工具（`persistent-shell` / `tool-fs` 都没有），`persona.complete=true` 让那段 prefix 直接作为完整 system prompt。
2. 任何「让模型做决定」的功能都要先确认它在当前预设下有没有通道。
3. 已因此改过两个设计：M4 群友档案（给模型工具「记住他」→ 只能本地启发式抽别名）、M5 表情包（`send_sticker` 工具选图 → 插件自主配图）。

### preset 在会话创建时固定

1. `agents.resume()` 改不了 preset（只接受 `agentOptions` 与 `setup`）。
2. 早期用别的 preset 建的会话会一直跑错预设——人格不生效、工具泄漏。
3. 插件已内置检测（记录创建时的 preset，不一致就丢弃重建）。

### 写降级逻辑必须留痕

1. 降级本身没错，但「功能没了没人知道」是最贵的 bug。
2. 审查代码时找 `catch {}`、`?? 默认值`、`if (!x) return` 这类静默路径，问一句「这里失败的话，有人会知道吗」。
3. 已修过 7 个这类 bug，清单见 [docs/内部机制.md](docs/内部机制.md) 的「静默失效」一节。

## 版本控制与协作

1. 分支模型、提交规范、PR、上游同步、回滚方式见 [docs/版本控制.md](docs/版本控制.md)，改代码前先读它。
2. `main` 是单根提交（重建仓库，不带官方 commit 历史），与 `upstream/main` 没有共同祖先 → 不能 merge/rebase 上游，只能手工搬运。
3. 提交信息格式见全局约定；本项目额外要求 `scope` 必填。
4. 大改造（跨模块 / 动契约 / 预计 > 20 文件）先开分支 + 出方案，不直推 `main`。

## 测试与推送

1. `pnpm build && pnpm typecheck:client && pnpm test`，推送前必须全绿。
2. CI 矩阵与门禁细节见全局约定与 [docs/版本控制.md](docs/版本控制.md)。

## 文档索引

1. [docs/README.md](docs/README.md) —— 文档总索引（含排查与维护入口）
2. [docs/内部机制.md](docs/内部机制.md) —— 中间件链、数据目录、平台限制、DSH 内部机制、踩过的坑
3. [docs/版本控制.md](docs/版本控制.md) —— 分支模型、提交规范、推送门禁、上游同步
4. [README.md](README.md) —— 安装、配置、命令
5. [docs/自主接话.md](docs/自主接话.md) —— 门控判定与开口策略
6. [docs/拟人化路线图.md](docs/拟人化路线图.md) —— 拟人化能力清单与各模块状态
7. [docs/群友档案.md](docs/群友档案.md) —— 群友长期记忆的设计（无工具方案，设计稿）
8. [docs/群友档案-工具版.md](docs/群友档案-工具版.md) —— 同上，预设允许工具时（模型自己调 remember/recall）
9. [docs/表情包.md](docs/表情包.md) —— 图库格式、情绪标签、时机规则
10. [docs/验收清单.md](docs/验收清单.md) —— 人工验收清单（照着走一遍）
11. [docs/多机器人.md](docs/多机器人.md) —— 多账号接入（settingsNs 多实例）
