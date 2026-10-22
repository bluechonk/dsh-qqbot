/**
 * 沉默标记 — AI 表示「这一条我不回」
 *
 * 真人不会每条消息都有回应。若 AI 判断此刻插话不自然，
 * 让它把回复写成约定标记，出站层识别后**不发送**（也不计入回复统计）。
 */

/** 沉默标记文本 */
export const SKIP_MARKER = '[skip]';

/**
 * 判断一段回复是否为沉默标记。
 *
 * 只认**整段正文恰好等于标记**的情况（允许首尾空白），
 * 避免正文里偶然出现该字样被误判。
 */
export function isSkipReply(text: string): boolean {
  return String(text ?? '').trim() === SKIP_MARKER;
}
