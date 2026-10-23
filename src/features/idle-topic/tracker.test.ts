/**
 * 冷场追踪测试
 *
 * 重点验证跨天归零与三个时间戳的独立性——
 * 「她刚说过话」和「她刚起过话题」是两件事，混用会让冷却失效。
 */
import { describe, expect, it } from 'vitest';
import { IdleTracker } from './tracker.ts';

const NOW = new Date(2026, 9, 23, 12, 0, 0).getTime(); // 本地 2026-10-23 12:00
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('IdleTracker', () => {
  it('未追踪的群返回保守状态（不开口）', () => {
    const t = new IdleTracker();
    expect(t.stateOf('g1', NOW)).toEqual({ topicsToday: 0, hasSpokenBefore: false });
  });

  it('记消息后能读到冷场起点', () => {
    const t = new IdleTracker();
    t.recordMessage('g1', NOW - 10 * MIN);
    expect(t.stateOf('g1', NOW).lastMessageAt).toBe(NOW - 10 * MIN);
  });

  it('机器人发言后标记 hasSpokenBefore', () => {
    const t = new IdleTracker();
    expect(t.stateOf('g1', NOW).hasSpokenBefore).toBe(false);
    t.recordBotSpoke('g1', NOW);
    expect(t.stateOf('g1', NOW).hasSpokenBefore).toBe(true);
  });

  it('「刚说过话」与「刚起过话题」是两个独立时间戳', () => {
    const t = new IdleTracker();
    t.recordBotSpoke('g1', NOW - 5 * MIN);
    t.recordTopic('g1', NOW - 2 * HOUR);
    const state = t.stateOf('g1', NOW);
    expect(state.lastBotSpokeAt).toBe(NOW - 5 * MIN);
    expect(state.lastTopicAt).toBe(NOW - 2 * HOUR);
  });

  it('同一天内多次起话题会累加计数', () => {
    const t = new IdleTracker();
    t.recordTopic('g1', NOW - 3 * HOUR);
    t.recordTopic('g1', NOW - 1 * HOUR);
    expect(t.stateOf('g1', NOW).topicsToday).toBe(2);
  });

  it('跨天后当日计数归零', () => {
    const t = new IdleTracker();
    t.recordTopic('g1', NOW - 3 * HOUR);
    expect(t.stateOf('g1', NOW).topicsToday).toBe(1);
    // 第二天同一时刻再看 → 归零
    expect(t.stateOf('g1', NOW + DAY).topicsToday).toBe(0);
  });

  it('跨天后再次起话题从 1 开始计数', () => {
    const t = new IdleTracker();
    t.recordTopic('g1', NOW - 3 * HOUR);
    t.recordTopic('g1', NOW + DAY);
    expect(t.stateOf('g1', NOW + DAY).topicsToday).toBe(1);
  });

  it('按群隔离', () => {
    const t = new IdleTracker();
    t.recordMessage('g1', NOW);
    t.recordBotSpoke('g2', NOW);
    expect(t.stateOf('g1', NOW).hasSpokenBefore).toBe(false);
    expect(t.stateOf('g2', NOW).lastMessageAt).toBeUndefined();
  });

  it('groups 只列出已追踪的群', () => {
    const t = new IdleTracker();
    t.recordMessage('g1', NOW);
    t.recordBotSpoke('g2', NOW);
    expect(t.groups().sort()).toEqual(['g1', 'g2']);
  });

  it('空 groupId 不记录', () => {
    const t = new IdleTracker();
    t.recordMessage('', NOW);
    expect(t.groups()).toEqual([]);
  });
});
