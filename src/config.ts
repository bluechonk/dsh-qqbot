/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';
import type { ReasoningEffort } from './model/types.ts';
import { DEFAULT_INSTANCE_NS } from './shared/bind-protocol.ts';

/** 思考强度合法值（与 dsh-llm 的 ReasoningEffortId 对齐） */
export const REASONING_EFFORT_VALUES = ['off', 'low', 'medium', 'high', 'max'] as const;
export type { ReasoningEffort } from './model/types.ts';

export interface AccessControlConfig {
  /** C2C 访问模式 */
  c2cMode: 'open' | 'allowlist' | 'disabled';
  /** C2C 白名单（user openid） */
  c2cAllow: string[];
  /** 群聊访问模式 */
  groupMode: 'open' | 'allowlist' | 'disabled';
  /** 群聊白名单（group openid） */
  groupAllow: string[];
}

/**
 * 命令权限配置
 *
 * 平台不告诉机器人谁是它的创建者（QQ 机器人 API 没有 owner 概念），
 * 所以主人身份必须显式配置。
 */
export interface AdminConfig {
  /** 是否启用命令权限校验；关闭时所有人都能执行高权限命令（仅调试用） */
  enabled: boolean;
  /**
   * 管理员 openid 白名单。
   *
   * 是 **openid**（如 `EC162542C77F402DC4C07E3735E786A9`），不是 QQ 号——
   * 平台推给机器人的只有 openid。用 `/whoami` 查看自己的。
   */
  openids: string[];
}

export interface MediaConfig {
  /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
  enabled: boolean;
  /** 富媒体下载大小上限（MB），默认 200 */
  maxMB: number;
  /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
  ttlHours: number;
}

export interface VisionConfig {
  /** 是否启用视觉理解（qqbot_describe_image 工具） */
  enabled: boolean;
  /** 视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai） */
  provider: string;
  /** 视觉模型 id（如 qwen-vl-max） */
  model: string;
  /** 默认描述 prompt（调用未显式指定时使用） */
  defaultPrompt: string;
  /** 图片字节上限，默认 10MB */
  maxBytes: number;
  /** 输出 token 上限 */
  maxTokens: number;
  /** 视觉调用超时(ms) */
  timeoutMs: number;
}

export interface SendFileConfig {
  /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
  restrictPaths: boolean;
  /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
  extraRoots: string[];
}

/**
 * 默认 agent preset id —— QQ 聊天模式。
 *
 * 只是**默认值**：per-peer 偏好（/preset 切换）优先于此，两者都缺省时用它。
 * 本插件的会话跑在这个预设上时是零工具：不挂终端与文件工具，
 * 人格与说话风格由插件自带的 preset 定义（见 cordis.patch.yml 的 preset-qqchat）决定。
 */
export const FIXED_PRESET_ID = 'qqchat';

/**
 * 默认实例命名空间（= loader 行 id）。
 *
 * 多实例时每个实例必须有一个唯一 `settingsNs`：它决定绑定路由路径、
 * Web 设置分区 id、凭据落盘的 patch 条目 id，以及本地数据目录。
 * 缺省保持 `im-qqbot`，所以**单实例行为逐字不变**。
 *
 * 常量本身定义在 `shared/bind-protocol.ts`（纯模块，客户端也用），
 * 这里只是取个别名——四处必须同值，不能各写一份字面量。
 */
export const DEFAULT_SETTINGS_NS = DEFAULT_INSTANCE_NS;

export interface ImQQBotConfig {
  /** 实例命名空间（多实例时每实例唯一；缺省 `im-qqbot`） */
  settingsNs?: string;
  /** 实例显示名（页面上展示，便于区分多个机器人） */
  botName?: string;
  /** 是否启用该实例（停用则不建立连接、不响应消息） */
  enabled?: boolean;
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** dsh LLM 提供商名称 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /**
   * Agent preset id（插件级默认，优先级低于 per-peer 偏好）
   *
   * 留空则回落到 qqchat。切换是 per-peer 的（见 /preset 命令）。
   */
  preset?: string;
  /**
   * 思考强度：off / low / medium / high / max
   * 留空表示不覆盖，由宿主与模型默认决定。
   * qqchat 是陪聊模式，默认 off——秒回、话少，别让用户等思考。
   */
  reasoningEffort?: ReasoningEffort;
  /** Agent 工作目录（缺省回落到进程 cwd） */
  cwd?: string;
  /** 是否启用群消息 @mention 门控 */
  requireMention: boolean;
  /** 群聊额外 system prompt */
  groupPrompt?: string;
  /** 私聊额外 system prompt */
  directPrompt?: string;
  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 是否启用流式输出（群聊始终不启用） */
  streaming: boolean;
  /** 回复延迟：基础延迟(ms)，0=关闭（拟人节奏，秒回最像机器人） */
  replyDelayMs: number;
  /** 回复延迟：每字额外延迟(ms) */
  replyDelayPerCharMs: number;
  /** 回复延迟：随机抖动上限(ms) */
  replyDelayJitterMs: number;
  /** 回复延迟：单次上限(ms)，0=不封顶 */
  replyDelayMaxMs: number;
  /** 每会话最大闲置时长(ms)，超时自动回收 */
  sessionIdleTimeout: number;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** 处理超时(ms)，超时中断当前 LLM 调用 */
  processingTimeoutMs: number;
  /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
  askTimeoutMs: number;
  /** 群历史缓冲条数 */
  historyLimit: number;
  /** 访问控制 */
  access: AccessControlConfig;
  /** 命令权限（谁能执行高权限命令） */
  admin: AdminConfig;
  /** 自主接话（判断是否参与群聊对话） */
  proactive: ProactiveConfig;
  /** 群友档案（记住谁是谁） */
  people: PeopleConfig;
  /** 防复读（别把自己变成复读机） */
  antiRepeat: AntiRepeatConfig;
  /** 表情包（插件自主配图） */
  stickers: StickersConfig;
  /** 是否展示工具调用成功结果（工具错误始终展示） */
  showToolResults: boolean;
  /** 调试模式 */
  debug: boolean;
  /**
   * 未知网关事件留痕（→ ~/.dsh-qqbot/raw-events.jsonl）
   *
   * QQ 的「戳一戳」等能力在腾讯自家 SDK 的事件常量里查不到，
   * 记录原始事件才能判断平台是否真的推送。
   */
  rawEventLog: boolean;
  /**
   * 中间件链留痕（→ ~/.dsh-qqbot/middleware-events.jsonl）
   *
   * 中间件链上每个关卡都能让消息「消失」（去重 / 访问控制 / @ 门控 / 限流 /
   * 并发合并），命令被识别并处理也要留痕。默认开启：留痕是这类静默失效
   * 唯一的排查入口。
   */
  middlewareLog: boolean;
  /** 富媒体理解（图片/视频） */
  media: MediaConfig;
  /** 视觉理解（qqbot_describe_image 工具，走 dsh llm + attachments） */
  vision: VisionConfig;
  /** 附件发送（qqbot_send_file 工具） */
  sendFile: SendFileConfig;
}

/** 表情包配置 */
export interface StickersConfig {
  /** 是否启用（默认关：图库为空时无意义，且发送链路未接） */
  enabled: boolean;
  /** 连续多少条纯文字后才允许配一个表情 */
  maxTextReplies: number;
  /** 同一张表情的冷却时间(ms) */
  cooldownMs: number;
}

/** 防复读配置 */
export interface AntiRepeatConfig {
  /** 是否启用防复读（把「你最近说过」前置给模型） */
  enabled: boolean;
  /** 记住自己最近几条发言 */
  historySize: number;
}

/** 群友档案配置 */
export interface PeopleConfig {
  /** 是否启用群友档案（记住昵称、称呼、互动次数） */
  enabled: boolean;
  /** 注入提示时最多带几个别名（多了像背资料） */
  maxAliases: number;
}

/** 自主接话配置 */
export interface ProactiveConfig {
  /** 启用自主接话：未被点名时由系统判断是否值得回应 */
  enabled: boolean;
  /** 放行门槛（0~1），低于此分不唤醒 AI */
  minScore: number;
  /** 同群两次主动接话的最小间隔(ms) */
  cooldownMs: number;
  /** 同群每小时主动接话上限，0=不限制 */
  maxPerHour: number;
  /** 参与判定的最短文本长度（更短的视为无意义） */
  minLength: number;
  /** 是否记录判定日志（便于事后调阈值） */
  observer: boolean;
}

/** 访问控制子 Schema（独立导出：config 路由的服务端校验复用） */
export const AccessControlSchema: Schema<AccessControlConfig> = Schema.object({
  c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式'),
  c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单'),
  groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式'),
  groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单'),
});

/** 命令权限子 Schema */
export const AdminSchema: Schema<AdminConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('启用命令权限校验（关闭则所有人可执行高权限命令）'),
  openids: Schema.array(Schema.string()).default([]).description('管理员 openid 白名单'),
}).description('命令权限（谁能执行高权限命令）');

/** 表情包子 Schema */
export const StickersSchema: Schema<StickersConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('启用表情包（需先导入图库）'),
  maxTextReplies: Schema.number().default(3).description('连续多少条纯文字后才允许配一个表情'),
  cooldownMs: Schema.number().default(600000).description('同一张表情的冷却时间(ms)'),
}).description('表情包（插件自主配图）');

/** 防复读子 Schema */
export const AntiRepeatSchema: Schema<AntiRepeatConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('启用防复读（把「你最近说过」前置给模型）'),
  historySize: Schema.number().default(5).description('记住自己最近几条发言'),
}).description('防复读（别把自己变成复读机）');

/** 群友档案子 Schema */
export const PeopleSchema: Schema<PeopleConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('启用群友档案（记住昵称、称呼、互动次数）'),
  maxAliases: Schema.number().default(2).description('注入提示时最多带几个别名'),
}).description('群友档案（记住谁是谁）');

/** 自主接话子 Schema */
export const ProactiveSchema: Schema<ProactiveConfig> = Schema.object({
  enabled: Schema.boolean().default(true).description('启用自主接话（未被点名时由系统判断是否值得回应）'),
  minScore: Schema.number().default(0.55).description('自主接话放行门槛(0~1)'),
  cooldownMs: Schema.number().default(120000).description('同群两次主动接话的最小间隔(ms)'),
  maxPerHour: Schema.number().default(6).description('同群每小时主动接话上限，0=不限制'),
  minLength: Schema.number().default(6).description('参与判定的最短文本长度'),
  observer: Schema.boolean().default(true).description('记录判定日志到 ~/.dsh-qqbot/proactive-scores.jsonl'),
}).description('自主接话（判断是否参与群聊对话）');

export const ConfigSchema: Schema<ImQQBotConfig> = Schema.object({
  settingsNs: Schema.string().default(DEFAULT_SETTINGS_NS).description(
    '实例命名空间（多实例时每实例唯一，决定路由/设置分区/凭据条目/数据目录）'),
  botName: Schema.string().description('实例显示名（页面上区分多个机器人）'),
  enabled: Schema.boolean().default(true).description('是否启用该实例（停用则不建连接、不响应消息）'),
  appId: Schema.string().default('').description('QQ 机器人 AppID'),
  appSecret: Schema.string().default('').description('QQ 机器人 AppSecret'),
  provider: Schema.string().description('LLM provider name'),
  model: Schema.string().description('Model name'),
  preset: Schema.string().description('Agent preset id'),
  reasoningEffort: Schema.union(['off', 'low', 'medium', 'high', 'max']).description(
    '思考强度：off/low/medium/high/max，留空由宿主决定（qqchat 陪聊建议 off）'),
  cwd: Schema.string().description('Agent working directory'),
  requireMention: Schema.boolean().default(false).description('群聊是否需要@bot触发'),
  groupPrompt: Schema.string().description('群聊额外system prompt'),
  directPrompt: Schema.string().description('私聊额外system prompt'),
  textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
  streaming: Schema.boolean().default(false).description('是否启用流式输出（群聊始终不启用）'),
  replyDelayMs: Schema.number().default(1200).description('回复延迟基础值(ms)，0=关闭（拟人节奏）'),
  replyDelayPerCharMs: Schema.number().default(80).description('回复延迟每字增量(ms)'),
  replyDelayJitterMs: Schema.number().default(1500).description('回复延迟随机抖动上限(ms)'),
  replyDelayMaxMs: Schema.number().default(8000).description('回复延迟单次上限(ms)，0=不封顶'),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
  maxQueue: Schema.number().default(20).description('并发队列最大长度'),
  processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用'),
  askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示'),
  historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
  access: AccessControlSchema.default({
    c2cMode: 'open',
    c2cAllow: [],
    groupMode: 'open',
    groupAllow: [],
  }).description('访问控制'),
  admin: AdminSchema.default({
    // 安全默认：先锁上，主人用 /whoami 拿到 openid 再填进来
    enabled: true,
    openids: [],
  }).description('命令权限（谁能执行高权限命令）'),
  proactive: ProactiveSchema.default({
    enabled: true,
    minScore: 0.55,
    cooldownMs: 120000,
    maxPerHour: 6,
    minLength: 6,
    observer: true,
  }).description('自主接话（判断是否参与群聊对话）'),
  people: PeopleSchema.default({
    enabled: true,
    maxAliases: 2,
  }).description('群友档案（记住谁是谁）'),
  antiRepeat: AntiRepeatSchema.default({
    enabled: true,
    historySize: 5,
  }).description('防复读（别把自己变成复读机）'),
  stickers: StickersSchema.default({
    enabled: false,
    maxTextReplies: 3,
    cooldownMs: 600_000,
  }).description('表情包（插件自主配图）'),
  showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（错误始终展示）'),
  debug: Schema.boolean().default(false),
  rawEventLog: Schema.boolean().default(true).description(
    '记录未知网关事件到 ~/.dsh-qqbot/raw-events.jsonl（用于探测「戳一戳」等平台事件是否推送）'),
  middlewareLog: Schema.boolean().default(true).description(
    '记录中间件链留痕到 ~/.dsh-qqbot/middleware-events.jsonl（丢弃/越权/合并/命令处理）'),
  media: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）'),
    maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)'),
    ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期'),
  }).default({
    enabled: true,
    maxMB: 200,
    ttlHours: 24,
  }).description('富媒体理解配置'),
  vision: Schema.object({
    enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）'),
    provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）'),
    model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）'),
    defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt'),
    maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限'),
    maxTokens: Schema.number().default(1024).description('输出 token 上限'),
    timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)'),
  }).default({
    enabled: false,
    provider: '',
    model: '',
    defaultPrompt: 'Describe this image in detail.',
    maxBytes: 10 * 1024 * 1024,
    maxTokens: 1024,
    timeoutMs: 120000,
  }).description('视觉理解配置'),
  sendFile: Schema.object({
    restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）'),
    extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录'),
  }).default({
    restrictPaths: true,
    extraRoots: [],
  }).description('附件发送工具配置'),
});
