/**
 * SessionManager — 管理 QQ peer → dsh Agent 的映射和生命周期
 *
 * sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`
 *   - c2c:   peerId = senderId (用户 openid)
 *   - group: peerId = groupOpenid
 *
 * SessionId 由 sessionKey 确定性派生（SHA-256），
 * 保证同一个用户/群的消息始终路由到同一个会话，
 * 重启后可根据 key 恢复 session。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { createHash, randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { FIXED_PRESET_ID, type ImQQBotConfig } from '../config.ts';
import { ModelResolver } from '../model/model-resolver.ts';
import type { ModelRoute, ModelEntry } from '../model/types.ts';
import { IdleEvictor } from './idle-evictor.ts';
import type { QuestionChannel } from '../features/question-channel.ts';
import type { ApprovalChannel } from '../features/approval-channel.ts';
import type {
  SessionEventLike,
  DshAgent,
  DshAgentHandle,
  DshAgentRegistry,
  AgentPresetsLike,
  PresetComposition,
  SessionRecord,
  SessionStatus,
  TokenUsageStats,
  CompactionServiceLike,
  CompactOutcome,
} from './types.ts';

/** ManualCompactionError 各 code 的友好提示 */
const COMPACTION_ERROR_HINTS: Record<string, string> = {
  busy: '压缩服务忙，请稍后重试',
  cancelled: '压缩已取消',
  changed: '历史在压缩过程中发生变化，请重试',
  commit: '压缩提交失败',
  persistence: '压缩完成但保存失败',
};

/** system-prompt section 最小结构（name/order/text） */
interface PromptSection {
  name: string;
  order: number;
  text: string;
}

/** system-prompt/assemble waterfall 的 context 最小结构 */
interface AssembleContext {
  agent?: DshAgent;
}

/** system-prompt/assemble 的组装产物最小结构 */
interface AssembledPrompt {
  sections?: PromptSection[];
  [key: string]: unknown;
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  private readonly evictor: IdleEvictor;
  private readonly modelResolver: ModelResolver;
  private readonly ctx: Context;
  private readonly agents: DshAgentRegistry;
  private readonly config: ImQQBotConfig;
  private readonly logger: Logger;
  /** 由 bootstrap 注入的问答通道（ask_user_question → QQ），会话回收时清理其待答问题 */
  public questionChannel?: QuestionChannel;
  /** 由 bootstrap 注入的审批通道（approval/request → QQ），会话回收时清理其待批审批 */
  public approvalChannel?: ApprovalChannel;

  constructor(
    ctx: Context,
    agents: DshAgentRegistry,
    config: ImQQBotConfig,
    logger: Logger,
  ) {
    this.ctx = ctx;
    this.agents = agents;
    this.config = config;
    this.logger = logger;
    this.modelResolver = new ModelResolver(ctx, config, logger);

    this.evictor = new IdleEvictor(
      this.sessions,
      config.sessionIdleTimeout,
      (key, record) => {
        this.logger.info(`evicting idle session: key=${key}`);
        this.sessions.delete(key);
        record.agent.cancel({ kind: 'user' });
        void record.handle.dispose().catch(() => {});
        // 回收会话时统一清理其待答问题/待批审批，避免 pending 悬挂泄漏
        this.questionChannel?.cancelPending(key);
        this.approvalChannel?.cancelPending(key);
      },
    );

    this.registerScopePromptInjection();
  }

  /**
   * 通过 system-prompt/assemble waterfall 注入群聊/私聊额外 system prompt。
   *
   * 该事件在每次 turn 构建 request 时触发；此处按会话 scope（群聊/私聊）
   * 追加对应的额外 prompt section。会话尚未建立（首次 assemble）或未配置
   * 额外 prompt 时原样返回，不做改动。
   */
  private registerScopePromptInjection(): void {
    const assemble = async (
      _assembly: unknown,
      context: AssembleContext,
      next: () => Promise<AssembledPrompt>,
    ): Promise<AssembledPrompt> => {
      const assembled = await next();
      if (!context.agent) return assembled;

      const record = this.findByAgent(context.agent);
      if (!record) return assembled;

      const prompt = record.scope === 'group' ? this.config.groupPrompt : this.config.directPrompt;
      if (!prompt) return assembled;

      return {
        ...assembled,
        sections: [...(assembled.sections ?? []), { name: 'qqbot:scope-prompt', order: 90, text: prompt }],
      };
    };

    (this.ctx as unknown as {
      on(event: 'system-prompt/assemble', handler: typeof assemble): void;
    }).on('system-prompt/assemble', assemble);
  }

  /**
   * 动态获取 agentPresets 服务（可选，未注入时返回 undefined）
   */
  private getPresetsService(): AgentPresetsLike | undefined {
    try {
      return this.ctx.get('agentPresets') as AgentPresetsLike | undefined;
    } catch {
      return undefined;
    }
  }

  // ── 模型相关（委托给 ModelResolver） ──

  getEffectiveModel(scope: ChatScope, peerId: string): ModelRoute | undefined {
    return this.modelResolver.getEffectiveRoute(this.sessionKey(scope, peerId));
  }

  /**
   * 获取指定 peer 的生效 preset。
   *
   * 固定为 qqchat：per-peer 覆盖与 config.preset 均不再生效——
   * 本插件只跑 QQ 聊天模式，不支持切换到其他预设。
   */
  getEffectivePreset(scope: ChatScope, peerId: string): string | undefined {
    return this.getEffectivePresetByKey(this.sessionKey(scope, peerId));
  }

  /** 按 sessionKey 解析生效 preset（固定 qqchat） */
  private getEffectivePresetByKey(_key: string): string | undefined {
    return FIXED_PRESET_ID;
  }

  /**
   * 切换模型（重建会话，保留历史）
   */
  async setModelOverride(scope: ChatScope, peerId: string, route: ModelRoute): Promise<void> {
    const key = this.sessionKey(scope, peerId);

    this.modelResolver.setOverride(key, route);

    const record = this.sessions.get(key);
    if (!record) {
      this.logger.info(`model pref saved (no active session): key=${key} → ${route.provider}/${route.model}`);
      return;
    }

    await this.rebuildSession(record, { route });
    this.logger.info(`model switched (session rebuilt): key=${key} → ${route.provider}/${route.model}`);
  }

  /**
   * 重建会话（保留历史，换 model）
   *
   * options.route 缺省时沿用当前生效值。preset 沿用当前生效 preset（getEffectivePresetByKey）。
   * 取不到源会话事件时降级为 dispose（下次消息重建）。
   *
   * 注意：**不用 `sessions.fork()`**。它返回的是新建的子会话对象而非事件数组，
   * 且每次调用都会真的建一个会话（留孤儿）。详见 `snapshotSessionEvents` 的说明。
   */
  private async rebuildSession(
    record: SessionRecord,
    options: { route?: ModelRoute },
  ): Promise<void> {
    const key = record.sessionKey;

    // 直接取源会话的事件作为新会话 seed。
    //
    // ⚠️ 不能再用 `sessions.fork(source).events`：
    //   1. DSH 的 `fork()` 返回的是**新建的子会话对象**（`@returns The created
    //      live child session.`），不是 `{ events }`。按旧契约读 `.events`
    //      得到 undefined，`seed.length` 会抛
    //      "Cannot read properties of undefined (reading 'length')"。
    //   2. 它每次调用都会**真的建一个会话**，拿来当数据源会留下孤儿会话。
    const seed = snapshotSessionEvents(record.agent.session);
    if (seed === undefined) {
      this.logger.warn(`session events unavailable, fallback to dispose: key=${key}`);
      this.sessions.delete(key);
      record.agent.cancel({ kind: 'user' });
      await record.handle.dispose().catch(() => {});
      return;
    }

    const childId = SessionId(randomUUID());
    const effectiveRoute = options.route ?? this.modelResolver.getEffectiveRoute(key);
    const composed = await this.composePreset(this.getEffectivePresetByKey(key));
    const created = await this.agents.create({
      sessionId: childId,
      seed,
      meta: {
        cwd: this.config.cwd || process.cwd(),
        parentSession: record.sessionId,
        seedLength: seed.length,
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
      ...(effectiveRoute ? { agentOptions: effectiveRoute } : {}),
      ...(composed.setup ? { setup: composed.setup } : {}),
    });

    this.modelResolver.setSessionId(key, childId);

    const oldHandle = record.handle;
    record.sessionId = childId;
    record.agent = created.agent;
    record.handle = created;
    record.agentPreset = composed.agentPreset;
    record.lastActivity = Date.now();

    void oldHandle.dispose().catch(() => {});
    this.logger.info(`session rebuilt: key=${key} preset=${composed.agentPreset ?? 'none'} sessionId=${childId}`);
  }

  clearModelOverride(scope: ChatScope, peerId: string): void {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearOverride(key);
    this.modelResolver.clearSessionId(key);
  }

  async listAvailableModels(): Promise<ModelEntry[]> {
    return this.modelResolver.listModels();
  }

  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  // ── 会话状态 / 统计 ──

  getSessionRecord(scope: ChatScope, peerId: string): SessionRecord | undefined {
    return this.sessions.get(this.sessionKey(scope, peerId));
  }

  getStatus(scope: ChatScope, peerId: string): SessionStatus {
    const record = this.getSessionRecord(scope, peerId);
    const route = this.getEffectiveModel(scope, peerId);

    return {
      active: !!record,
      sessionId: record?.sessionId,
      provider: route?.provider,
      model: route?.model,
      preset: record?.agentPreset,
      lastActivity: record?.lastActivity,
      messageCount: this.countMessages(record),
    };
  }

  getTokenUsage(scope: ChatScope, peerId: string): TokenUsageStats {
    const record = this.getSessionRecord(scope, peerId);
    const stats: TokenUsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    const events = record?.agent.session.events;
    if (!events) return stats;

    for (const event of events) {
      if (event.type !== 'assistant/message' || !event.usage) continue;
      stats.input += event.usage.input ?? 0;
      stats.output += event.usage.output ?? 0;
      stats.cacheRead += event.usage.cacheRead ?? 0;
      stats.cacheWrite += event.usage.cacheWrite ?? 0;
    }

    return stats;
  }

  exportMarkdown(scope: ChatScope, peerId: string): string {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return '';

    const events = record.agent.session.events;
    if (!events || events.length === 0) return '';

    const lines: string[] = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];

    for (const event of events) {
      if (event.type === 'user/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 用户\n\n${text}\n`);
      } else if (event.type === 'assistant/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 助手\n\n${text}\n`);
      }
    }

    return lines.join('\n');
  }

  private countMessages(record: SessionRecord | undefined): number {
    const events = record?.agent.session.events;
    if (!events) return 0;

    let count = 0;
    for (const event of events) {
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        count += 1;
      }
    }
    return count;
  }

  // ── Session 生命周期管理 ──

  sessionKey(scope: ChatScope, peerId: string): string {
    return `qqbot:${this.config.appId}:${scope}:${peerId}`;
  }

  private deriveSessionId(sessionKey: string): string {
    const hash = createHash('sha256').update(sessionKey).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  private currentSessionId(sessionKey: string): string {
    return this.modelResolver.getSessionId(sessionKey) ?? this.deriveSessionId(sessionKey);
  }

  private async composePreset(presetId?: string): Promise<PresetComposition> {
    const presets = this.getPresetsService();
    if (!presets) return {};

    try {
      const resolved = await presets.resolve(presetId);
      const resolvedId = resolved.id;
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx: Context) => {
          await presets.mount(agentCtx, resolvedId);
        },
      };
    } catch (err) {
      this.logger.warn(
        `im-qqbot: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`,
      );
      return {};
    }
  }

  /** 获取或恢复或创建会话（get → resume → create） */
  async getOrCreate(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SessionRecord> {
    const key = this.sessionKey(scope, peerId);
    const existing = this.sessions.get(key);

    if (existing) {
      existing.replyTarget = replyTarget;
      existing.lastActivity = Date.now();
      return existing;
    }

    const route = this.modelResolver.getEffectiveRoute(key);
    const sessionId = SessionId(this.currentSessionId(key));
    this.logger.info(`getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);

    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;

    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      this.logger.info(`reusing live agent: key=${key}`);
    } else {
      // preset 只解析一次：resume/create 共用同一组合，避免重复 resolve/mount 目录。
      // 固定 qqchat：连同 session 当初记录的 preset 一并忽略，
      // 保证旧会话恢复后也回到 QQ 聊天模式，不被历史 preset 拖住。
      const presetId = FIXED_PRESET_ID;
      const composed = await this.composePreset(presetId);
      agentPreset = composed.agentPreset;
      try {
        const resumeRoute = this.modelResolver.getResumeRoute(key);
        const resumed = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = resumed.agent;
        handle = resumed;
        this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
      } catch {
        const created = await this.agents.create({
          sessionId,
          meta: {
            cwd: this.config.cwd || process.cwd(),
            ...(agentPreset ? { agentPreset } : {}),
          },
          ...(route ? { agentOptions: route } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = created.agent;
        handle = created;
        this.logger.info(`created new session: key=${key} preset=${agentPreset ?? 'none'}`);
      }
    }

    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      replyTarget,
      scope,
      peerId,
      senderId,
      lastActivity: Date.now(),
      agentPreset,
    };

    this.sessions.set(key, record);
    return record;
  }

  findBySessionId(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record;
    }
    return undefined;
  }

  findByAgent(agent: DshAgent): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record;
    }
    return undefined;
  }

  async remove(scope: ChatScope, peerId: string): Promise<void> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    this.modelResolver.setSessionId(key, randomUUID());

    if (!record) return;
    this.sessions.delete(key);
    record.agent.cancel({ kind: 'user' });
    await record.handle.dispose().catch(() => {});
    this.logger.info(`session removed: key=${key}`);
  }

  /**
   * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
   *
   * 需通过 agentPresets.serviceFor(agent, 'compaction') 解析；未挂载时优雅降级。
   * 这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
   */
  async compact(scope: ChatScope, peerId: string): Promise<CompactOutcome> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (!record) return { ok: false, reason: 'no-session' };
    if (record.agent.status !== 'idle') return { ok: false, reason: 'busy' };

    let compaction: CompactionServiceLike | undefined;
    try {
      const presets = this.getPresetsService();
      compaction = (presets?.serviceFor(record.agent, 'compaction') ?? this.ctx.get('compaction')) as CompactionServiceLike | undefined;
    } catch {
      compaction = undefined;
    }
    if (!compaction) return { ok: false, reason: 'unavailable' };

    const route = this.modelResolver.getEffectiveRoute(key);
    const agentCtx = {
      session: record.agent.session,
      options: { provider: route?.provider, model: route?.model },
      runMaintenance: record.agent.runMaintenance.bind(record.agent),
    };

    try {
      const result = await compaction.compactNow(agentCtx, new AbortController().signal);
      if (result === null) return { ok: true, shadowed: 0, tokens: 0 };
      return { ok: true, shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // summary = 摘要没有更小 = 历史不足以压缩，属正常结果而非失败
      if (code === 'summary') {
        return { ok: true, shadowed: 0, tokens: 0 };
      }
      // 其他 ManualCompactionError 预期失败，给友好文案（debug 记录，不 warn 刷屏）
      if (code !== undefined && code in COMPACTION_ERROR_HINTS) {
        this.logger.debug(`compact declined: key=${key} code=${code}`);
        return { ok: false, reason: 'failed', message: COMPACTION_ERROR_HINTS[code] };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`compact failed: key=${key} err=${message}`);
      return { ok: false, reason: 'failed', message };
    }
  }

  async disposeAll(): Promise<void> {
    this.evictor.dispose();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    for (const record of records) {
      record.agent.cancel({ kind: 'user' });
    }
    await Promise.allSettled(records.map((r) => r.handle.dispose()));
    this.logger.info(`all sessions disposed (count=${records.length})`);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** 从消息对象中提取纯文本（用于导出/统计） */
function extractMessageText(
  message: SessionEventLike['message'],
): string {
  const blocks = message?.content;
  if (!blocks || !Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * 取会话当前事件快照，作为新会话 seed。
 *
 * 优先 `snapshotEvents()`（DSH Session 的官方读法，fork 内部也用它），
 * 退化到 `.events` 属性（旧宿主）。两者都拿不到返回 undefined，
 * 由调用方降级为「丢弃会话、下次消息重建」。
 *
 * 单独抽出来是因为这里最容易踩 DSH 的版本差异坑：
 * `sessions.fork()` 返回的是**子会话对象**而不是事件数组。
 */
export function snapshotSessionEvents(session: unknown): readonly unknown[] | undefined {
  if (session === null || typeof session !== 'object') return undefined;
  const candidate = session as {
    snapshotEvents?: () => unknown;
    events?: unknown;
  };

  try {
    if (typeof candidate.snapshotEvents === 'function') {
      const snapshot = candidate.snapshotEvents();
      if (Array.isArray(snapshot)) return snapshot;
    }
  } catch {
    /* 落到下面继续尝试 */
  }

  return Array.isArray(candidate.events) ? candidate.events : undefined;
}
