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
  '帮我', '帮帮我', '帮忙', '求助', '请教', '救命', '咋办', '怎么办',
  '求个', '求教', '拜托', '谁能帮', '谁知道', '有人知道',
];

/** 呼朋唤友（面向全群抛问题） */
const OPENING_WORDS = ['有没有人', '大家', '请问', '求问', '在吗', '有人在吗'];

/** 灌水噪声（接梗/水群，通常不值得唤醒 AI） */
const NOISE_WORDS = [
  '哈哈', '嘿嘿', '嗯嗯', '666', '草', '顶', '沙发', '前排', '打卡',
  '收到', '路过', '围观', '233', 'awsl', '2333', '好耶', '牛',
];

/**
 * 提到本鲸（虽然没 @，但明显在跟它说话）
 *
 * 喊名字是最强的"在叫她"信号，必须**先于长度检查**判定：
 * 「大肥鱼」「肥鱼」只有 2~3 个字，若先按 minLength 拦，喊她名字也听不见。
 */
const SELF_NAMES = ['肥鱼', '鲸鱼', '大肥鱼', '小鲸鲸', '蓝鲸'];

/** 基础分：没有明显特征时保持在中位，交给门槛决定去留 */
const BASE_SCORE = 0.5;

/** 特征权重（加减分） */
const W = {
  question: 0.18,
  help: 0.14,
  opening: 0.1,
  selfName: 0.3,
  noise: -0.22,
  mentionOthers: -0.15,
  longText: -0.05,
  // ── 时机特征（M1）：同样一句话，什么时候说决定了得不得体 ──
  consecutiveSender: 0.1,
  botJustSpoke: -0.15,
  busyGroup: -0.07,
} as const;

/** 超过此长度视为长文本（多半不是闲聊） */
const LONG_TEXT = 80;

/** 机器人「刚说过话」的判定窗口：这段时间内不再接话，免得连珠炮 */
const BOT_JUST_SPOKE_MS = 60_000;

/** 群「太热闹」的阈值：3 分钟内超过这么多条，就让别人聊，别抢话 */
const BUSY_GROUP_THRESHOLD = 20;

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

  // ⚠️ 喊名字必须优先于长度检查：「大肥鱼」只有 3 个字，
  // 先按 minLength 拦掉就变成"叫她她也不应"，这是最不能忍的失败模式。
  if (SELF_NAMES.some((w) => text.includes(w))) {
    const score = Math.min(1, BASE_SCORE + W.selfName);
    return { score, worth: score >= options.minScore, reason: 'self-name' };
  }

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

  // ── 时机特征（M1）──
  // 内容值不值得接，与「此刻适不适合开口」是两件事，这里补后者。
  const signals = candidate.signals;
  if (signals !== undefined) {
    // 同一个人连发多条还没人接 → 他在等回应
    if (signals.consecutiveSameSender >= 2) {
      score += W.consecutiveSender;
      reasons.push('consecutive-sender');
    }
    // 她刚说过话 → 别连珠炮（真实体感上这比内容判断更重要）
    if (signals.sinceBotSpokeMs !== undefined && signals.sinceBotSpokeMs < BOT_JUST_SPOKE_MS) {
      score += W.botJustSpoke;
      reasons.push('bot-just-spoke');
    }
    // 群里正热闹 → 让别人聊，别抢话
    if (signals.recentMessages >= BUSY_GROUP_THRESHOLD) {
      score += W.busyGroup;
      reasons.push('busy-group');
    }
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
