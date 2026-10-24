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

/**
 * 时机特征（M1）
 *
 * 静态词法只能回答「这条内容值不值得接」，回答不了「**此刻**适不适合开口」。
 * 同样一句「这个怎么弄」，在她刚说完话时插嘴很吵，在冷场三分钟后接话就很自然。
 *
 * 这些信号全部零成本（本地计数），不调模型。
 */
export interface ProactiveSignals {
  /** 近 3 分钟群内消息数（判断群是热闹还是冷清） */
  recentMessages: number;
  /** 同一发送者连续发了几条（>=2 说明他在等人接） */
  consecutiveSameSender: number;
  /** 距机器人上次在群里发言多久（ms）；从未发言为 undefined */
  sinceBotSpokeMs?: number;
}

/** 参与判定的候选消息 */
export interface ProactiveCandidate {
  /** 正文（已剥 mention 标记） */
  text: string;
  /** 是否 @ 了机器人 */
  mentioned: boolean;
  /** 是否 @ 了别人（这轮对话的方向是别人，插嘴不自然） */
  mentionedOthers: boolean;
  /** 时机特征（缺省表示不参与打分，保持纯词法行为） */
  signals?: ProactiveSignals;
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
  blocked?: 'not-worth' | 'cooldown' | 'hourly-cap' | 'quiet-hours';
}
