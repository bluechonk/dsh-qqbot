/**
 * 作息（quiet hours）—— 深夜装睡
 *
 * 路线图 #5：22:00 后回复变慢变短，甚至不回。
 * 这里只做两件纯逻辑的事：
 *   - **判定**现在是否处于安静时段（支持跨天区间）
 *   - **深夜提示行**：注入旁白区，让回复自然「轻声简短」（「变慢」走现有延迟配置）
 *
 * 压制规则（在 proactiveGate 里）：
 *   安静时段内**未点名**的群消息一律不接话（`ctx.stop` 留痕），
 *   被 @ 的照常回，主人的命令不受影响，私聊不受影响。
 */
/** 深夜提示行：注入旁白区（persona 会读到，自然收敛语气与篇幅） */
export const QUIET_HINT_LINE = '【深夜模式】夜深了，轻声一点，简短些，别起哄。\n';

/** 解析 HH:mm；非法返回 undefined */
function parseClock(value: string): { hour: number; minute: number } | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

/**
 * 现在是否处于安静时段。
 *
 * 支持跨天区间（start=22:00 / end=07:00 → 22:00–次日 07:00）。
 * start === end 视为「全天安静」——起止填成一样通常意味着「夜里一直静」，
 * 而不是「这个区间长度为零」。
 */
export function isQuietHours(now: Date, start: string, end: string): boolean {
  const s = parseClock(start);
  const e = parseClock(end);
  if (!s || !e) return false;

  const t = now.getHours() * 60 + now.getMinutes();
  const a = s.hour * 60 + s.minute;
  const b = e.hour * 60 + e.minute;
  if (a === b) return true;
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/** 便捷入口：配置未启用时恒为 false */
export function isQuietNow(enabled: boolean, start: string, end: string, now = new Date()): boolean {
  return enabled && isQuietHours(now, start, end);
}
