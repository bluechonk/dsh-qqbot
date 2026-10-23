/**
 * 出站处理器 — dsh session/event → QQ 消息发送
 *
 * 采用路由器模式：OutboundRouter 持有会话级状态（文本缓冲、工具调用记录），
 * 事件解析归一化在 events.ts，路由按事件类型分发到私有方法。
 */
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { chunkMarkdownText } from './chunker.ts';
import { computeRemainingDelay, computeReplyDelay, sleep } from './reply-delay.ts';
import { isSkipReply } from '../shared/skip-marker.ts';
import { getReplyHistory } from '../features/anti-repeat/index.ts';
import {
  afterStickerSent,
  afterTextReply,
  getStickerCatalog,
  getStickerState,
  inferMood,
  resolveStickerPath,
  selectSticker,
  setStickerState,
  shouldReplaceText,
  type Sticker,
} from '../features/stickers/index.ts';
import { OutboundBuffer, type QQBotSender } from './outbound-buffer.ts';
import { formatToolResult, type ToolsRegistryLike, type ToolResultData } from './tool-presenter.ts';
import {
  parseEvent,
  extractTurnError,
  type ChunkEvent,
  type MessageEvent,
  type ToolCallEvent,
  type ToolResultEvent,
  type TurnEndEvent,
  type RawSessionEvent,
  type StreamDelta,
} from './events.ts';

export type { QQBotSender } from './outbound-buffer.ts';
export type { ToolsRegistryLike } from './tool-presenter.ts';
export { parseStreamFrame } from './events.ts';

/** 出站处理器签名（注册到 ctx.on('session/event')） */
export type OutboundHandler = (session: SessionLike, event: RawSessionEvent) => void;

/** 出站事件入口集合：durable 事件 + 实时流式帧 */
export interface OutboundHandlers {
  /** durable session 事件入口（注册到 ctx.on('session/event')） */
  routeSessionEvent(session: SessionLike, event: RawSessionEvent): void;
  /**
   * 实时流式帧入口（注册到 ctx.on('agent/assistant-stream', ..., { global: true })）。
   */
  routeStreamFrame(agentId: string, delta: StreamDelta): void;
}

/** dsh Session 简化类型 */
export interface SessionLike {
  header: { id: string };
}

/** 工具调用记录（tool/call 建立，tool/result 消费） */
interface ToolCallRecord {
  name: string;
  args: string;
}

/** 不展示给用户的轮次错误码（底层传输/网络错误，对用户无意义，且常被重试兜住） */
const SILENT_TURN_ERROR_CODES = new Set(['STREAM_CLOSED']);

/** blocked 会话的重建频率上限窗口与次数（防「重建后又被 blocked」反复抖动） */
const BLOCKED_RESET_WINDOW_MS = 10 * 60 * 1000;
const BLOCKED_RESET_MAX = 5;

/**
 * 出站路由器：持有会话级状态，按事件类型分发到处理器
 */
class OutboundRouter {
  private readonly buffers = new Map<string, OutboundBuffer>();
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  /** 每会话当前流式 attemptId：LLM 重试会发布新 attempt，用于 reset 与迟到帧过滤 */
  private readonly streamAttempts = new Map<string, string>();
  /**
   * 每会话的回合起始时刻（`turn/start` 到达时打点）。
   *
   * 拟人延迟以此为计时基准：延迟模拟的是「打字时间」，应当与模型思考**重叠**，
   * 而不是想完再额外等一段。慢模型（首 token 几十秒）几乎总能把延迟消化完，
   * 快模型才会真正等满——这才叫「该慢的慢、该等的等」。
   */
  private readonly turnStartedAt = new Map<string, number>();
  private readonly manager: SessionManager;
  private readonly bot: QQBotSender;
  private readonly config: ImQQBotConfig;
  private readonly logger: Logger;
  private readonly toolsRegistry: ToolsRegistryLike | undefined;
  /** 机器人发过群消息的通知回调（M1） */
  private readonly onBotSpoke: ((groupId: string) => void) | undefined;
  /** sessionKey → 最近因 blocked 而重建会话的时刻（防抖动） */
  private readonly blockedResets = new Map<string, number[]>();

  public constructor(
    manager: SessionManager,
    bot: QQBotSender,
    config: ImQQBotConfig,
    logger: Logger,
    toolsRegistry: ToolsRegistryLike | undefined,
    onBotSpoke?: (groupId: string) => void,
  ) {
    this.manager = manager;
    this.bot = bot;
    this.config = config;
    this.logger = logger;
    this.toolsRegistry = toolsRegistry;
    this.onBotSpoke = onBotSpoke;
  }

  /** 事件分发入口 */
  public route(session: SessionLike, raw: RawSessionEvent): void {
    const event = parseEvent(raw);
    if (event === undefined) return;

    const record = this.manager.findBySessionId(session.header.id);
    if (record === undefined) return;

    switch (event.type) {
      case 'turn/start':
        // 回合起点：出站延迟的计时基准（事件实时到达，用本地时钟打点即可）
        this.turnStartedAt.set(session.header.id, Date.now());
        break;
      case 'assistant/chunk':
        this.onChunk(session.header.id, record, event);
        break;
      case 'assistant/message':
        this.onMessage(session.header.id, record, event);
        break;
      case 'tool/call':
        this.onToolCall(event);
        break;
      case 'tool/result':
        this.onToolResult(record, event);
        break;
      case 'turn/end':
        this.onTurnEnd(session.header.id, record, event);
        break;
    }
  }

  /** durable assistant/chunk 事件的流式增量（历史格式兼容保留，当前宿主不再生产该事件） */
  private onChunk(sessionId: string, record: SessionRecord, event: ChunkEvent): void {
    this.appendChunk(sessionId, record, event.text);
  }

  /**
   * 实时流式帧入口（瞬态 agent/assistant-stream 事件）。
   *
   * attempt 语义：start 帧即新内容起点，无条件重置 buffer——清空旧 attempt 的
   * 累积文本但保留流式会话（QQ 流式 update 是全量替换，用户看到同一条消息被
   * 新内容重写）。不用 attemptId 对比判断"新 attempt"：agent replacement 后
   * attempt 计数重启、attemptId 可能与旧 agent 重叠（官方按 frame revision 的
   * gap 检测处理同一问题）。迟到帧（attemptId 不匹配）仍直接丢弃，防止旧
   * attempt 的尾巴混进新内容。
   */
  public routeStreamFrame(agentId: string, delta: StreamDelta): void {
    if (delta.kind === 'attempt-start') {
      this.streamAttempts.set(agentId, delta.attemptId);
      this.buffers.get(agentId)?.reset();
      return;
    }

    // text-delta：首帧未见 start 时自愈记录，迟到帧丢弃
    const current = this.streamAttempts.get(agentId);
    if (current === undefined) {
      this.streamAttempts.set(agentId, delta.attemptId);
    } else if (current !== delta.attemptId) {
      return;
    }

    const record = this.manager.findBySessionId(agentId);
    if (record === undefined) return;
    this.appendChunk(agentId, record, delta.text);
  }

  /** 获取或创建会话 buffer 并追加增量 */
  private appendChunk(sessionId: string, record: SessionRecord, text: string): void {
    let buffer = this.buffers.get(sessionId);
    if (buffer === undefined) {
      buffer = new OutboundBuffer(
        record,
        this.bot,
        this.config.textChunkLimit,
        this.logger,
        this.shouldStream(record),
        // 静态发送前走拟人延迟；返回 false 表示跳过
        async (body: string) => {
          if (isSkipReply(body)) {
            this.logger.info('im-qqbot: reply skipped by model (silence marker)');
            return false;
          }
          await this.delayBeforeSend(sessionId, body);
          return true;
        },
      );
      this.buffers.set(sessionId, buffer);
    }
    buffer.append(text);
  }

  /** 是否启用流式：配置开启 + c2c + 有 msgId（群聊不支持流式） */
  private shouldStream(record: SessionRecord): boolean {
    return this.config.streaming
      && record.replyTarget.scope === 'c2c'
      && !!record.replyTarget.msgId;
  }

  /** 完整 assistant 消息：有流式 buffer 则 flush，否则直接发送文本块 */
  private onMessage(sessionId: string, record: SessionRecord, event: MessageEvent): void {
    const buffer = this.buffers.get(sessionId);
    if (buffer !== undefined && buffer.text.trim()) {
      const streamedText = buffer.text;
      this.buffers.delete(sessionId);
      // ⚠️ 流式路径**不走 send()**，必须在这里补做后续记账：
      // 否则开了流式（私聊）时，防复读 / 表情包 / 「她刚说过话」会全部静默失效。
      void buffer.flush().then((delivered) => {
        if (!delivered) return; // [skip] 或发送失败 → 不算说过话
        this.afterReplySent(record, streamedText);
        // 文字已经流出去了，只能追加表情（无法替代）
        void this.appendSticker(record, streamedText);
      });
      return;
    }

    const textParts: string[] = [];
    for (const block of event.content) {
      if (block.type === 'text' && block.text) textParts.push(block.text);
    }
    const fullText = textParts.join('\n');
    if (!fullText.trim()) return;

    // 沉默标记：AI 判定此刻不该接话 → 不发送
    if (isSkipReply(fullText)) {
      this.logger.info('im-qqbot: reply skipped by model (silence marker)');
      this.buffers.delete(sessionId);
      return;
    }

    void this.send(record, fullText, 'sendMarkdown', true);
    this.buffers.delete(sessionId);
  }

  /** 工具调用：仅记录，不发送（避免刷屏，等待结果） */
  private onToolCall(event: ToolCallEvent): void {
    this.toolCalls.set(event.callId, { name: event.name, args: event.arguments });
  }

  /** 工具结果：错误始终发送，成功结果按开关 */
  private onToolResult(record: SessionRecord, event: ToolResultEvent): void {
    const call = this.toolCalls.get(event.callId);
    this.toolCalls.delete(event.callId);
    if (call === undefined) return;

    if (event.error === undefined && !this.config.showToolResults) return;

    const text = formatToolResult(
      call.name,
      call.args,
      event.raw as unknown as ToolResultData,
      this.toolsRegistry,
      record.agent,
    );
    if (!text) return;

    void this.send(record, text, 'sendToolResult');
  }

  /** 轮次结束：清理 buffer 与 attempt 跟踪状态，异常结束时告知用户 */
  private onTurnEnd(sessionId: string, record: SessionRecord, event: TurnEndEvent): void {
    const buffer = this.buffers.get(sessionId);
    if (buffer !== undefined) {
      if (buffer.text.trim()) {
        void buffer.flush();
      } else {
        buffer.cancel();
      }
      this.buffers.delete(sessionId);
    }
    this.streamAttempts.delete(sessionId);

    const failure = extractTurnError(event.reason);
    if (failure !== undefined && !SILENT_TURN_ERROR_CODES.has(failure.code)) {
      void this.send(record, `本轮异常结束\n\`${failure.code}\`: ${failure.message}`, 'sendTurnEndError');
    }

    // ⚠️ blocked：这一轮**根本没跑**（宿主 preStep 直接拒绝），既不产出回复也不报错。
    // 实测一旦进入 blocked 就**再也不会恢复**——每条消息都只 start→blocked，
    // 机器人彻底哑掉且无人知晓（真实案例：某会话连续 8 轮 blocked）。
    // 对策：丢弃该会话，让下一条消息重建一个干净的。
    if (event.reason?.kind === 'blocked') {
      this.handleBlockedTurn(record);
    }

    this.logger.debug(`im-qqbot: turn/end sessionId=${sessionId}`);
  }

  /**
   * 处理 blocked 轮次：丢弃会话以便下次重建。
   *
   * 为什么敢直接丢：blocked 意味着这一轮**什么都没产出**，不存在「丢掉半截回复」的问题；
   * 代价只是会话上下文（历史）丢失，而相比之下「永久哑掉」严重得多。
   *
   * 带频率上限是防「重建后又被 blocked」时陷入反复重建的抖动。
   */
  private handleBlockedTurn(record: SessionRecord): void {
    const now = Date.now();
    const recent = (this.blockedResets.get(record.sessionKey) ?? [])
      .filter((at) => now - at < BLOCKED_RESET_WINDOW_MS);

    if (recent.length >= BLOCKED_RESET_MAX) {
      // 窗口内重建太多次 → 不是偶发，别再抖了，但必须留痕
      this.logger.error(
        `im-qqbot: turn blocked ${recent.length + 1} times within `
        + `${Math.round(BLOCKED_RESET_WINDOW_MS / 60000)}min for key=${record.sessionKey}; `
        + 'session kept as-is to avoid a reset storm',
      );
      this.blockedResets.set(record.sessionKey, recent);
      return;
    }

    recent.push(now);
    this.blockedResets.set(record.sessionKey, recent);
    this.logger.error(
      `im-qqbot: turn blocked (no output produced); dropping session so the next message `
      + `rebuilds it: key=${record.sessionKey} sessionId=${record.sessionId}`,
    );
    void this.manager.remove(record.scope, record.peerId).catch((err: unknown) => {
      this.logger.error(
        `im-qqbot: failed to drop blocked session: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * 统一发送：切分 + 逐 chunk 发送 + 错误记录
   *
   * @param mimicDelay 是否走拟人延迟。只对**正常回复**开启；
   *                   工具结果与错误提示要立刻送到，不能被延迟拖住。
   */
  private async send(
    record: SessionRecord,
    text: string,
    tag: string,
    mimicDelay = false,
  ): Promise<void> {
    if (mimicDelay) await this.delayBeforeSend(record.sessionId, text);

    // ── 表情包（M5）──
    // 必须在发文字**之前**决定：短回复可能要用图**替代**文字，而不是追加。
    // 真人发表情常常只有一张图、零文字；每次都「文字+图片」反而假。
    const sticker = mimicDelay ? this.pickSticker(record, text) : undefined;
    const replaceText = sticker !== undefined && shouldReplaceText(text);

    let sentAny = false;
    if (!replaceText) {
      const chunks = chunkMarkdownText(text, this.config.textChunkLimit);
      for (const chunk of chunks) {
        try {
          await this.bot.sendMarkdown(record.replyTarget, chunk);
          sentAny = true;
        } catch (err) {
          this.logger.error(`im-qqbot: ${tag} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (sticker !== undefined) {
      // 兜底文字只在「刚才因为替代而没发文字」时才有意义：
      // 图发失败要补发原文，否则用户什么都收不到。传反了会静默丢消息。
      const sent = await this.sendSticker(record, sticker, replaceText ? text : '');
      if (sent) sentAny = true;
    } else if (mimicDelay) {
      // 没发图 → 文字计数 +1，攒够条数下次才可能配图
      setStickerState(record.sessionKey, afterTextReply(getStickerState(record.sessionKey)));
    }

    // 防复读 + 时机特征：两条发送路径（send / 流式 flush）共用同一套记账
    if (mimicDelay && sentAny) this.afterReplySent(record, text);
  }

  /**
   * 回复送达后的统一记账。
   *
   * 两条发送路径都必须调用，否则会出现「开了流式就静默失效」的差异：
   * 静态发送走 send()，流式走 OutboundBuffer.flush()，两者互不相通。
   */
  private afterReplySent(record: SessionRecord, text: string): void {
    // 防复读：只记**真正发出去的正常回复**（工具结果/错误提示不算她的话）
    if (this.config.antiRepeat.enabled) {
      getReplyHistory().record(record.sessionKey, text);
    }
    // 时机特征：通知「她刚在群里说过话」，让门控知道别连珠炮
    if (record.scope === 'group') this.onBotSpoke?.(record.peerId);
  }

  /** 流式路径专用：文字已经流出去了，只能追加表情，无法替代 */
  private async appendSticker(record: SessionRecord, text: string): Promise<void> {
    const sticker = this.pickSticker(record, text);
    if (sticker !== undefined) await this.sendSticker(record, sticker, '');
  }

  /**
   * 挑一张表情（M5）。任何一步不满足都返回 undefined，即这次不配图。
   *
   * 图库为空时整条路径静默跳过——没导入素材就等于这个功能不存在。
   */
  private pickSticker(record: SessionRecord, text: string): Sticker | undefined {
    if (!this.config.stickers.enabled) return undefined;

    // ⚠️ 没有 msgId 就不发图。
    //
    // SDK 的 sendMediaMessage 只透传 `msg_id`，**完全忽略 eventId**
    // （源码：`...(opts?.msgId ? { msg_id: opts.msgId } : {})`）。
    // 而回复目标可能是 event 型——按钮互动（提问卡片作答、审批）走的就是它。
    // 那种情况下发图会被当成**主动消息**：浪费按群按月的配额，且大概率直接失败。
    //
    // 宁可这次不配图：文字回复照常，只是少一张表情。
    if (!record.replyTarget.msgId) {
      this.logger.debug('im-qqbot: sticker skipped (no msgId → would become a proactive message)');
      return undefined;
    }

    const catalog = getStickerCatalog(true, this.config.settingsNs);
    const stickers = catalog.all();
    if (stickers.length === 0) return undefined;

    const decision = selectSticker({
      stickers,
      mood: inferMood(text),
      state: getStickerState(record.sessionKey),
      maxTextReplies: this.config.stickers.maxTextReplies,
      cooldownMs: this.config.stickers.cooldownMs,
    });

    if (decision.sticker === undefined) {
      this.logger.debug(`im-qqbot: sticker skipped (${decision.reason})`);
      return undefined;
    }
    this.logger.info(`im-qqbot: sticker picked id=${decision.sticker.id} reason=${decision.reason}`);
    return decision.sticker;
  }

  /**
   * 发送一张表情图。
   *
   * 发出去才算数：失败时**回退为纯文字**（如果刚才因为替代而没发文字，
   * 这里要补发，否则用户什么都收不到）。
   */
  private async sendSticker(
    record: SessionRecord,
    sticker: Sticker,
    fallbackText: string,
  ): Promise<boolean> {
    const filePath = resolveStickerPath(sticker.file, this.config.settingsNs);
    if (this.bot.sendImage === undefined) {
      this.logger.warn('im-qqbot: sendImage unavailable in SDK, skip sticker');
      return false;
    }

    try {
      await this.bot.sendImage(record.replyTarget, { localPath: filePath });
      setStickerState(record.sessionKey, afterStickerSent(sticker));
      return true;
    } catch (err) {
      this.logger.error(
        `im-qqbot: sticker send failed id=${sticker.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // 图没发出去 → 别让用户静默收不到任何东西
      if (fallbackText) {
        try {
          await this.bot.sendMarkdown(record.replyTarget, fallbackText);
        } catch {
          /* 已尽力 */
        }
      }
      setStickerState(record.sessionKey, afterTextReply(getStickerState(record.sessionKey)));
      return false;
    }
  }

  /**
   * 发送前的拟人延迟（与模型思考时间重叠）。
   *
   * 真人在群里打字要时间，秒回是最明显的机器人特征。但延迟不该**叠加**在
   * 模型耗时之后：模型已经想了几十秒时，再等 2 秒纯属给用户体验添堵。
   *
   * 所以计时基准取**回合起点**（`turn/start`）：
   *   remaining = 目标延迟 − 已经过去的时间
   *   remaining ≤ 0 → 立刻发（模型本身够慢了）
   *   remaining > 0 → 只等剩下的部分（模型太快，补上拟人节奏）
   */
  private async delayBeforeSend(sessionId: string, text: string): Promise<void> {
    const targetMs = computeReplyDelay(text, {
      baseMs: this.config.replyDelayMs,
      perCharMs: this.config.replyDelayPerCharMs,
      jitterMs: this.config.replyDelayJitterMs,
      maxMs: this.config.replyDelayMaxMs,
    });
    if (targetMs <= 0) return;

    const startedAt = this.turnStartedAt.get(sessionId);
    const elapsedMs = startedAt === undefined ? 0 : Date.now() - startedAt;
    const remainingMs = computeRemainingDelay(targetMs, elapsedMs);
    if (remainingMs <= 0) {
      this.logger.debug(`im-qqbot: reply delay absorbed by turn time (${elapsedMs}ms ≥ ${targetMs}ms)`);
      return;
    }
    this.logger.debug(`im-qqbot: reply delay ${remainingMs}ms (target ${targetMs}ms, elapsed ${elapsedMs}ms)`);
    await sleep(remainingMs);
  }
}

/**
 * 创建出站事件处理器
 *
 * 返回 durable 事件与实时流式帧两个入口，分别注册到
 * ctx.on('session/event') 与 ctx.on('agent/assistant-stream', ..., { global: true })。
 * toolsRegistry 用于工具结果的结构化展示。
 */
export function createOutboundHandler(
  manager: SessionManager,
  bot: QQBotSender,
  config: ImQQBotConfig,
  logger: Logger,
  toolsRegistry?: ToolsRegistryLike,
  /**
   * 机器人发出群消息后的回调（M1 时机特征用）。
   *
   * 只传回调而不是整个 GroupActivity：出站层不需要知道「活跃度」这个概念，
   * 它只需要在「我说话了」时通知一声，依赖方向更干净。
   */
  onBotSpoke?: (groupId: string) => void,
): OutboundHandlers {
  const router = new OutboundRouter(manager, bot, config, logger, toolsRegistry, onBotSpoke);
  return {
    routeSessionEvent: (session, event) => router.route(session, event),
    routeStreamFrame: (agentId, delta) => router.routeStreamFrame(agentId, delta),
  };
}
