/**
 * 回复延迟 — 拟人节奏
 *
 * 真人在群里打字要时间，**秒回是最明显的机器人特征**。
 * 这里按「基础延迟 + 每字延迟 + 随机抖动」算出一个发送前的等待时间：
 *   - 基础延迟：让回应不像「立刻吐字」
 *   - 每字延迟：字越多打字越久（也顺带抑制长回复）
 *   - 随机抖动：避免每次都等同样久（机械的固定延迟反而像机器人）
 *
 * 独立文件便于单测。
 */

/** 回复延迟参数 */
export interface ReplyDelayConfig {
  /** 基础延迟(ms)，0 表示关闭延迟 */
  baseMs: number;
  /** 每字额外延迟(ms) */
  perCharMs: number;
  /** 随机抖动上限(ms) */
  jitterMs: number;
  /** 单次延迟上限(ms)，0 表示不封顶 */
  maxMs: number;
}

/** 参与字数计算的最大字符数（超长文本不无限叠加延迟） */
const MAX_COUNTED_CHARS = 200;

/**
 * 计算回复前的等待时间(ms)。
 *
 * @param text 回复正文（按字数算延迟）
 * @param config 延迟参数
 * @param random 随机源（注入便于测试）
 */
export function computeReplyDelay(
  text: string,
  config: ReplyDelayConfig,
  random: () => number = Math.random,
): number {
  if (config.baseMs <= 0 && config.perCharMs <= 0) return 0;
  const chars = Math.min(text.length, MAX_COUNTED_CHARS);
  const jitter = config.jitterMs > 0 ? random() * config.jitterMs : 0;
  let delay = config.baseMs + chars * config.perCharMs + jitter;
  if (config.maxMs > 0) delay = Math.min(delay, config.maxMs);
  return Math.max(0, Math.round(delay));
}

/** 等待指定毫秒 */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 目标延迟扣掉「回合已消耗时间」后，还需再等多久。
 *
 * 拟人延迟模拟的是打字时间，应当与模型思考**重叠**，而不是想完再额外等。
 * 模型已经跑了几十秒时，剩余为 0 —— 直接发，不给体验添堵；
 * 模型秒回时剩余接近目标值 —— 补上拟人节奏。
 *
 * @param targetMs 目标延迟（computeReplyDelay 的结果）
 * @param elapsedMs 从回合起点到现在已经过去的时间
 */
export function computeRemainingDelay(targetMs: number, elapsedMs: number): number {
  if (targetMs <= 0) return 0;
  const remaining = targetMs - Math.max(0, elapsedMs);
  return remaining > 0 ? Math.round(remaining) : 0;
}
