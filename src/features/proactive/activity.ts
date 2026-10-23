/**
 * 群活跃度追踪（M1 时机特征的数据源）
 *
 * 静态词法只能回答「这条内容值不值得接」，回答不了「**此刻**适不适合开口」。
 * 同样一句「这个怎么弄」：
 *   - 在她刚说完话时插嘴 → 很吵
 *   - 在冷场三分钟后接话 → 很自然
 *   - 同一个人连发三条没人接 → 他在等回应，该接
 *
 * 全部零成本：只记时间戳与发送者，不调模型。
 */

/** 判定「热闹」的观察窗口（ms） */
const ACTIVITY_WINDOW_MS = 3 * 60 * 1000;

/** 每群最多保留多少条消息时间戳（3 分钟窗口内够用了） */
const MAX_ENTRIES_PER_GROUP = 60;

/** 一条消息的轻量记录 */
interface Entry {
  senderId: string;
  at: number;
}

export class GroupActivity {
  private readonly byGroup = new Map<string, Entry[]>();
  /** 机器人在各群最后一次发言的时刻 */
  private readonly botSpokeAt = new Map<string, number>();

  /** 记一条群消息（在门控之前调用，未点名她的消息也要进） */
  record(groupId: string, senderId: string, at: number = Date.now()): void {
    if (!groupId) return;
    const list = this.byGroup.get(groupId) ?? [];
    list.push({ senderId, at });
    if (list.length > MAX_ENTRIES_PER_GROUP) {
      list.splice(0, list.length - MAX_ENTRIES_PER_GROUP);
    }
    this.byGroup.set(groupId, list);
  }

  /**
   * 算当前时机特征。
   *
   * @param groupId 群 openid
   * @param now 当前时间（注入便于测试）
   */
  signals(
    groupId: string,
    now: number = Date.now(),
  ): { recentMessages: number; consecutiveSameSender: number; sinceBotSpokeMs?: number } {
    const list = this.byGroup.get(groupId) ?? [];
    // 只数窗口内的（顺手丢弃过期项，避免无限增长）
    const cutoff = now - ACTIVITY_WINDOW_MS;
    const recent = list.filter((entry) => entry.at >= cutoff);

    // 连续同一人：从最新一条往前数，遇到别人就停
    let consecutive = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const current = recent[i];
      if (current === undefined) break;
      if (i === recent.length - 1) {
        consecutive = 1;
        continue;
      }
      if (current.senderId === recent[i + 1]?.senderId) consecutive += 1;
      else break;
    }

    return {
      recentMessages: recent.length,
      consecutiveSameSender: consecutive,
      sinceBotSpokeMs: this.sinceBotSpoke(groupId, now),
    };
  }

  /**
   * 记录机器人自己在群里发了言。
   *
   * 单独存而不是混进消息流：判「她刚说过话」要的是她自己的时间戳，
   * 混进去会把别人的消息也算成她说过。
   */
  recordBotSpoke(groupId: string, at: number = Date.now()): void {
    if (!groupId) return;
    this.botSpokeAt.set(groupId, at);
  }

  /** 距机器人上次在群里发言多久（ms）；从未发言返回 undefined */
  sinceBotSpoke(groupId: string, now: number = Date.now()): number | undefined {
    const at = this.botSpokeAt.get(groupId);
    if (at === undefined) return undefined;
    return Math.max(0, now - at);
  }

  /** 清空某群（/new 或群被移除时） */
  clear(groupId: string): void {
    this.byGroup.delete(groupId);
    this.botSpokeAt.delete(groupId);
  }

  /** 清空全部 */
  clearAll(): void {
    this.byGroup.clear();
    this.botSpokeAt.clear();
  }
}
