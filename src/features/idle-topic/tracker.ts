/**
 * 冷场探测 — 状态追踪
 *
 * 只记每个群的三个时间戳与当天计数，纯内存。
 * 重启归零没关系：冷场判断只关心「刚才有没有人说话」，
 * 跨重启的冷场本来就是冷场。
 */
import type { GroupIdleState } from './policy.ts';

/** 一天的长度（用于每日计数归零） */
const DAY_MS = 24 * 60 * 60 * 1000;

interface GroupRecord {
  lastMessageAt?: number;
  lastBotSpokeAt?: number;
  lastTopicAt?: number;
  topicsToday: number;
  /** 计数的「哪一天」（按本地日期分桶） */
  dayBucket?: number;
  hasSpokenBefore: boolean;
}

/** 按本地日期分桶（跨天自动归零，比用固定 24h 窗口更符合直觉） */
function dayOf(now: number): number {
  const date = new Date(now);
  return Math.floor(
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / DAY_MS,
  );
}

export class IdleTracker {
  private readonly byGroup = new Map<string, GroupRecord>();

  /** 记一条群消息（冷场计时重置） */
  recordMessage(groupId: string, at: number = Date.now()): void {
    if (!groupId) return;
    const record = this.ensure(groupId);
    record.lastMessageAt = at;
  }

  /** 记机器人发了言（能发言 ⇒ 交流基础成立） */
  recordBotSpoke(groupId: string, at: number = Date.now()): void {
    if (!groupId) return;
    const record = this.ensure(groupId);
    record.lastBotSpokeAt = at;
    record.hasSpokenBefore = true;
  }

  /** 记机器人主动起了话题（用于冷却与每日上限） */
  recordTopic(groupId: string, at: number = Date.now()): void {
    if (!groupId) return;
    const record = this.ensure(groupId);
    record.lastTopicAt = at;
    record.hasSpokenBefore = true;
    this.resetDailyIfNeeded(record, at);
    record.topicsToday += 1;
  }

  /** 取该群的探测状态快照 */
  stateOf(groupId: string, now: number = Date.now()): GroupIdleState {
    const record = this.byGroup.get(groupId);
    if (record === undefined) {
      return { topicsToday: 0, hasSpokenBefore: false };
    }
    this.resetDailyIfNeeded(record, now);
    return {
      lastMessageAt: record.lastMessageAt,
      lastBotSpokeAt: record.lastBotSpokeAt,
      lastTopicAt: record.lastTopicAt,
      topicsToday: record.topicsToday,
      hasSpokenBefore: record.hasSpokenBefore,
    };
  }

  /** 已经追踪的群（定时探测只遍历这些） */
  groups(): string[] {
    return [...this.byGroup.keys()];
  }

  private ensure(groupId: string): GroupRecord {
    let record = this.byGroup.get(groupId);
    if (record === undefined) {
      record = { topicsToday: 0, hasSpokenBefore: false };
      this.byGroup.set(groupId, record);
    }
    return record;
  }

  /** 跨天把每日计数归零 */
  private resetDailyIfNeeded(record: GroupRecord, now: number): void {
    const today = dayOf(now);
    if (record.dayBucket === today) return;
    record.dayBucket = today;
    record.topicsToday = 0;
  }
}
