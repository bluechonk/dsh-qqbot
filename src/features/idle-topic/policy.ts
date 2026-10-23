/**
 * 冷场探测（M8 第一步）
 *
 * 目标：判断「这个群现在是不是冷场了，她该出来起个话题」。
 *
 * ⚠️ 为什么只做探测、不直接发消息：
 *   QQ 的**被动回复有 5 分钟窗口**（要用 msg_id / event_id）。冷场通常意味着
 *   距上一条消息已远超 5 分钟，只能走「主动消息」，而主动消息有配额限制
 *   （按群按月计）。配额没确认前贸然发，只会失败或浪费额度。
 *
 *   所以先把「什么时候该开口」这个判断做对、可观测，
 *   发消息等配额策略确定后接上即可。
 *
 * 本文件是纯函数：输入状态，输出「该不该起话题 + 理由」，便于单测。
 */

/** 一个群的冷场相关状态 */
export interface GroupIdleState {
  /** 群里最后一条消息的时刻；没有任何记录为 undefined */
  lastMessageAt?: number;
  /** 机器人最后一次在该群发言的时刻；从未发言为 undefined */
  lastBotSpokeAt?: number;
  /** 机器人最后一次在该群**主动起话题**的时刻；从未为 undefined */
  lastTopicAt?: number;
  /** 机器人今天在该群起过几次话题 */
  topicsToday: number;
  /** 机器人在该群是否发过言（没发过言说明交流基础不足，别硬起话题） */
  hasSpokenBefore: boolean;
}

/** 探测参数 */
export interface IdleTopicPolicy {
  /** 冷场多久算冷场（ms） */
  idleMs: number;
  /** 两次主动起话题的最小间隔（ms） */
  cooldownMs: number;
  /** 每群每天最多起几次 */
  maxPerDay: number;
}

/** 探测结果 */
export interface IdleVerdict {
  /** 是否该起话题 */
  should: boolean;
  /** 人话理由（进日志，便于调参） */
  reason: string;
  /** 已冷场多久（ms），便于观测 */
  idleForMs?: number;
}

/** 默认：冷场 30 分钟、间隔 6 小时、每天最多 1 次 */
export const DEFAULT_IDLE_POLICY: IdleTopicPolicy = {
  idleMs: 30 * 60 * 1000,
  cooldownMs: 6 * 60 * 60 * 1000,
  maxPerDay: 1,
};

/**
 * 判断该不该起话题。
 *
 * 判定顺序刻意从「硬否决」到「软条件」：
 * 任何一个否决条件成立就直接返回，避免出现「勉强满足 3 个条件就发」。
 */
export function evaluateIdle(
  state: GroupIdleState,
  policy: IdleTopicPolicy = DEFAULT_IDLE_POLICY,
  now: number = Date.now(),
): IdleVerdict {
  // 从没在这个群说过话 → 不该突然开口，那是刷屏不是陪聊
  if (!state.hasSpokenBefore) {
    return { should: false, reason: 'never-spoke-here' };
  }

  // 群里根本没有消息记录 → 无从判断冷场，别开口
  if (state.lastMessageAt === undefined) {
    return { should: false, reason: 'no-message-history' };
  }

  const idleForMs = now - state.lastMessageAt;
  if (idleForMs < policy.idleMs) {
    return { should: false, reason: `not-idle-yet(${Math.round(idleForMs / 60000)}m)`, idleForMs };
  }

  // 她刚在群里说过话 → 说明场子还没散，别急着起话题
  if (state.lastBotSpokeAt !== undefined) {
    const sinceBot = now - state.lastBotSpokeAt;
    if (sinceBot < policy.idleMs) {
      return { should: false, reason: `bot-spoke-recently(${Math.round(sinceBot / 60000)}m)`, idleForMs };
    }
  }

  // 两次主动起话题之间的间隔：这条比「每天上限」更重要，
  // 因为它防的是「一天之内连续两次」，正是最烦人的行为
  if (state.lastTopicAt !== undefined) {
    const sinceTopic = now - state.lastTopicAt;
    if (sinceTopic < policy.cooldownMs) {
      return { should: false, reason: `topic-cooldown(${Math.round(sinceTopic / 60000)}m)`, idleForMs };
    }
  }

  if (state.topicsToday >= policy.maxPerDay) {
    return { should: false, reason: `daily-cap(${state.topicsToday})`, idleForMs };
  }

  return { should: true, reason: 'idle-and-allowed', idleForMs };
}

/**
 * 渲染「起话题」的提示词。
 *
 * 关键约束都写在提示里：这不是在回应谁，所以不能复述、不能答非所问；
 * 冷场起话题的得体做法是**抛一个轻松、低门槛的话头**，不是发问句连击。
 */
export function buildIdlePrompt(idleForMs: number): string {
  const minutes = Math.max(1, Math.round(idleForMs / 60000));
  return [
    `【冷场】群里已经安静了约 ${minutes} 分钟，没人说话。`,
    '你可以主动起个话题，让气氛活起来。',
    '要求：这不是在回应谁，所以别复述、别答非所问；',
    '话头要轻松、低门槛，一句话就够；不想说就回 [skip]。',
  ].join('\n');
}
