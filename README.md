# dsh-qqbot

DeepSeek Harness 插件：把 QQ 私聊与群聊接进 dsh，AI 以「大肥鱼」的身份陪聊——不挂终端与文件工具，只说话。

## 能力

- **群友式陪聊**：会话固定跑在插件自带的 `qqchat` 预设上，零工具（没有终端、没有文件读写），人格与说话风格由插件内置定义
- **自主接话**：群里没人点名她时，由本地词法门控判断这条值不值得接——接不接最后由模型自己决定
- **沉默是常态**：模型可以回 `[skip]` 表示这一轮不回复，不是每条都接
- **拟人节奏**：回复带随机延迟（默认 1.2 秒起 + 每字 80ms + 抖动），不秒回
- **端内绑定**：设置页「QQ 机器人」分区里扫码绑定、手动填写、换绑、解绑，全程不跳系统浏览器
- **提问卡片**：模型需要确认时，在 QQ 里发带按钮的卡片，点按钮即作答
- **审批卡片**：宿主触发审批时，QQ 里直接点「允许 / 拒绝」
- **富媒体理解**：收到图片或视频会下载并分析；也能把文件发回 QQ
- **会话隔离**：私聊与群聊各自独立；会话键含 appId，多账号天然不串
- **配置面板**：访问控制、是否必须 @、流式开关、自主接话、回复节奏、模型与提示词覆盖，都在设置页里改

## 截图

![群聊陪聊](docs/assets/qqgroup.jpg)

![私聊陪聊](docs/assets/qqchannel.jpg)

![扫码绑定](docs/assets/qrcode.png)

## 安装、更新、卸载

### 方式一：在「插件」页粘贴 GitHub 链接（推荐）

DSH 的「插件」页右上角有「**+ 添加插件**」，弹窗第一行写着「输入插件的包名、**GitHub 仓库地址**或本地目录路径」——把下面的链接粘进去点「安装」即可，界面会把它识别为「Git 仓库」：

```
https://github.com/bluechonk/dsh-qqbot
```

装完宿主会把包写进 profile 的 `dependencies`（值为 `github:bluechonk/dsh-qqbot`），并把它加进 `dsh.profile.bundles`；随后设置页导航里「QQ 机器人」就出现了。

> 从 GitHub 安装会现场跑一次构建（仓库通过 `prepare` 钩子在安装期编译 `dist/` 与 `lib/`），第一次约 30 秒，之后走缓存。

### 方式二：插件市场索引（可浏览、可一键安装）

本仓库自带**插件市场索引** `market-index.json`（指向本仓库的 git 源，锁定 commit）。启用市场 bundle 后，在 DSH「设置 → 插件」页的索引源输入框粘贴下面这条 GitHub 链接，Discover 标签里就会出现本插件，点「安装」即可：

```
https://raw.githubusercontent.com/bluechonk/dsh-qqbot/main/market-index.json
```

启用市场 bundle（一次性；注意版本要与当前 DSH 运行时兼容，不兼容时宿主会拒绝启用并提示对应版本）：

```bash
plugin_manager set_bundle --target "@deepseek-ai/dsh-experimental-plugin-market-bundle" --enabled true
```

### 方式三：工具与命令行

```bash
# 工具（对话里可用 plugin_manager 工具）
plugin_manager install_bundle --target "https://github.com/bluechonk/dsh-qqbot"

# 命令行（转发给 profile 目录里的 pnpm）
dsh plugin --profile desktop add "https://github.com/bluechonk/dsh-qqbot"
```

装完先在「设置 → QQ 机器人」里扫码绑定，绑定成功即开始工作。

### 本地开发

从源码开发时，把仓库目录**链接**进 profile 的 `node_modules`，宿主按链接目标加载，改完重新构建并刷新页面即可生效：

```bash
dsh plugin --profile desktop add link:/path/to/dsh-qqbot
```

构建：

```sh
pnpm install
pnpm build     # tsc（宿主半 → dist/）&& tsdown（浏览器半 → lib/client.js）
```

> 用 `link:` 而不是 `file:`：包管理器对 `file:` 目录依赖**不跟踪内容变更**，改完源码不会自动重新打包；`link:` 是软链，构建完即刻生效。

### AI 助手安装

1. 先读本文件全文（尤其「已知限制」）。
2. 用 `plugin_manager` 的 `install_bundle`，target 传本仓库的 GitHub 地址。
3. 读安装结果：`application` 为 `applied` 才算装好；`failed` 时按 `error.diagnostic` 排查后重装同一个包，不要新建副本。
4. 用 `cordis_inspect_query`（Slots.listSubTree，根 `settings.section`）确认 `dsh-qqbot` 出现在列表里。
5. 绑定凭据：在「设置 → QQ 机器人」分区扫码，或手动填 AppID / AppSecret。

## 配置

配置写在 profile 的 `cordis.patch.yml` 的 `im-qqbot` 条目里，也可以在设置页里改（改完自动重载）。

### 设置页可改的

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `requireMention` | boolean | `false` | 群聊是否必须 @ 机器人才回应（自主接话开启时由判定接管） |
| `streaming` | boolean | `false` | 是否启用流式输出（群聊始终不启用） |
| `showToolResults` | boolean | `false` | 是否展示工具调用成功结果（错误始终展示） |
| `debug` | boolean | `false` | 调试模式 |
| `rawEventLog` | boolean | `true` | 记录未知网关事件到 `~/.dsh-qqbot/raw-events.jsonl`（用于探测平台是否推送某类事件，如「戳一戳」） |
| `provider` | string | - | LLM 提供商名称，留空继承宿主默认 |
| `model` | string | - | 模型名称，留空继承宿主默认 |
| `reasoningEffort` | `off`/`low`/`medium`/`high`/`max` | - | 思考强度，留空由宿主决定（qqchat 建议 `off`） |
| `preset` | string | `qqchat` | 插件级默认 preset（per-peer 切换优先，见 `/preset`） |
| `groupPrompt` | string | - | 群聊额外 system prompt |
| `directPrompt` | string | - | 私聊额外 system prompt |
| `access.c2cMode` | `open`/`allowlist`/`disabled` | `open` | 私聊访问模式 |
| `access.c2cAllow` | string[] | `[]` | 私聊白名单（user openid） |
| `access.groupMode` | `open`/`allowlist`/`disabled` | `open` | 群聊访问模式 |
| `access.groupAllow` | string[] | `[]` | 群聊白名单（group openid） |
| `admin.enabled` | boolean | `true` | 启用命令权限校验（关闭则所有人可执行高权限命令，仅调试用） |
| `admin.openids` | string[] | `[]` | 管理员 openid 白名单（用 `/whoami` 查看自己的 openid） |
| `proactive.enabled` | boolean | `true` | 自主接话总开关 |
| `proactive.minScore` | number | `0.55` | 放行门槛（0~1） |
| `proactive.cooldownMs` | number | `120000` | 同群两次主动接话的最小间隔（ms） |
| `proactive.maxPerHour` | number | `6` | 同群每小时主动接话上限，0 = 不限制 |
| `proactive.minLength` | number | `6` | 参与判定的最短文本长度 |
| `proactive.observer` | boolean | `true` | 记录判定日志 |
| `people.enabled` | boolean | `true` | 群友档案（记住昵称、称呼、互动次数） |
| `people.maxAliases` | number | `2` | 注入提示时最多带几个别名 |
| `antiRepeat.enabled` | boolean | `true` | 防复读（把「你最近说过」前置给模型） |
| `antiRepeat.historySize` | number | `5` | 记住自己最近几条发言 |
| `stickers.enabled` | boolean | `false` | 表情包（需先导入图库，见 `docs/表情包.md`） |
| `stickers.maxTextReplies` | number | `3` | 连续多少条纯文字后才允许配一个表情 |
| `stickers.cooldownMs` | number | `600000` | 同一张表情的冷却时间（ms） |
| `replyDelayMs` | number | `1200` | 回复延迟基础值（ms），0 = 关闭 |
| `replyDelayPerCharMs` | number | `80` | 回复延迟每字增量（ms） |
| `replyDelayJitterMs` | number | `1500` | 回复延迟随机抖动上限（ms） |
| `replyDelayMaxMs` | number | `8000` | 回复延迟单次上限（ms），0 = 不封顶 |

### 需要改 patch 文件的

这些是调优类字段，日常不必动：

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appId` / `appSecret` | string | - | QQ 机器人凭据（绑定后自动写入） |
| `cwd` | string | - | Agent 工作目录（设置页只读展示） |
| `textChunkLimit` | number | `4500` | 单条消息最大字符数 |
| `sessionIdleTimeout` | number | `1800000` | 会话闲置回收时长（ms） |
| `maxQueue` | number | `20` | 并发队列最大长度 |
| `processingTimeoutMs` | number | `1800000` | 单次处理超时（ms） |
| `askTimeoutMs` | number | `300000` | 待答问题超时（ms） |
| `historyLimit` | number | `10` | 群历史缓冲条数 |
| `media.enabled` | boolean | `true` | 富媒体理解开关 |
| `media.maxMB` | number | `200` | 富媒体下载上限（MB） |
| `media.ttlHours` | number | `24` | 富媒体存活时长（小时），0 = 永不过期 |
| `vision.enabled` | boolean | `false` | 视觉理解开关 |
| `vision.provider` / `vision.model` | string | - | 视觉模型 provider 与 model |
| `sendFile.restrictPaths` | boolean | `true` | 附件发送的路径白名单 |
| `sendFile.extraRoots` | string[] | `[]` | 额外允许访问的根目录 |

### 自主接话

`proactive.enabled` 打开后，群里**没点名她**的消息会先过一道本地判定（零 token，不调模型）：

| 特征 | 影响 |
|---|---|
| 疑问句式、求助词、提到「肥鱼 / 鲸鱼」 | 加分 |
| 灌水噪声（「哈哈」「666」「打卡」…） | 减分 |
| 这条 @ 的是别人 | 减分（那轮对话的方向是别人） |
| 过短、纯表情 | 直接不接 |

过了判定才会唤醒模型；模型还会再判一次，插话不自然就回 `[skip]` 沉默。

判定日志落在 `~/.dsh-qqbot/proactive-scores.jsonl`，每行一条（含分数、理由、是否被冷却拦住），据此调 `minScore` 即可。

> 注意：「没被 @」本身**不扣分**——那正是她该主动接话的常态。扣分的是「这句 @ 的是别人」。

### 配置存放位置

```
profile  <DSH_HOME>/profiles/<profile>/cordis.patch.yml   # im-qqbot 条目
本地数据 <HOME>/.dsh-qqbot/                               # 判定日志、启动留痕、模型偏好
```

## 内置命令

| 命令 | 说明 | 权限 |
|------|------|------|
| `/new`（别名 `/reset` `/clear`） | 开始新会话（清空上下文） | 主人 |
| `/compact` | 压缩会话历史（摘要替换旧记录，保留上下文） | 主人 |
| `/model` | 查看或切换模型 | 主人 |
| `/preset` | 查看或切换 preset（默认 `qqchat`，切换会重建会话） | 主人 |
| `/stop` | 中止当前生成 | 主人 |
| `/bot-status` | 查看当前会话状态 | 主人 |
| `/whoami` | 查看自己的 openid 与权限 | 所有人 |
| `/bot-ping` | 网络延迟检测（返回传输与处理耗时） | 所有人 |
| `/bot-version` | 查看版本信息 | 所有人 |
| `/bot-help` | 查看所有指令（按权限过滤） | 所有人 |

**命令默认仅限主人**——不显式标注的命令都要求管理员权限，
避免新增命令时忘记加校验导致意外开放。

主人身份靠 `admin.openids` 白名单配置：平台**不告诉**机器人谁是创建者
（QQ 机器人 API 没有 owner 概念），所以必须显式配置。第一次配置：

1. 在群里发 `/whoami`，机器人回复你的 openid
2. 把那串 id 填进 `admin.openids`（设置页或 `cordis.patch.yml`）
3. 重启 DSH

填之前，高权限命令对**所有人**关闭（安全默认），拒绝文案里会提示上面这几步。

## 内部机制

- Host 半挂在同源路由 `/qqbot/im-qqbot/*`（绑定状态、扫码、手动填写、配置读写），只接受本机同源请求
- Client 半注册 `settings.section`（order 7，标签「QQ 机器人」）与右侧栏页签「QQ 机器人绑定」；未绑定时右侧栏自动弹出引导页
- 入站：`historyBuffer` 挂在门控之前，群消息**全量**入内存历史（未点名她的也进）；`mentionGate` 只标记不拦，拦截交给 `proactiveGate`
- 判定分两层：L1 本地词法门控（零 token）挡掉明显不值得的；L2 模型在回合内自己决定说不说
- 出站：`session/event` → `sendMarkdown`，发送前走拟人延迟；回复恰为 `[skip]` 则不发送
- 会话键 `qqbot:${appId}:${kind}:${peerId}`，私聊与群天然隔离
- 全部视觉用 `--dsw-alias-*` 令牌，不硬编码颜色

细节见 [docs/内部机制.md](docs/内部机制.md)。

## 版本线

**本插件是自用的，版本固定走 `0.1.x`**：`0.x` 的语义就是「初始开发、不承诺兼容性」——配置项、接口、界面都还可能再改。按 SemVer 的用法：

- `0.1.0` → `0.1.1` → `0.1.2`：同一版设计内的修复与小改；
- `0.2.0`：换一版设计（配置格式或接口不兼容），届时需迁移既有配置；
- 什么时候才升 `1.0.0`：**有别人开始依赖本插件的配置格式与接口**时，才需要给出稳定性承诺。

宿主自身的版本兼容（跨 DSH 升级）不由本插件的版本号决定，而由 `engines.dsh` / peerDependencies 声明与宿主的版本豁免机制管。

## 已知限制

- 目前**只支持一个** QQ 机器人；多账号的方案见 [docs/多机器人.md](docs/多机器人.md)（未实现）
- **主动开口受平台配额限制**：QQ 的被动回复只有约 5 分钟窗口，超时只能走「主动消息」，
  而主动消息有按群按月的配额。所以「冷场起话题」只做到**判断时机**
  （`features/idle-topic/`），真正发消息待配额确认
- 表情包**默认关闭且仓库不含任何素材**（版权归原作者）：功能与发送链路都已实现，
  但需自备图片并按 [docs/表情包.md](docs/表情包.md) 建图库；
  另需机器人具备发送图片的权限
- 群聊**不支持流式输出**（QQ 的群消息没有流式接口），私聊才支持
- 视觉理解需要另行配置视觉模型的 provider 与 model，默认关闭
- 设置页文案硬编码中文，暂未接入 i18n
- 依赖 QQ 开放平台的群消息推送策略：机器人只能收到平台推给它的消息
- **拟人化能力全部未在真实群聊实测过**（判定逻辑有单测覆盖）：
  照 [docs/验收清单.md](docs/验收清单.md) 走一遍即可确认

## 开发

```sh
pnpm install
pnpm build              # tsc + tsdown
pnpm typecheck:client   # 浏览器半的类型检查（主 tsconfig 不覆盖 src/client）
pnpm test               # vitest：170 个用例
```

文档：

- [docs/内部机制.md](docs/内部机制.md) —— 架构与实现要点
- [docs/自主接话.md](docs/自主接话.md) —— 判定与开口的设计
- [docs/拟人化路线图.md](docs/拟人化路线图.md) —— 拟人化能力清单与规划
- [docs/多机器人.md](docs/多机器人.md) —— 多账号接入方案

## 许可证

MIT

本项目基于 [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)（MIT）改造，原始版权声明保留在 [LICENSE](LICENSE)。
