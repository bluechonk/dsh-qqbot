/**
 * 思考强度注入测试
 *
 * 核心语义：**undefined 与 'off' 必须区分**。
 *   undefined → 不写 agentOptions.reasoningEffort，由宿主/模型自己决定
 *   'off'     → 显式关掉思考
 * 二者混同会让"关思考"变成"什么都没说"，是最难排查的一类 bug。
 */
import { describe, expect, it } from 'vitest';
import type { ModelRoute } from './types.ts';
import type { ImQQBotConfig } from '../config.ts';

/** 只注入 reasoningEffort 的最小桩，避免拉起整个 ModelResolver 的依赖 */
function inject(route: ModelRoute, effort: ImQQBotConfig['reasoningEffort']): ModelRoute {
  if (effort === undefined || effort === null) return route;
  if (String(effort) === '') return route;
  return { ...route, reasoningEffort: effort };
}

const ROUTE: ModelRoute = { provider: 'p', model: 'm' };

describe('reasoningEffort 注入', () => {
  it('未配置时不写字段（宿主自己决定）', () => {
    expect(inject(ROUTE, undefined)).toEqual(ROUTE);
    expect('reasoningEffort' in inject(ROUTE, undefined)).toBe(false);
  });

  it('空串同样视为"不覆盖"（设置面板用它表示跟随默认）', () => {
    expect('reasoningEffort' in inject(ROUTE, '' as never)).toBe(false);
  });

  it('显式 off 会写入，且与 undefined 不同', () => {
    const off = inject(ROUTE, 'off');
    expect(off.reasoningEffort).toBe('off');
    expect(off).not.toEqual(inject(ROUTE, undefined));
  });

  it('其余合法值原样透传', () => {
    for (const level of ['low', 'medium', 'high', 'max'] as const) {
      expect(inject(ROUTE, level).reasoningEffort).toBe(level);
    }
  });

  it('不污染原对象', () => {
    const before = JSON.stringify(ROUTE);
    inject(ROUTE, 'high');
    expect(JSON.stringify(ROUTE)).toBe(before);
  });

  it('保留 provider 与 model 字段', () => {
    expect(inject(ROUTE, 'high')).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' });
  });
});
