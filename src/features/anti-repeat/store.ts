/**
 * 防复读 — 自己的发言流水
 *
 * 每个会话维护一个环形缓冲，只记**机器人自己**最近说过的话。
 * 纯内存：重启归零没关系，复读判定本来就只关心「刚才说过什么」，
 * 隔了一次重启的重复反而更像人（人会忘记自己说过）。
 */

/** 默认保留几条 */
const DEFAULT_SIZE = 5;

export class ReplyHistory {
  private readonly limit: number;
  private readonly bySession = new Map<string, string[]>();

  constructor(limit = DEFAULT_SIZE) {
    this.limit = Math.max(1, limit);
  }

  /** 记一条自己的发言 */
  record(sessionKey: string, reply: string): void {
    const text = String(reply ?? '').trim();
    if (!text) return;

    const list = this.bySession.get(sessionKey) ?? [];
    list.push(text);
    if (list.length > this.limit) list.splice(0, list.length - this.limit);
    this.bySession.set(sessionKey, list);
  }

  /** 取该会话最近的发言（旧→新） */
  list(sessionKey: string): readonly string[] {
    return this.bySession.get(sessionKey) ?? [];
  }

  /** 清空某会话（/new、切模型重建时调用，避免拿着旧人设说话） */
  clear(sessionKey: string): void {
    this.bySession.delete(sessionKey);
  }

  /** 清空全部 */
  clearAll(): void {
    this.bySession.clear();
  }
}
