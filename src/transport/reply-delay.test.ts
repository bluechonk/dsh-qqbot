import { describe, expect, it } from 'vitest';
import { computeReplyDelay } from './reply-delay.ts';

describe('computeReplyDelay', () => {
  it('基础与每字延迟都为 0 时不延迟', () => {
    expect(computeReplyDelay('你好', { baseMs: 0, perCharMs: 0, jitterMs: 0, maxMs: 0 })).toBe(0);
  });

  it('基础延迟 + 每字延迟按字数累加', () => {
    const ms = computeReplyDelay('abcd', { baseMs: 1000, perCharMs: 100, jitterMs: 0, maxMs: 0 }, () => 0);
    expect(ms).toBe(1400);
  });

  it('随机抖动落在 [0, jitterMs] 区间内', () => {
    const cfg = { baseMs: 1000, perCharMs: 0, jitterMs: 500, maxMs: 0 };
    expect(computeReplyDelay('x', cfg, () => 0)).toBe(1000);
    const high = computeReplyDelay('x', cfg, () => 0.999);
    expect(high).toBeGreaterThan(1000);
    expect(high).toBeLessThanOrEqual(1500);
  });

  it('单次上限封顶', () => {
    const ms = computeReplyDelay('很长很长很长很长', { baseMs: 1000, perCharMs: 500, jitterMs: 0, maxMs: 3000 }, () => 0);
    expect(ms).toBe(3000);
  });

  it('超长文本不无限叠加字数延迟', () => {
    const short = computeReplyDelay('a'.repeat(10), { baseMs: 0, perCharMs: 100, jitterMs: 0, maxMs: 0 }, () => 0);
    const long = computeReplyDelay('a'.repeat(5000), { baseMs: 0, perCharMs: 100, jitterMs: 0, maxMs: 0 }, () => 0);
    expect(short).toBe(1000);
    expect(long).toBe(20000); // 上限 200 字
    expect(long).toBeLessThan(5000 * 100);
  });

  it('不会返回负数', () => {
    expect(computeReplyDelay('', { baseMs: 0, perCharMs: 0, jitterMs: 0, maxMs: 0 })).toBe(0);
  });
});
