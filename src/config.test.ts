/**
 * 配置默认值测试
 *
 * 锁住"开箱即用"的取向：像群友一样自己判断该不该接话（不要求 @），
 * 不流式、不展示工具结果。默认值是对外承诺的一部分，改动必须同步文档与测试。
 */
import { describe, expect, it } from 'vitest';
import { ConfigSchema, ProactiveSchema } from './config.ts';

describe('配置默认值', () => {
  const config = ConfigSchema({} as never) as unknown as Record<string, unknown>;

  it('群聊不要求 @（交给自主接话判定）', () => {
    expect(config.requireMention).toBe(false);
  });

  it('流式默认关闭', () => {
    expect(config.streaming).toBe(false);
  });

  it('工具调用结果默认不展示', () => {
    expect(config.showToolResults).toBe(false);
  });

  it('自主接话默认开启', () => {
    const proactive = config.proactive as { enabled?: boolean } | undefined;
    expect(proactive?.enabled).toBe(true);
  });

  it('自主接话其余参数走保守默认（不至于刷屏）', () => {
    expect(ProactiveSchema({} as never)).toMatchObject({
      enabled: true,
      cooldownMs: 120000,
      maxPerHour: 6,
      observer: true,
    });
  });

  it('回复延迟默认开启（拟人节奏）', () => {
    expect(config.replyDelayMs).toBeGreaterThan(0);
  });
});
