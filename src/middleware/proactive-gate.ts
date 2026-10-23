/**
 * 主动接话门控 — 决定群消息要不要唤醒 AI
 *
 * 放在 mentionGate **之后**：mentionGate 已把 wasMentioned 写进 ctx.state.mention，
 * 这里直接读，不自己重复实现 @ 判定。
 *
 * 三种结果：
 *   - 被 @         → 必回（放行）
 *   - 自主判定值得 → 放行，并标记 proactive.mode='chose'（入站会加背景说明）
 *   - 判定不值得   → 拦截（消息留在 historyBuffer，不唤醒 AI）
 *
 * ⚠️ 异常一律吞掉并放行：主动接话层永远不能影响原有回话能力。
 */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import { createLexicalGate, stripMentions } from '../features/proactive/lexical-gate.ts';
import type { ProactiveDecision } from '../features/proactive/types.ts';
import type { ProactiveCooldown } from '../features/proactive/cooldown.ts';
import type { ProactiveObserver } from '../features/proactive/observer.ts';
import type { GroupActivity } from '../features/proactive/activity.ts';
import type { IdleTracker } from '../features/idle-topic/index.ts';

/** 门控选项 */
export interface ProactiveGateOptions {
  config: ImQQBotConfig;
  logger: Logger;
  cooldown: ProactiveCooldown;
  observer: ProactiveObserver;
  /** 群活跃度（M1 时机特征的数据源） */
  activity: GroupActivity;
  /** 冷场计时（M8 数据源） */
  idle: IdleTracker;
}

/** 消息上的 mention 状态（SDK mentionGate 写入） */
interface MentionState {
  wasMentioned?: boolean;
}

/** 消息上的 mentions 列表（SDK 解析的结构化 @ 列表） */
interface MentionEntry {
  is_you?: boolean;
}

/**
 * 检测 content 里是否含本机器人的 @ 标记。
 *
 * SDK 的 mentionGate 也做这件事，但它的判定建立在「平台一定下发某个字段」
 * 之上；这里按同样口径兜一遍，任一环节缺失都不至于把「@ 了她」误判成
 * 「没 @」。正则与 SDK 保持一致：`<@!appId>` 与 `<@appId>`。
 */
function detectMentionMarker(content: string, appId: string): boolean {
  if (!content || !appId) return false;
  const escaped = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<@!?${escaped}>`).test(content);
}

export function proactiveGate(options: ProactiveGateOptions) {
  const { config, logger, cooldown, observer, activity, idle } = options;
  const proactive = config.proactive;
  const gate = createLexicalGate({ minLength: proactive.minLength, minScore: proactive.minScore });
  const appId = config.appId;

  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    // 未启用 → 完全交给 mentionGate 的原有语义（零行为变更）
    if (!proactive.enabled) {
      await next();
      return;
    }

    try {
      const msg = ctx.message as unknown as {
        kind?: string;
        content?: string;
        groupOpenid?: string;
        senderId?: string;
        mentions?: MentionEntry[];
        rawEventType?: string;
      };
      // 私聊不受门控影响
      if (msg.kind !== 'group') {
        await next();
        return;
      }

      const state = ctx.state as { mention?: MentionState; proactive?: ProactiveDecision };
      const groupId = msg.groupOpenid ?? '';
      // 诊断用：@ 判定依赖这三者，出问题时日志里直接能看到
      const rawEventType = msg.rawEventType;
      const senderId = msg.senderId ?? '';
      const rawContent = msg.content ?? '';

      // 活跃度与冷场计时：**任何**群消息都要记（含被 @ 的），
      // 因为它们回答的是「这个群现在忙不忙」，与「这条要不要回」是两回事。
      activity.record(groupId, senderId);
      idle.recordMessage(groupId);

      // 被 @ → 必回。
      // ⚠️ 不只看 SDK 写的 state.mention：那个判定依赖 rawEventType 与
      // content 里的 <@!appId> 标记，平台侧字段缺失时（is_you 从无赋值处）
      // 会误判成"没被 @"。这里按同样口径再判一次，两条路任一命中即放行。
      const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
      const atMarkerInContent = detectMentionMarker(rawContent, appId);
      const mentionedSelf = state.mention?.wasMentioned === true
        || rawEventType === 'GROUP_AT_MESSAGE_CREATE'
        || mentions.some((m) => m?.is_you === true)
        || atMarkerInContent;

      if (mentionedSelf) {
        state.proactive = { mode: 'mentioned' };
        // 回写 SDK 的 mention 状态：下游（入站 isEmptyMessage / buildUserMessage）
        // 读的是 state.mention.wasMentioned，而 SDK 在 requireMention=false 时
        // 把它算成 false（它按"是否需要 @ 才回"的口径，不是"是否真的 @ 了"）。
        // 不回写的话，@ 她时 content 被 sanitizer 剥光 → 入站判为空消息 → 整条丢掉。
        state.mention = { ...(state.mention ?? {}), wasMentioned: true };
        observer.log({
          gid: groupId,
          decision: 'mentioned',
          rawEventType,
          mentionState: state.mention,
          atMarkerInContent,
          chars: rawContent.length,
        });
        await next();
        return;
      }

      // 这条 @ 的是别人 → 那轮对话的方向是别人
      const mentionedOthers = mentions.length > 0 && !mentions.some((m) => m?.is_you === true);

      const text = stripMentions(rawContent);

      // 时机特征（M1）：活跃度已在入口记过，这里只算当前窗口特征。
      const signals = activity.signals(groupId);

      const verdict = gate.evaluate({ text, mentioned: false, mentionedOthers, signals });

      // 判定失败（实现不可用）→ 按"未知"处理，不拦
      if (verdict === undefined) {
        await next();
        return;
      }

      const worth = verdict.worth;
      const cooldownLeft = cooldown.remaining(groupId);
      const hourlyUsed = cooldown.usedThisHour(groupId);
      const hourlyFull = cooldown.hourlyExhausted(groupId);

      observer.log({
        gid: groupId,
        score: verdict.score,
        worth,
        reason: verdict.reason,
        min: proactive.minScore,
        mentionOthers: mentionedOthers,
        cooldownLeft,
        hourlyUsed,
        hourlyFull,
        chars: text.length,
        rawEventType,
        mentionState: state.mention,
        // 时机特征（M1）：调阈值时这些比分数本身更有用
        recentMessages: signals.recentMessages,
        consecutiveSameSender: signals.consecutiveSameSender,
        sinceBotSpokeMs: signals.sinceBotSpokeMs,
      });

      if (!worth) {
        state.proactive = { mode: 'observed', score: verdict.score, reason: verdict.reason, blocked: 'not-worth' };
        logger.debug(`im-qqbot: proactive skip (not worth): score=${verdict.score.toFixed(3)} reason=${verdict.reason}`);
        ctx.stop('proactive:not-worth');
        return;
      }
      if (cooldownLeft > 0) {
        state.proactive = { mode: 'observed', score: verdict.score, reason: verdict.reason, blocked: 'cooldown' };
        logger.debug(`im-qqbot: proactive skip (cooldown ${cooldownLeft}ms left)`);
        ctx.stop('proactive:cooldown');
        return;
      }
      if (hourlyFull) {
        state.proactive = { mode: 'observed', score: verdict.score, reason: verdict.reason, blocked: 'hourly-cap' };
        logger.debug(`im-qqbot: proactive skip (hourly cap ${hourlyUsed})`);
        ctx.stop('proactive:hourly-cap');
        return;
      }

      // 值得接话 → 放行，并记账
      cooldown.record(groupId);
      state.proactive = { mode: 'chose', score: verdict.score, reason: verdict.reason };
      logger.info(`im-qqbot: proactive picked: score=${verdict.score.toFixed(3)} reason=${verdict.reason}`);
      await next();
    } catch (err) {
      logger.warn(`im-qqbot: proactive gate error, falling through: ${err instanceof Error ? err.message : String(err)}`);
      await next();
    }
  };
}
