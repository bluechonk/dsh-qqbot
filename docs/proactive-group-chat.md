# 主动参与群聊 — 设计方案

> 目标：让 QQ 机器人**不用被点名**，自己读取群聊信息并**有选择地参与对话**。
> 落点：本仓库（`bluechonk/dsh-qqbot`）。参考实现来自 `zaofan-make/dsh-qqbot`（MIT），只借鉴机制，不移植代码。

---

## 一、现状盘点

### 已经有的（不必重造）

| 能力 | 位置 | 说明 |
|---|---|---|
| 群消息全量入内存 | `src/gateway/middleware-setup.ts:61` `historyBuffer({recordOnSkip: true})` | 挂在门控**之前**，未 @ 机器人的群消息也进历史缓冲 |
| 群会话独立 | `src/session/session-manager.ts:430` `sessionKey = qqbot:${appId}:${kind}:${peerId}` | `c2c` 与 `group` 两条独立会话 |
| 门控可动态放行 | SDK `mentionGate({resolveConfig})` | 支持按消息上下文决定要不要 @，不必写死 |
| Agent 插话原语 | 宿主 `agent.inject(msg, 'next-step', wakeup:false)` | 排队到下一次 pre-step 组包，不唤醒、不拆 tool_calls |
| 出站发送 | `src/transport/outbound.ts` `sendMarkdown` | 目前只由「收到消息 → 回复」驱动 |
| 端内配置面板 | `src/client/config-panel.ts` + `src/setup/bind-routes.ts` | 新配置项有现成的读写与持久化通路 |

### 缺什么

1. **没有「该不该接话」的判断层** —— 现在只有被 @ 才回话。
2. **没有出站的主动通道** —— 上游 issue [#16](https://github.com/tencent-connect/dsh-qqbot/issues/16)（2026-08-19 至今 OPEN）就是这个缺口：
   `de_channel_send` 返回「渠道未注册：…插件版本不含通知钩子」。
3. **没有「沉默」语义** —— 出站收到 assistant 消息就发，AI 想说「不接话」也没法不说。

### 一个必须先纠正的现状

当前 profile 里 `requireMention: false`（`profiles/desktop/cordis.patch.yml`），意味着**每一条群消息都在唤醒 AI 并回话**。这既烧 token 也刷屏。

所以本方案的第一性目标其实是：

> 把「全量被动回话」换成「被点名必回 + 自主判断后接话」。

---

## 二、总体架构：三段式

```
听见 ──▶ 判断 ──▶ 开口
 │        │        │
 │        │        └─ 插话型：合成本地消息 → agent.followup → 自然回一句
 │        │        └─ 纯主动型：出站主动发送（无 msgId，走 issue #16 的方向）
 │        │
 │        └─ 价值门控 ValueGate：本地打分，零 token
 └─ 群消息全量入 historyBuffer（已有）
```

**判断分两层，这是省 token 的关键**：

| 层 | 判定者 | 成本 | 负责 |
|---|---|---|---|
| L1 粗筛 | 本地词法/嵌入打分器 | 零 token | 把明显不值得的 90% 消息直接拦掉，不进 AI |
| L2 精判 | AI 在回合内自己决定 | 每条少量消息一次 | 判断此刻插话自不自然，必要时选择沉默 |

**绝不能让每条群消息都过一次 LLM** —— 那是烧 token 的根源。

---

## 三、详细设计

### 3.1 配置

新增 `proactive` 配置块（`src/config.ts`）：

```yaml
proactive:
  enabled: false          # 总开关，默认关
  mode: 'log'             # log=只记录判定、行为不变；block=不值得就不唤醒
  minScore: 0.55          # L1 放行阈值
  cooldownSec: 120        # 同群两次主动接话的最小间隔
  maxPerHour: 6           # 同群每小时主动接话上限
  groupAllow: []          # 空=所有群；非空=仅这些群开
  groupDeny: []           # 黑名单优先于白名单
  minLength: 6            # 短于此长度的消息不参与判定
  observer: true          # 判定日志落盘
```

`mode: 'log'` 是**观察期**：行为与现在完全一致（未被 @ 不唤醒），但每条未 @ 消息都会记录判定分。
跑一天后看日志定阈值，再切 `block`。zaofan 走的就是这条路径（默认 `log`）。

### 3.2 价值门控 `ValueGate`

新增 `src/features/proactive/`：

```ts
export interface ProactiveCandidate {
  text: string;            // 已剥 mention 的正文
  rawText: string;         // 原文
  scope: 'group' | 'c2c';
  peerId: string;          // groupOpenid
  senderId: string;
  senderName?: string;
  mentioned: boolean;      // 是否 @ 了机器人
  mentionedOthers: boolean;// 是否 @ 了别人
  hasAttachment: boolean;
  recentHistory: string[]; // 群内最近若干条
}

export interface ValueVerdict {
  score: number;           // 0~1
  worth: boolean;
  reason: string;          // 人话解释，进日志
  confidence: number;      // 0~1，低于阈值不拦
}

export interface ValueGate {
  readonly id: string;
  ready(): boolean;
  evaluate(c: ProactiveCandidate): Promise<ValueVerdict | undefined>; // undefined=未知，不拦
}
```

**实现 A（Phase 1，零依赖）`LexicalValueGate`**

特征与权重（权重可配置）：

| 特征 | 方向 | 说明 |
|---|---|---|
| 文本长度 | 正向 | 太短多半是「嗯」「好」 |
| 是疑问句 | 正向 | 群里提问最需要人接 |
| @ 了别人 | 负向 | 这一轮的方向是别人，插嘴不自然 |
| 包含可接话关键词 | 正向 | 问号/求助/情绪词/技术词等可配置词表 |
| 与机器人上一条相关 | 正向 | 接自己的话合理 |
| 群内近期发言密度 | 负向 | 刷屏期不该插 |
| 最近已主动接过话 | 负向 | 冷却期内直接压低 |

**实现 B（Phase 3，可选）`KnnValueGate`**

照搬 zaofan 的成熟做法：本地嵌入模型 + 样例近邻加权投票（KNN，k=5，权重 `s^8`）。

作者实测数据（zaofan `src/features/value-score.ts` 注释）：

- KNN 准确率 90~100%；zero-shot 描述句只有 65% 且分数全挤在 0.5 附近
- **样例与查询都要剥 mention 前缀**（`<@!123>` / `<@openid>` / `@bot`），
  否则「这条 @ 了她」成为最大共同特征、语义被淹没（实测「<@xx> 不知道」拿 1.00 分）
- **@ 了别人**扣 0.06（减法不是乘法，门槛附近更保守）
- **没被 @ 恰恰是她该接话的常态**，绝不能因为「没被 @」扣分
- 置信度（最近邻相似度）< 0.5 时**不拦截**：宁可多花 token 也别漏

### 3.3 门控改造

`src/gateway/middleware-setup.ts` 里把 `mentionGate` 换成自己的 `proactiveGate`（内部仍复用 SDK 的 `mentionGate`，通过 `resolveConfig` 动态放行）：

```
if (scope !== 'group')        → 放行（私聊行为不变）
if (wasMentioned)             → 放行，标记 proactive.mode='mentioned'
verdict = await gate.evaluate(candidate)
记录日志（observer）
if (mode === 'log')           → 不放行（等价 requireMention=true），只记录
if (!verdict.worth)           → 拦截（不唤醒 AI；消息仍留在 historyBuffer）
if (冷却/频率超限)             → 拦截
标记 proactive.mode='chose'    → 放行
```

**被 @ 永远必回**（`worth` 再低也放行），这是硬约束。

### 3.4 入站改造

`src/transport/inbound.ts` 的 `handleInbound` 里，当 `ctx.state.proactive.mode === 'chose'`，
在 agentBody 前缀一段背景说明：

```
【群聊背景】这条消息没有点名你，是系统粗筛后认为可能值得接话。
若此刻插话自然，就回一句；若不该插，用 skip 工具放弃发言。
```

同时给 `ctx.state` 带上 `proactive` 标记，供出站层判断是否真的发送。

### 3.5 沉默机制（新增）

出站层（`src/transport/outbound.ts` 的 `onMessage`）识别 AI 的「放弃发言」信号后**不发**。

两种实现，二选一：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 专用工具 | 给 agent 一个 `skip_reply` 工具，调用即放弃 | 需要接 dsh 的工具注册 |
| B. 约定标记 | 回复内容等于 `[skip]`（可配置）时跳过发送 | 极简，但会占用一个字面量 |

推荐 B 作为 v1（改动最小），A 作为后续。

### 3.6 频率控制

per-group 内存状态（进程内，重启清零）：

- `lastProactiveAt`：距上次主动接话的秒数
- `hourBucket`：当前小时窗口内的主动次数

超过 `cooldownSec` 或 `maxPerHour` 直接拦截。可选落盘（`dataRoot/.qqbot/proactive-state.json`）以跨重启保留。

### 3.7 可观测

判定日志：`dataRoot/.qqbot/proactive-scores.jsonl`，一行一条：

```json
{"ts":1792603205698,"gid":"g_xxx","sender":"bluechonk","mention":false,"score":0.62,"worth":true,"reason":"疑问句+求助词","min":0.55,"mode":"block","cooldown":false}
```

滚动策略照 zaofan 的做法：超过 2MB 才检查，保留最新 2000 行（原子替换）。

### 3.8 出站主动发送（Phase 4，对应上游 issue #16）

无人触发的纯主动消息（如定时提醒）没有 `msgId`，而当前 `ReplyTarget.msgId` 必填。

需要：

1. `ReplyTarget.msgId` 改为可选
2. 发送走三级降级链：**markdown → 纯文本 → c2c `is_wakeup` 召回**（30 天窗；群聊调用 `is_wakeup` 会抛，调用方保证只用于 c2c）

这部分与上游 issue #16 同源，做完可以顺手回馈上游。

---

## 四、数据流时序

```
群消息到达
  │
  ├─ errorHandler
  ├─ messageFilter（去重）
  ├─ accessPolicy（白名单）
  ├─ historyBuffer(recordOnSkip:true)   ← 群消息全量入内存（已有）
  ├─ proactiveGate                      ← 新增
  │    ├─ 私聊 / 被 @          → 放行
  │    ├─ evaluate() 打分      → 记日志
  │    ├─ mode=log             → 拦截（只观察）
  │    ├─ 不值得 / 冷却超限     → 拦截
  │    └─ 值得                 → 标记 chose，放行
  ├─ contentSanitizer / rateLimiter / slashCommand
  ├─ concurrencyGuard（串行）
  ├─ handleInbound
  │    ├─ assembleAgentBody（+ 主动接话背景前缀）
  │    ├─ manager.getOrCreate(group, groupOpenid)
  │    ├─ agent.followup(message)     ← 唤醒 AI
  │    └─ agent.whenIdle()
  └─ outbound.onMessage
       ├─ 回复是 [skip] → 不发
       └─ 否则 sendMarkdown
```

---

## 五、影响范围

### 新增

| 文件 | 职责 |
|---|---|
| `src/features/proactive/types.ts` | `ValueGate` / `ProactiveCandidate` / `ValueVerdict` 接口 |
| `src/features/proactive/lexical-gate.ts` | L1 词法门控（Phase 1） |
| `src/features/proactive/knn-gate.ts` | L1 KNN 门控（Phase 3，可选） |
| `src/features/proactive/cooldown.ts` | 频率控制 |
| `src/features/proactive/observer.ts` | 判定日志 |
| `src/features/proactive/index.ts` | 导出与工厂 |
| `src/middleware/proactive-gate.ts` | 门控中间件 |
| `src/features/proactive-sender.ts` | 出站主动发送（Phase 4） |

### 修改

| 文件 | 改动 |
|---|---|
| `src/config.ts` | 新增 `proactive` 配置块（Schema + interface） |
| `src/gateway/middleware-setup.ts` | `mentionGate` → `proactiveGate` |
| `src/transport/inbound.ts` | 主动接话的上下文前缀；读取 `ctx.state.proactive` |
| `src/transport/outbound.ts` | 识别静默标记，不发送 |
| `src/setup/bind-routes.ts` | 新配置项的白名单与校验 |
| `src/setup/persist.ts` | 新配置项写回 profile patch |
| `src/client/config-panel.ts` | 面板开关（可选，Phase 2 后补） |

### 测试

`src/features/proactive/*.test.ts`：门控判定、mention 归一化、@别人扣分、冷却、可观测日志。

---

## 六、迁移路径

每个 Phase 独立提交、独立可上线、独立可回滚。

### Phase 1 — 骨架 + 观察期（零行为变更）

- 新增 `features/proactive/`、`middleware/proactive-gate.ts`
- `proactive.enabled` 默认 false；`mode` 默认 `log`
- 门控逻辑等价 `requireMention: true` + 记录判定分
- **不改任何现有行为**，风险≈0

验收：群消息照旧不唤醒 AI；`proactive-scores.jsonl` 有连续记录。

### Phase 2 — 放行 + 沉默（真正的主动接话）

- `mode: 'block'` 生效；`proactive.enabled: true`
- 入站背景前缀 + 出站静默识别
- 频率控制生效
- 面板开关

验收：见第八节。

### Phase 3 — KNN 门控（可选）

- 引入本地嵌入模型 + 样例库，照搬 zaofan 的 KNN 方案
- 与词法门控可切换（`proactive.gate: 'lexical' | 'knn'`）

### Phase 4 — 纯主动出站（对应上游 issue #16）

- `ReplyTarget.msgId` 可选 + 三级降级链
- 定时/事件触发的主动消息

---

## 七、回滚方式

| 级别 | 手段 |
|---|---|
| 配置级（即时） | `proactive.enabled: false` → 门控直接放行，等价于回到 `requireMention` 原语义 |
| 行为级（即时） | `proactive.mode: 'log'` → 判定照记，但行为回退到「被 @ 才回」 |
| 代码级 | 每个 Phase 一个提交，`git revert` 即可；Phase 1 是纯新增文件，删目录即回滚 |
| 兜底 | 任何异常都走 `catch` 吞掉并放行原路径，**主动层永远不能影响原有回话能力** |

---

## 八、风险与对策

| 风险 | 后果 | 对策 |
|---|---|---|
| 刷屏 | 群里被机器人淹没 | 冷却 + 每小时上限 + 默认关闭 + per-group 白名单 |
| 烧 token | 每条群消息都调 LLM | L1 本地粗筛在前；L2 只处理少量消息；观察期不额外调 LLM |
| 误判该说的没说 | 显得迟钝 | 被 @ 必回；低置信不拦；`mode: 'log'` 先观察再切 `block` |
| 误判不该说的说了 | 尴尬 | 冷却期 + 「@了别人」扣分 + L2 让 AI 自己再判一次 + 沉默机制 |
| 与 `requireMention` 语义打架 | 行为不可预期 | 明确约定：`proactive.enabled` 为真时，`requireMention` 只决定「被 @ 必回」这条底线 |
| 主动接话后群历史重复组包 | 上下文重复 | 复核 `clearGroupHistory` 的调用时机，主动接话后同样清理 |
| 隐私 | 群消息内容落盘 | 判定日志只存评分与摘要特征，不存全文（或存截断片段） |

---

## 九、验收标准

Phase 2 的验收项：

1. 群里连续 20 条未 @ 消息，`mode: 'block'` 下 AI 被唤醒次数 **不超过 3**
2. 被 @ 消息 **100%** 回话
3. 同一群两次主动接话间隔 **不小于** `cooldownSec`
4. AI 决定沉默时，QQ 侧 **不产生任何消息**
5. 判定日志可复盘：任一条主动接话都能在 `proactive-scores.jsonl` 找到当时的分数与理由
6. 主动层抛异常时，原有回话链路**不受影响**

---

## 十、与上游 issue #16 的关系

| | issue #16 | 本方案 |
|---|---|---|
| 方向 | 定时/事件触发的**推送** | 群聊中的**自主参与** |
| 出站 | 需要「通知钩子」/ `de_channel_send` | Phase 4 的纯主动出站正是它的实现 |
| 入站 | 无关 | 需要价值门控 + 插话 |

两者在 Phase 4 汇合：同一个出站主动发送通道。做完可以向
[tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) 提 PR 或 issue 回馈。

---

## 附：参考实现索引（zaofan-make/dsh-qqbot，MIT）

| 模块 | 借鉴点 |
|---|---|
| `src/features/value-score.ts` | KNN 价值评分、mention 归一化、`OTHER_MENTION_PENALTY`、置信度不拦 |
| `src/features/local-embed.ts` / `lexical-embed.ts` | 本地嵌入 + 纯词法兜底（零 token） |
| `src/features/agg-score.ts` | 聚合窗口打分 |
| `src/gateway/debounce.ts` | `agent.inject(msg, 'next-step', wakeup:false)` 插话原语 |
| `src/gateway/middleware-setup.ts:298` | `mentionGate({resolveConfig})` 动态放行 |
| `src/gateway/bootstrap.ts:444` | 纯主动出站三级降级链 |
| `src/features/attitude.ts` | 好感度调节主动频率（可选的后续增强） |
| `src/features/self-disclosure.ts` | 关键词检测 + 临时提醒（非常驻注入，省 token） |
| `src/features/scheduler.ts` | 定时主动开口的互动窗 |
