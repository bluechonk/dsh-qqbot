/**
 * 主动接话频率控制 — 同群冷却 + 每小时上限
 *
 * 真人不会在群里连着插话。这里做两层约束：
 *   - 冷却：两次主动接话之间的最小间隔
 *   - 每小时上限：单群单小时的主动接话次数封顶
 *
 * 状态在内存（进程内）：重启后归零，符合"聊天气氛"的直觉。
 */

/** 频率控制参数 */
export interface CooldownOptions {
  /** 两次主动接话之间的最小间隔(ms)，0=不限制 */
  cooldownMs: number;
  /** 单群每小时主动接话上限，0=不限制 */
  maxPerHour: number;
}

/** 当前小时桶（按 epoch 小时数分桶，跨天自动切换） */
function hourBucket(now: number): number {
  return Math.floor(now / 3_600_000);
}

export class ProactiveCooldown {
  private readonly lastAt = new Map<string, number>();
  private readonly hourCount = new Map<string, { hour: number; count: number }>();
  private readonly options: CooldownOptions;

  constructor(options: CooldownOptions) {
    this.options = options;
  }

  /** 距上次接话还差多少毫秒（0=现在可以接话） */
  remaining(groupId: string, now: number = Date.now()): number {
    const last = this.lastAt.get(groupId);
    if (last === undefined) return 0;
    const left = this.options.cooldownMs - (now - last);
    return left > 0 ? left : 0;
  }

  /** 本小时的接话次数是否已用尽 */
  hourlyExhausted(groupId: string, now: number = Date.now()): boolean {
    if (this.options.maxPerHour <= 0) return false;
    const bucket = this.hourCount.get(groupId);
    if (bucket === undefined || bucket.hour !== hourBucket(now)) return false;
    return bucket.count >= this.options.maxPerHour;
  }

  /** 记账：本次主动接话已发生 */
  record(groupId: string, now: number = Date.now()): void {
    this.lastAt.set(groupId, now);
    const hour = hourBucket(now);
    const bucket = this.hourCount.get(groupId);
    if (bucket === undefined || bucket.hour !== hour) {
      this.hourCount.set(groupId, { hour, count: 1 });
    } else {
      bucket.count += 1;
    }
  }

  /** 本小时已接话次数（诊断用） */
  usedThisHour(groupId: string, now: number = Date.now()): number {
    const bucket = this.hourCount.get(groupId);
    if (bucket === undefined || bucket.hour !== hourBucket(now)) return 0;
    return bucket.count;
  }
}
