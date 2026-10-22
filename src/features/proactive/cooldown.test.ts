import { describe, expect, it } from 'vitest';
import { ProactiveCooldown } from './cooldown.ts';

const NOW = 1_700_000_000_000;

describe('ProactiveCooldown', () => {
  it('从未接话过时没有冷却', () => {
    const c = new ProactiveCooldown({ cooldownMs: 1000, maxPerHour: 3 });
    expect(c.remaining('g1', NOW)).toBe(0);
    expect(c.hourlyExhausted('g1', NOW)).toBe(false);
  });

  it('接话后进入冷却', () => {
    const c = new ProactiveCooldown({ cooldownMs: 1000, maxPerHour: 3 });
    c.record('g1', NOW);
    expect(c.remaining('g1', NOW)).toBe(1000);
    expect(c.remaining('g1', NOW + 600)).toBe(400);
  });

  it('冷却结束后归零', () => {
    const c = new ProactiveCooldown({ cooldownMs: 1000, maxPerHour: 3 });
    c.record('g1', NOW);
    expect(c.remaining('g1', NOW + 1000)).toBe(0);
  });

  it('冷却按群独立', () => {
    const c = new ProactiveCooldown({ cooldownMs: 1000, maxPerHour: 3 });
    c.record('g1', NOW);
    expect(c.remaining('g2', NOW)).toBe(0);
  });

  it('每小时上限用尽后拒绝', () => {
    const c = new ProactiveCooldown({ cooldownMs: 0, maxPerHour: 2 });
    c.record('g1', NOW);
    expect(c.hourlyExhausted('g1', NOW)).toBe(false);
    c.record('g1', NOW + 1);
    expect(c.usedThisHour('g1', NOW + 1)).toBe(2);
    expect(c.hourlyExhausted('g1', NOW + 1)).toBe(true);
  });

  it('跨小时后上限重置', () => {
    const c = new ProactiveCooldown({ cooldownMs: 0, maxPerHour: 1 });
    c.record('g1', NOW);
    expect(c.hourlyExhausted('g1', NOW)).toBe(true);
    const nextHour = NOW + 3_600_000;
    expect(c.hourlyExhausted('g1', nextHour)).toBe(false);
    expect(c.usedThisHour('g1', nextHour)).toBe(0);
  });

  it('上限为 0 时不限制', () => {
    const c = new ProactiveCooldown({ cooldownMs: 0, maxPerHour: 0 });
    for (let i = 0; i < 20; i++) c.record('g1', NOW);
    expect(c.hourlyExhausted('g1', NOW)).toBe(false);
  });
});
