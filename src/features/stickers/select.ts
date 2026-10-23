/**
 * 表情包 — 选图与发送时机
 *
 * 真人不是句句发表情。这里的规则全部来自 docs/拟人化路线图.md 的 4.4，
 * 核心是三条：
 *   1. 连续 N 条文字最多配 1 个表情（默认 N=3）
 *   2. 判断不出情绪就不发（配错比不配更尴尬）
 *   3. 同一张表情不连发（冷却期内换一张，换不出就不发）
 *
 * 还有一条容易被忽略但最关键：**表情包替代文字，而不是追加**。
 * 真人发表情常常只有一张图、零文字；每次都「文字 + 表情」反而假。
 */
import type { Sticker } from './catalog.ts';
import type { Mood } from './mood.ts';

/** 连续多少条纯文字之后才允许配一个表情 */
export const DEFAULT_MAX_TEXT_REPLIES = 3;
/** 同一张表情的冷却时间 */
export const DEFAULT_STICKER_COOLDOWN_MS = 10 * 60 * 1000;
/** 正文短于此长度时，表情可以**替代**文字（只发图不说话） */
export const REPLACE_TEXT_MAX_CHARS = 4;

/** 选图所需的运行状态（由调用方维护，纯内存） */
export interface StickerRuntimeState {
  /** 距上次发图已经历了几条纯文字回复 */
  textRepliesSinceSticker: number;
  /** 上次发出的表情 id */
  lastSentId?: string;
  /** 上次发表情的时刻 */
  lastSentAt?: number;
}

export interface SelectStickerParams {
  stickers: readonly Sticker[];
  /** 从回复文本推断出的情绪；undefined 表示判断不出 */
  mood: Mood | undefined;
  state: StickerRuntimeState;
  now?: number;
  maxTextReplies?: number;
  cooldownMs?: number;
}

export interface StickerDecision {
  /** 选中的表情；undefined 表示这次不发 */
  sticker?: Sticker;
  /** 人话理由（进日志） */
  reason: string;
  /** 是否应当用表情**替代**文字（而不是追加） */
  replaceText: boolean;
}

/**
 * 决定这次要不要配表情、配哪一张。
 *
 * 判定从「硬否决」开始，任一成立就返回不发：
 * 没情绪 → 图库空 → 文字条数不够 → 冷却中且换不出别的。
 */
export function selectSticker(params: SelectStickerParams): StickerDecision {
  const {
    stickers, mood, state,
    now = Date.now(),
    maxTextReplies = DEFAULT_MAX_TEXT_REPLIES,
    cooldownMs = DEFAULT_STICKER_COOLDOWN_MS,
  } = params;

  if (mood === undefined) return { reason: 'mood-unknown', replaceText: false };
  if (stickers.length === 0) return { reason: 'catalog-empty', replaceText: false };
  if (state.textRepliesSinceSticker < maxTextReplies) {
    return { reason: `too-soon(${state.textRepliesSinceSticker})`, replaceText: false };
  }

  // 情绪匹配的候选；顺带滤掉冷却期内的同一张
  const cooling = state.lastSentId !== undefined
    && state.lastSentAt !== undefined
    && now - state.lastSentAt < cooldownMs;

  const matching = stickers.filter((s) => s.mood === mood);
  if (matching.length === 0) return { reason: `no-sticker-for-${mood}`, replaceText: false };

  const usable = cooling ? matching.filter((s) => s.id !== state.lastSentId) : matching;
  if (usable.length === 0) return { reason: 'only-sticker-cooling', replaceText: false };

  // 优先「轻」的：同一个情绪下轻一点更不容易翻车
  const picked = usable.find((s) => s.strength === 'light') ?? usable[0];
  return { sticker: picked, reason: `mood-${mood}`, replaceText: false };
}

/**
 * 回复足够短时，用表情**替代**文字。
 *
 * 4 个字大概是「哼，又来？」这种长度的下限；更短的回复（「哦」「行吧」）
 * 配图不配字反而更自然，也更像真人。
 */
export function shouldReplaceText(reply: string): boolean {
  const text = String(reply ?? '').trim();
  if (text.length === 0) return false;
  // 去掉标点后再算长度，避免「……」被当成有内容
  const meaningful = text.replace(/[\s，。！？、；：,.!?;:…~～\-—]/g, '');
  return meaningful.length > 0 && meaningful.length <= REPLACE_TEXT_MAX_CHARS;
}

/** 发完一个表情后更新状态（供调用方回写） */
export function afterStickerSent(
  sticker: Sticker,
  now: number = Date.now(),
): StickerRuntimeState {
  return { textRepliesSinceSticker: 0, lastSentId: sticker.id, lastSentAt: now };
}

/** 发完一条纯文字后更新状态（供调用方回写） */
export function afterTextReply(state: StickerRuntimeState): StickerRuntimeState {
  return { ...state, textRepliesSinceSticker: state.textRepliesSinceSticker + 1 };
}
