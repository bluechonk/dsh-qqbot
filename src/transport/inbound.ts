/**
 * 入站处理器 — 经 SDK 中间件链处理后的消息 → dsh Agent followup
 *
 * 内容组装逻辑：
 * - Layer 1: userContent（文本 + 语音转录）
 * - Layer 2: quotePart（引用消息块）
 * - Layer 3: userMessage（带发送者标签）
 * - Layer 4: dynamicCtx（媒体元数据）
 * - Layer 5: agentBody（history + base 拼合）
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionManager } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { ChatScope, Logger, QuotedAttachment, RawAttachment, ReplyTarget } from '../types.ts';
import {
  classifyContentType,
  isVoiceContentType,
  type DownloadedFile,
  type MediaKind,
} from './attachment.ts';
import { clearGroupHistory } from '../features/history-store.ts';
import { buildProfileLine, extractAlias, getPeopleStore } from '../features/people/index.ts';
import { buildRecentRepliesLine, getReplyHistory } from '../features/anti-repeat/index.ts';
import type { ProactiveDecision } from '../features/proactive/types.ts';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

// ── 类型定义 ──

interface ProcessedMessage {
  rawEventType: string;
  kind: 'c2c' | 'group';
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  groupOpenid?: string;
  msgType?: number;
  attachments?: RawAttachment[];
  [key: string]: unknown;
}

interface ResolvedQuote {
  text?: string;
  entry?: { senderId?: string; content?: string };
  attachments?: QuotedAttachment[];
}

interface HistoryEntry {
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  messageId: string;
}

interface MentionState {
  wasMentioned?: boolean;
}

interface MiddlewareState {
  quote?: ResolvedQuote;
  history?: HistoryEntry[];
  envelope?: string;
  mention?: MentionState;
  /** 自主接话门控的判定结果（见 src/features/proactive/types.ts） */
  proactive?: ProactiveDecision;
  processedAttachments?: ProcessedAttachment[];
  downloadedFiles?: DownloadedFile[];
  downloadedQuoteFiles?: DownloadedFile[];
  [key: string]: unknown;
}

interface ProcessedAttachment {
  type: 'voice' | 'image' | 'video' | 'file' | 'unknown';
  filename?: string;
  url?: string;
  localPath?: string;
  voiceText?: string;
  voiceSource?: 'stt' | 'asr' | 'fallback';
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
}

// ── 主处理函数 ──

/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(
  ctx: MiddlewareContext,
  manager: SessionManager,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  const msg = ctx.message as unknown as ProcessedMessage;
  const mwState = ctx.state as MiddlewareState;
  const { bot } = ctx;

  const scope: ChatScope = msg.kind === 'group' ? 'group' : 'c2c';
  const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;

  const replyTarget: ReplyTarget = {
    scope,
    targetId: peerId,
    msgId: msg.messageId,
  };

  // ── 群友档案：认人 + 记称呼 ──
  // 零成本启发式：不从模型要数据（qqchat 是零工具预设，模型没法调工具记人），
  // 只从消息信封取昵称、从自我介绍句式抽别名。
  const people = config.people.enabled ? getPeopleStore(true) : undefined;
  const alias = extractAlias(msg.content ?? '');
  const profile = people?.touch({
    appId: config.appId,
    scope,
    scopeId: scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : 'c2c',
    openid: msg.senderId,
    name: msg.senderName,
    alias,
  });
  const profileLine = buildProfileLine(profile, {
    isGroup: scope === 'group',
    maxAliases: config.people.maxAliases,
  });

  // ── 防复读：把「你最近说过什么」前置，让模型自己换说法 ──
  // 走预防而不是事后纠正——后者要多跑一轮模型，陪聊场景对延迟很敏感。
  const replyKey = manager.sessionKey(scope, peerId);
  const recentLine = config.antiRepeat.enabled
    ? buildRecentRepliesLine(
        getReplyHistory(config.antiRepeat.historySize).list(replyKey),
      )
    : '';

  // ── 组装 agentBody（下载结果经 mwState.downloadedFiles 提供） ──
  const agentBody = assembleAgentBody(
    msg, mwState, scope, logger, `${profileLine}${recentLine}`,
  );

  if (!agentBody) return;

  logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);

  // ── 获取或创建会话 ──
  let record;
  try {
    record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
  } catch (err) {
    logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
    // 兜底回复：会话创建失败时告知用户，避免静默无响应
    try {
      await bot.sendMarkdown(replyTarget, '⚠️ 处理消息时出现异常，请稍后重试。');
    } catch (sendErr) {
      logger.error(`fallback reply failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
    }
    return;
  }

  // ── 构建 UserMessage → followup ──
  const content: ContentBlock[] = [{ type: 'text' as const, text: agentBody }];

  const message = createUserMessage({
    content,
    source: { kind: 'user' as const },
  });

  record.agent.followup(message);
  logger.info(`→ followup sent: key=${scope}:${peerId}`);

  // 群消息回复后清空历史缓存（避免下次 @ 时重复组包）
  if (scope === 'group') {
    clearGroupHistory(config.appId, msg.groupOpenid ?? msg.senderId);
  }

  // 阻塞等待本轮 turn 收敛，避免后续消息在 turn 运行期间被 followup 打断
  try {
    await record.agent.whenIdle();
  } catch (err) {
    logger.warn(`whenIdle rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ══════════════════════════════════════════════════════════════
// Body Assembly（5 层组装）
// ══════════════════════════════════════════════════════════════

/**
 * 组装 agentBody — AI 实际看到的完整上下文
 *
 * 导出以便单测：这是「中间件状态 → 模型看到什么」的契约，
 * 拼接顺序错了（比如档案和防复读粘在一起）模型会误读，
 * 但不会有任何报错，所以必须有断言守住。
 */
export function assembleAgentBody(
  msg: ProcessedMessage,
  state: MiddlewareState,
  scope: ChatScope,
  logger: Logger,
  prefixHints = '',
): string | null {
  const isGroup = scope === 'group';
  const wasMentioned = state.mention?.wasMentioned ?? false;

  const userContent = buildUserContent(msg, state, logger);

  if (isEmptyMessage(userContent, msg.attachments, isGroup, wasMentioned)) return null;

  const quotePart = buildQuotePart(state.quote);
  const userMessage = buildUserMessage(userContent, quotePart, msg.senderId, msg.senderName, isGroup, wasMentioned);

  const dynamicCtx = buildDynamicCtx(msg, state);

  // 前置旁白：先「你是谁」（群友档案）+「你说过什么」（防复读），再「这条为什么值得接」
  const hints = `${prefixHints}${buildProactiveHint(state.proactive)}`;

  const inner = dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
  const base = hints ? `${hints}${inner}` : inner;
  const agentBody = buildAgentBody(base, state.history, isGroup, wasMentioned);

  return agentBody;
}

/**
 * 自主接话的背景提示（仅 mode='chose' 时给出）。
 *
 * 告诉模型：这条消息没有点名你，是系统粗筛后认为可能值得接话；
 * 若此刻插话自然就回一句，不该插就回 [skip] 表示沉默。
 */
function buildProactiveHint(decision: ProactiveDecision | undefined): string {
  if (decision?.mode !== 'chose') return '';
  return '【群聊背景】这条消息没有点名你，是系统粗筛后认为可能值得接话。'
    + '若此刻插话自然就回一句；若不该插，回 [skip] 表示本轮沉默。\n\n';
}

/**
 * 判断消息是否为空：无文本/语音/附件，且非群聊 @。
 * 群聊被 @ 视为有效触发信号，即使内容为空也保留给 agent。
 */
function isEmptyMessage(
  userContent: string,
  attachments: RawAttachment[] | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
): boolean {
  if (userContent) return false;
  if (attachments && attachments.length > 0) return false;
  if (isGroup && wasMentioned) return false;
  return true;
}

/**
 * Layer 1: 用户文本内容 + 语音转录 + 附件类型标签（媒体路径由 buildDynamicCtx 提供）
 */
function buildUserContent(msg: ProcessedMessage, state: MiddlewareState, logger: Logger): string {
  const parts: string[] = [];

  const text = (msg.content ?? '').trim();
  if (text) {
    parts.push(text);
  }

  const voiceTexts = extractVoiceTexts(msg.attachments, state.processedAttachments, logger);
  if (voiceTexts.length > 0) {
    for (const vt of voiceTexts) {
      const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
      parts.push(`[Voice message${durationTag}] ${vt.text}`);
    }
  }

  // 附件类型标签（媒体路径由 buildDynamicCtx 提供，这里只提示「带了什么」）
  const attachmentTags = buildAttachmentTags(msg.attachments);
  if (attachmentTags) {
    parts.push(attachmentTags);
  }

  return parts.join('\n');
}

/**
 * Layer 2: 引用消息块
 */
function buildQuotePart(quote?: ResolvedQuote): string {
  if (!quote?.text && !quote?.entry?.content) return '';

  const quoteText = quote.text || quote.entry?.content || 'Original content unavailable';

  return `[Quoted message begins]\n${quoteText}\n[Quoted message ends]\n[Current message]\n`;
}

/**
 * Layer 3: 带发送者标签的用户消息
 */
function buildUserMessage(
  userContent: string,
  quotePart: string,
  senderId: string,
  senderName: string | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
): string {
  if (!isGroup) {
    return `${quotePart}${userContent}`;
  }

  const mentionTag = wasMentioned ? ' (@you)' : '';
  const displayName = senderName ?? shortSenderId(senderId);
  const senderTag = `[${displayName} (${senderId})]`;
  return `${quotePart}${senderTag} ${userContent}${mentionTag}`;
}

/**
 * Layer 4: 媒体元数据上下文（图片/视频/文件本地路径 + 语音 ASR + 引用附件）
 */
function buildDynamicCtx(msg: ProcessedMessage, state: MiddlewareState): string {
  const lines: string[] = [];

  if (msg.attachments && msg.attachments.length > 0) {
    const downloadedByFilename = new Map((state.downloadedFiles ?? []).map(d => [d.filename, d]));
    const voices: RawAttachment[] = [];

    // 一次遍历归类 + 生成媒体行
    for (const att of msg.attachments) {
      const kind = classifyContentType(att.content_type);
      if (kind === 'voice') {
        voices.push(att);
        continue;
      }
      const d = downloadedByFilename.get(att.filename);
      lines.push(`- ${renderMediaLine(kind, att.filename, d?.localPath, att.url, att.size)}`);
    }

    // 语音：有 ASR 文本才带文本，否则只带链接（纯文本模型无法消费音频）
    if (voices.length > 0) {
      const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
      if (asrTexts.length > 0) {
        lines.push(`- ASR: ${asrTexts.join(' | ')}`);
      } else {
        const urls = voices.map(a => a.url).filter(Boolean);
        if (urls.length > 0) lines.push(`- Voice: ${urls.join(', ')}`);
      }
    }
  }

  // 引用消息的附件（独立于当前消息媒体，不受上一步为空影响）
  const quoteAttachments = state.quote?.attachments;
  if (quoteAttachments && quoteAttachments.length > 0) {
    const downloadedQuote = new Map((state.downloadedQuoteFiles ?? []).map(d => [d.filename, d]));
    lines.push('[Reference attachments]');
    for (const qa of quoteAttachments) {
      const kind = classifyContentType(qa.contentType);
      const d = downloadedQuote.get(qa.filename ?? '');
      if (kind === 'voice') {
        if (qa.asrText) lines.push(`  - Voice: ${qa.asrText}`);
        continue;
      }
      lines.push(`  - ${renderMediaLine(kind, qa.filename, d?.localPath, qa.url, undefined)}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') + '\n\n' : '';
}

/**
 * 渲染单个媒体附件（image/video/file）的上下文行内容，不含列表前缀。
 * 当前消息与引用消息共用，保证附件格式统一。语音不在此处理（见 buildDynamicCtx）。
 */
function renderMediaLine(
  kind: Exclude<MediaKind, 'voice'>,
  filename: string | undefined,
  localPath: string | undefined,
  url: string | undefined,
  size: number | undefined,
): string {
  switch (kind) {
    case 'image':
      return localPath
        ? `Image: ${localPath}`
        : `Image: ${url ?? filename ?? 'image'}`;
    case 'video':
      return localPath
        ? `Video: ${localPath}`
        : `Video: ${filename ?? 'video'} (download failed)`;
    case 'file':
      return localPath
        ? `File: ${localPath}`
        : `File: ${filename ?? 'file'} (${formatFileSize(size ?? 0)})`;
  }
}

/**
 * Layer 5: 最终 agentBody 拼合
 */
function buildAgentBody(
  base: string,
  history: HistoryEntry[] | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
): string {
  if (!isGroup || !wasMentioned || !history || history.length === 0) {
    return base;
  }

  const historyLines = history.map(h => {
    const name = h.senderName ?? shortSenderId(h.senderId);
    return `[${name} (${h.senderId})] ${h.content}`;
  });

  return [
    '[Chat history begins]',
    ...historyLines,
    '',
    '[Chat history ends]',
    '[Current message]',
    base,
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════
// 辅助函数
// ══════════════════════════════════════════════════════════════

interface VoiceText {
  text: string;
  duration?: number;
  source: 'stt' | 'asr' | 'fallback';
}

function extractVoiceTexts(
  attachments?: RawAttachment[],
  processed?: ProcessedAttachment[],
  _logger?: Logger,
): VoiceText[] {
  const results: VoiceText[] = [];

  if (processed) {
    for (const pa of processed) {
      if (pa.type === 'voice' && pa.voiceText) {
        results.push({
          text: pa.voiceText,
          duration: pa.duration,
          source: pa.voiceSource ?? 'stt',
        });
      }
    }
  }

  if (results.length === 0 && attachments) {
    for (const att of attachments) {
      if (isVoiceContentType(att.content_type) && att.asr_refer_text) {
        results.push({
          text: att.asr_refer_text.trim(),
          source: 'asr',
        });
      }
    }
  }

  return results;
}

/**
 * 附件类型标签（Layer 1 用户消息主体里的轻量提示）。
 * 只标注「带了什么类型的附件」，去重；媒体本地路径在 buildDynamicCtx 提供。
 */
function buildAttachmentTags(attachments?: RawAttachment[]): string {
  if (!attachments || attachments.length === 0) return '';

  const labels: Record<string, string> = {
    image: '[图片]',
    video: '[视频]',
    file: '[文件]',
  };

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const att of attachments) {
    const kind = classifyContentType(att.content_type);
    if (kind === 'voice' || seen.has(kind)) continue;
    seen.add(kind);
    const label = labels[kind];
    if (label) tags.push(label);
  }

  return tags.join(' ');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 发送者短标识长度（openid 前 N 位，无昵称时兜底） */
const SENDER_SHORT_ID_LEN = 8;

/** 无昵称时用 openid 前 N 位作为匿名标识 */
function shortSenderId(senderId: string): string {
  return senderId.slice(0, SENDER_SHORT_ID_LEN);
}
