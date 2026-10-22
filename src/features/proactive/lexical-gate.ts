/**
 * 词法价值门控 — 零依赖、零 token 的 L1 粗筛
 *
 * 思路：不上模型，用一组可解释的句式/噪声特征给群消息打分。
 * 目的是**挡掉明显不值得唤醒 AI 的消息**，而不是精准判断话题价值。
 * 精准判断交给 L2（AI 在回合内自己决定说不说）。
 *
 * 调参约定：
 *   - 基础分 0.5，特征加减后 clamp 到 [0,1]
 *   - 门槛由配置 proactive.minScore 决定，低于门槛不唤醒 AI
 *   - 分数高不等于"该接话"，只意味着"值得让 AI 看看"
 *
 * ⚠️ 语义纠正（不要写反）：
 *   **没被 @ 恰恰是她该主动接话的常态**，所以"没被 @"绝不扣分；
 *   真正该扣分的是"这句 @ 的是别人"——那轮对话的方向是别人，插嘴不自然。
 */
import type { ProactiveCandidate, ValueGate, ValueVerdict } from './types.ts';

/** 疑问句式（群里提问最需要有人接） */
const QUESTION_WORDS = [
  '吗', '呢', '怎么', '为什么', '为何', '如何', '哪', '谁', '多少',
  '是不是', '有没有', '能不能', '可不可以', '咋', '多少',
];

/** 求助词（明确在找人帮忙） */
const HELP_WORDS = [
  '帮帮我', '帮忙', '求助', '请教', '救命', '咋办', '怎么办', '求个', '求教', '谁知道',
];

/** 呼朋唤友（面向全群抛问题） */
const OPENING_WORDS = ['有没有人', '大家', '请问', '求问', '在吗', '有人在吗'];

/** 灌水噪声（接梗/水群，通常不值得唤醒 AI） */
const NOISE_WORDS = [
  '哈哈', '嘿嘿', '嗯嗯', '666', '草', '顶', '沙发', '前排', '打卡',
  '收到', '路过', '围观', '233', 'awsl', '2333', '好耶', '牛',
];

/** 提到本鲸（虽然没 @，但明显在跟它说话） */
const SELF_NAMES = ['肥鱼', '鲸鱼', '大肥鱼', '小鲸鲸', '蓝鲸'];

/** 基础分：没有明显特征时保持在中位，交给门槛决定去留 */
const BASE_SCORE = 0.5;

/** 特征权重（加减分） */
const W = {
  question: 0.18,
  help: 0.14,
  opening: 0.1,
  selfName: 0.12,
  noise: -0.22,
  mentionOthers: -0.15,
  longText: -0.05,
} as const;

/** 超过此长度视为长文本（多半不是闲聊） */
const LONG_TEXT = 80;

/**
 * 剥掉 mention 标记，得到"只看正文"的文本。
 *
 * 为什么要剥：样例/特征都基于正文语义，<@xxx> 之类的标记会淹没语义
 * （参考实现踩过同样的坑：不剥时"这条 @ 了她"成了最大共同特征）。
 */
export function stripMentions(text: string): string {
  return String(text ?? '')
    .replace(/<@[!&]?\d+>/g, ' ')
    .replace(/<@[0-9A-Za-z_-]{6,}>/g, ' ')
    .replace(/@[^\s，。！？、]{1,20}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 是否只由表情/符号组成（没有可读语义） */
function isOnlySymbols(text: string): boolean {
  return !/[一-龥a-zA-Z0-9]/.test(text);
}

/** 词法门控参数 */
export interface LexicalGateOptions {
  /** 参与判定的最短文本长度 */
  minLength: number;
  /** 放行门槛（0~1） */
  minScore: number;
}

/**
 * 词法判定：纯函数、确定性，便于单测。
 *
 * 返回 undefined 的情况本实现不会出现（没有不可用的外部依赖），
 * 但调用方仍按"未知 → 不拦截"处理，为将来换实现留余地。
 */
export function evaluateLexical(
  candidate: ProactiveCandidate,
  options: LexicalGateOptions,
): ValueVerdict | undefined {
  const text = candidate.text.trim();

  if (!text) return { score: 0, worth: false, reason: 'empty' };
  if (text.length < options.minLength) {
    return { score: 0, worth: false, reason: `too-short(${text.length})` };
  }
  if (isOnlySymbols(text)) return { score: 0, worth: false, reason: 'symbols-only' };

  let score = BASE_SCORE;
  const reasons: string[] = [];

  if (QUESTION_WORDS.some((w) => text.includes(w))) {
    score += W.question;
    reasons.push('question');
  }
  if (HELP_WORDS.some((w) => text.includes(w))) {
    score += W.help;
    reasons.push('help');
  }
  if (OPENING_WORDS.some((w) => text.includes(w))) {
    score += W.opening;
    reasons.push('opening');
  }
  if (SELF_NAMES.some((w) => text.includes(w))) {
    score += W.selfName;
    reasons.push('self-name');
  }
  if (NOISE_WORDS.some((w) => text.includes(w))) {
    score += W.noise;
    reasons.push('noise');
  }
  // ⚠️ 只有"@了别人"才扣分；"没被 @"不扣分（那正是她该主动接话的常态）
  if (candidate.mentionedOthers) {
    score += W.mentionOthers;
    reasons.push('mention-others');
  }
  if (text.length > LONG_TEXT) {
    score += W.longText;
    reasons.push('long-text');
  }

  score = Math.max(0, Math.min(1, score));
  const worth = score >= options.minScore;
  return { score, worth, reason: reasons.length > 0 ? reasons.join('+') : 'plain' };
}

/** 词法门控实现（ValueGate 接口） */
export function createLexicalGate(options: LexicalGateOptions): ValueGate {
  return {
    id: 'lexical',
    evaluate: (candidate) => evaluateLexical(candidate, options),
  };
}
