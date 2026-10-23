/**
 * 冷场探测 — 纯逻辑测试
 *
 * 这套判定的核心是「宁可不开口」：任何一个否决条件成立就直接返回。
 * 冷场起话题是**打扰性**行为，误判的代价远高于漏判。
 */
import { describe, expect, it } from 'vitest';
import {
  buildIdlePrompt,
  DEFAULT_IDLE_POLICY,
  evaluateIdle,
  type GroupIdleState,
} from './policy.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** 已冷场 1 小时、之前说过话的典型状态 */
function idleState(overrides: Partial<GroupIdleState> = {}): GroupIdleState {
  return {
    lastMessageAt: NOW - 60 * MIN,
    lastBotSpokeAt: NOW - 3 * HOUR,
    lastTopicAt: undefined,
    topicsToday: 0,
    hasSpokenBefore: true,
    ...overrides,
  };
}

describe('evaluateIdle', () => {
  it('冷场够久且各项允许 → 该起话题', () => {
    const v = evaluateIdle(idleState(), DEFAULT_IDLE_POLICY, NOW);
    expect(v.should).toBe(true);
    expect(v.reason).toBe('idle-and-allowed');
  });

  it('没在这个群说过话 → 不开口（那叫刷屏）', () => {
    const v = evaluateIdle(idleState({ hasSpokenBefore: false }), DEFAULT_IDLE_POLICY, NOW);
    expect(v.should).toBe(false);
    expect(v.reason).toBe('never-spoke-here');
  });

  it('没有消息历史 → 不开口（无从判断冷场）', () => {
    const v = evaluateIdle(idleState({ lastMessageAt: undefined }), DEFAULT_IDLE_POLICY, NOW);
    expect(v.should).toBe(false);
    expect(v.reason).toBe('no-message-history');
  });

  it('冷场不够久 → 不开口', () => {
    const v = evaluateIdle(
      idleState({ lastMessageAt: NOW - 10 * MIN }),
      DEFAULT_IDLE_POLICY,
      NOW,
    );
    expect(v.should).toBe(false);
    expect(v.reason).toContain('not-idle-yet');
    expect(v.idleForMs).toBe(10 * MIN);
  });

  it('她刚在群里说过话 → 不开口（场子还没散）', () => {
    const v = evaluateIdle(
      idleState({ lastBotSpokeAt: NOW - 10 * MIN }),
      DEFAULT_IDLE_POLICY,
      NOW,
    );
    expect(v.should).toBe(false);
    expect(v.reason).toContain('bot-spoke-recently');
  });

  it('距上次主动起话题不够久 → 不开口（比每日上限更重要）', () => {
    const v = evaluateIdle(
      idleState({ lastTopicAt: NOW - 2 * HOUR }),
      DEFAULT_IDLE_POLICY,
      NOW,
    );
    expect(v.should).toBe(false);
    expect(v.reason).toContain('topic-cooldown');
  });

  it('当天已起过话题 → 不开口', () => {
    const v = evaluateIdle(idleState({ topicsToday: 1 }), DEFAULT_IDLE_POLICY, NOW);
    expect(v.should).toBe(false);
    expect(v.reason).toContain('daily-cap');
  });

  it('冷却过了、计数允许 → 又能起话题', () => {
    const v = evaluateIdle(
      idleState({ lastTopicAt: NOW - 7 * HOUR, topicsToday: 0 }),
      DEFAULT_IDLE_POLICY,
      NOW,
    );
    expect(v.should).toBe(true);
  });

  it('阈值可调（更短的冷场判定）', () => {
    const policy = { ...DEFAULT_IDLE_POLICY, idleMs: 5 * MIN };
    const v = evaluateIdle(
      idleState({ lastMessageAt: NOW - 10 * MIN }),
      policy,
      NOW,
    );
    expect(v.should).toBe(true);
  });

  it('否决条件优先于得分条件（不会勉强开口）', () => {
    // 冷场极久，但从没说过话 → 仍然不开口
    const v = evaluateIdle(
      idleState({ lastMessageAt: NOW - 10 * HOUR, hasSpokenBefore: false }),
      DEFAULT_IDLE_POLICY,
      NOW,
    );
    expect(v.should).toBe(false);
  });
});

describe('buildIdlePrompt', () => {
  it('带出冷场分钟数', () => {
    expect(buildIdlePrompt(45 * MIN)).toContain('45 分钟');
  });

  it('明确「不是在回应谁」，防止答非所问', () => {
    const prompt = buildIdlePrompt(30 * MIN);
    expect(prompt).toContain('不是在回应谁');
    expect(prompt).toContain('别复述');
  });

  it('允许沉默（不想说就 [skip]）', () => {
    expect(buildIdlePrompt(30 * MIN)).toContain('[skip]');
  });

  it('不足 1 分钟也不会显示 0 分钟', () => {
    expect(buildIdlePrompt(10_000)).toContain('1 分钟');
  });
});
