/**
 * OutboundBuffer — 出站文本缓冲
 *
 * 收集流式 chunk，流式优先投递（StreamingWriter），降级为静态发送。
 * 独立文件便于单测。
 */
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { SessionRecord } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { chunkMarkdownText } from './chunker.ts';
import { StreamingWriter } from './streaming-writer.ts';
import { isSkipReply } from '../shared/skip-marker.ts';

/** 流式输出节流间隔(ms)：连续 chunk 累积后停顿该间隔才推送 */
const STREAM_THROTTLE_MS = 200;

/** QQ 流式会话（openStream 返回） */
export interface StreamSessionLike {
  update(content: string): Promise<unknown>;
  complete(): Promise<unknown>;
}

/** QQ Bot 发送接口 */
export interface QQBotSender {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
  openStream(target: ReplyTarget): StreamSessionLike;
  /**
   * 上传并发送图片（表情包用）。
   *
   * 可选：旧版 SDK 没有该方法时降级为不发图，不影响文字回复。
   * `source.localPath` 由插件给出本地路径，SDK 负责上传。
   */
  sendImage?(
    target: ReplyTarget,
    source: { localPath: string },
    opts?: { content?: string },
  ): Promise<unknown>;
}

export class OutboundBuffer {
  private buffer = '';
  private flushing = false;
  private readonly writer: StreamingWriter | null;
  private readonly record: SessionRecord;
  private readonly bot: QQBotSender;
  private readonly limit: number;
  private readonly logger: Logger;
  /** 静态发送前的钩子（拟人延迟等）；返回 false 表示跳过发送 */
  private readonly beforeSend?: (text: string) => Promise<boolean>;

  public constructor(
    record: SessionRecord,
    bot: QQBotSender,
    limit: number,
    logger: Logger,
    streamingEnabled: boolean,
    beforeSend?: (text: string) => Promise<boolean>,
  ) {
    this.record = record;
    this.bot = bot;
    this.limit = limit;
    this.logger = logger;
    this.beforeSend = beforeSend;
    this.writer = streamingEnabled
      ? new StreamingWriter({ bot, target: record.replyTarget, logger, throttleMs: STREAM_THROTTLE_MS })
      : null;
  }

  /** 追加文本增量 */
  public append(text: string): void {
    this.buffer += text;
    this.writer?.append(text);
  }

  /** 获取当前累积文本 */
  public get text(): string {
    return this.buffer;
  }

  /** 重置累积文本（LLM 重试的新 attempt），流式会话保留由全量 update 重写 */
  public reset(): void {
    this.buffer = '';
    this.writer?.reset();
  }

  /**
   * 发送所有累积文本：流式优先，降级静态。
   *
   * @returns 是否**真的发出去了**。调用方据此决定要不要做后续记账
   *          （防复读流水、表情包、「她刚说过话」通知）——
   *          跳过（[skip]）或失败时返回 false，不能当成说过话。
   */
  public async flush(): Promise<boolean> {
    if (this.flushing || !this.buffer.trim()) return false;
    this.flushing = true;

    try {
      // 沉默标记：整段恰为标记时不发送
      if (isSkipReply(this.buffer)) {
        this.logger.info('im-qqbot: buffered reply skipped by model (silence marker)');
        this.writer?.abort();
        return false;
      }

      if (this.writer) {
        await this.writer.finish();
        // 流式成功（未降级）→ 内容已送达
        if (!this.writer.shouldFallback) return true;
      }

      // 降级：静态发送（writer 不存在 or 流式失败）
      if (this.beforeSend && !(await this.beforeSend(this.buffer))) return false;
      const chunks = chunkMarkdownText(this.buffer, this.limit);
      let sentAny = false;
      for (const chunk of chunks) {
        try {
          await this.bot.sendMarkdown(this.record.replyTarget, chunk);
          sentAny = true;
        } catch (err) {
          this.logger.error(`im-qqbot: sendMarkdown failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return sentAny;
    } catch (err) {
      this.logger.error(`im-qqbot: flush failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.buffer = '';
      this.flushing = false;
    }
  }

  /** 取消（异常/丢弃），中止流式并清空缓冲 */
  public cancel(): void {
    this.writer?.abort();
    this.buffer = '';
  }
}
