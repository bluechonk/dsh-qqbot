/**
 * 群活跃度追踪测试（M1 时机特征的数据源）
 *
 * 这些信号零成本但极易算错，尤其是「连续同一人」——
 * 差一步就会把「别人插了一句话之后又轮到他」误判成连发。
 */
import { describe, expect, it } from 'vitest';
import { GroupActivity } from './activity.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe('GroupActivity', () => {
  it('只统计 3 分钟窗口内的消息', () => {
    const a = new GroupActivity();
    a.record('g1', 'u1', NOW - 10 * MIN); // 窗口外
    a.record('g1', 'u1', NOW - 1 * MIN);  // 窗口内
    a.record('g1', 'u2', NOW - 5000);     // 窗口内
    expect(a.signals('g1', NOW).recentMessages).toBe(2);
  });

  it('连续同一人从最新一条往前数', () => {
    const a = new GroupActivity();
    a.record('g1', 'u1', NOW - 3000);
    a.record('g1', 'u2', NOW - 2000);
    a.record('g1', 'u2', NOW - 1000);
    expect(a.signals('g1', NOW).consecutiveSameSender).toBe(2);
  });

  it('别人插话后连续计数归 1（不算连发）', () => {
    const a = new GroupActivity();
    a.record('g1', 'u1', NOW - 3000);
    a.record('g1', 'u1', NOW - 2000);
    a.record('g1', 'u2', NOW - 1000);
    expect(a.signals('g1', NOW).consecutiveSameSender).toBe(1);
  });

  it('没发过言的群返回零值而不是抛错', () => {
    const a = new GroupActivity();
    expect(a.signals('nope', NOW)).toEqual({
      recentMessages: 0,
      consecutiveSameSender: 0,
      sinceBotSpokeMs: undefined,
    });
  });

  it('机器人发言时间独立记录（不与群消息混算）', () => {
    const a = new GroupActivity();
    a.record('g1', 'u1', NOW - 5000);
    a.recordBotSpoke('g1', NOW - 2000);
    const signals = a.signals('g1', NOW);
    expect(signals.sinceBotSpokeMs).toBe(2000);
    // 群消息数只数别人的，不含她自己那条
    expect(signals.recentMessages).toBe(1);
  });

  it('从未发言时 sinceBotSpokeMs 为 undefined（区别于 0）', () => {
    const a = new GroupActivity();
    a.record('g1', 'u1', NOW);
    expect(a.signals('g1', NOW).sinceBotSpokeMs).toBeUndefined();
  });

  it('按群隔离', () => {
    const a = new GroupActivity();
    a.record('g1', 'u1', NOW);
    a.record('g2', 'u1', NOW);
    a.record('g2', 'u1', NOW);
    expect(a.signals('g1', NOW).recentMessages).toBe(1);
    expect(a.signals('g2', NOW).consecutiveSameSender).toBe(2);
  });

  it('clear 清空该群的消息与发言时间', () => {
    const a = new GroupActivity();
    a.record('g1', 'u1', NOW);
    a.recordBotSpoke('g1', NOW);
    a.clear('g1');
    expect(a.signals('g1', NOW)).toEqual({
      recentMessages: 0,
      consecutiveSameSender: 0,
      sinceBotSpokeMs: undefined,
    });
  });

  it('空 groupId 不记录（防御脏数据）', () => {
    const a = new GroupActivity();
    a.record('', 'u1', NOW);
    a.recordBotSpoke('', NOW);
    expect(a.signals('', NOW).recentMessages).toBe(0);
  });
});
