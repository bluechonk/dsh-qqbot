/**
 * 主动接话判定 — 类型定义
 *
 * 目标：让机器人在群里**不用被点名**也能有选择地接话。
 *
 * 判定分两层（详见 docs/proactive-group-chat.md）：
 *   L1 本地门控（零 token）：把明显不值得唤醒 AI 的消息挡在 AI 之外
 *   L2 AI 回合内自决：值得接的话里，AI 仍可选择沉默（回 [skip]）
 *
 * 本文件只放类型，判定实现在 lexical-gate.ts。
 */

/** 门控判定结果 */
export interface ValueVerdict {
  /** 0~1 评分（越大越值得接话） */
  score: number;
  /** 是否值得唤醒 AI */
  worth: boolean;
  /** 人话解释（进日志，便于事后调阈值） */
  reason: string;
}

/** 参与判定的候选消息 */
export interface ProactiveCandidate {
  /** 正文（已剥 mention 标记） */
  text: string;
  /** 是否 @ 了机器人 */
  mentioned: boolean;
  /** 是否 @ 了别人（这轮对话的方向是别人，插嘴不自然） */
  mentionedOthers: boolean;
}

/** 判定器接口（可替换：词法 → 本地嵌入 → LLM） */
export interface ValueGate {
  /** 实现标识（诊断用） */
  readonly id: string;
  /** 打分；实现不可用时返回 undefined（调用方按"未知"处理，不拦截） */
  evaluate(candidate: ProactiveCandidate): ValueVerdict | undefined;
}

/** 门控在单条消息上的最终判定（写入 ctx.state.proactive） */
export interface ProactiveDecision {
  /**
   * mentioned=被点名必回；chose=自主决定接话；observed=只记录不接话
   */
  mode: 'mentioned' | 'chose' | 'observed';
  /** 判定分（observed/chose 才有） */
  score?: number;
  /** 判定理由 */
  reason?: string;
  /** 拦截原因（mode=observed 且被拦时） */
  blocked?: 'not-worth' | 'cooldown' | 'hourly-cap';
}
