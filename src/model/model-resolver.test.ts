/**
 * 思考强度注入测试（测真实 ModelResolver，不用桩）
 *
 * 两组语义都要守住：
 *
 * 1. **undefined 与 'off' 必须区分**
 *    undefined → 不写 agentOptions.reasoningEffort，由宿主/模型自己决定
 *    'off'     → 显式关掉思考
 *    混同会让「关思考」变成「什么都没说」。
 *
 * 2. **只在模型确实支持时才注入**
 *    宿主对 reasoningEffort 是硬校验：模型没有 reasoning 能力时传任何值都抛
 *    UNSUPPORTED_REASONING_EFFORT，**整轮直接失败**。
 *    实测踩过：longcat/LongCat-2.5-Preview 不支持，而配置里是 off，
 *    用户只看到一句报错、机器人等于哑了。
 */
import { describe, expect, it, vi } from 'vitest';
import { ModelResolver } from './model-resolver.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** 假 llm 服务：resolveModelInfo 按传入的能力返回 */
function fakeLlm(info: unknown) {
  return {
    listProviders: () => ['p'],
    listModels: async () => [{ id: 'm' }],
    resolveModelInfo: async () => info,
  };
}

function makeResolver(opts: {
  effort?: ImQQBotConfig['reasoningEffort'];
  llm?: unknown;
}): ModelResolver {
  // config.provider/model 一旦给定，resolveDefault 就不会去读 settings.yaml / 磁盘
  const config = {
    provider: 'p',
    model: 'm',
    reasoningEffort: opts.effort,
    debug: false,
  } as unknown as ImQQBotConfig;
  const ctx = {
    get: (name: string) => (name === 'llm' ? opts.llm : undefined),
  } as unknown as Parameters<typeof ModelResolver.prototype.constructor>[0];
  return new ModelResolver(ctx, config, logger);
}

/** 只关心「有没有注入」时用它 */
async function routeOf(opts: { effort?: ImQQBotConfig['reasoningEffort']; llm?: unknown }) {
  return makeResolver(opts).getEffectiveRouteChecked('test:no-override');
}

describe('reasoningEffort 注入：基础语义', () => {
  it('未配置时不写字段（宿主自己决定）', async () => {
    const route = await routeOf({ effort: undefined, llm: fakeLlm({ reasoning: { efforts: [{ id: 'off' }] } }) });
    expect('reasoningEffort' in (route ?? {})).toBe(false);
  });

  it('空串同样视为「不覆盖」（设置面板用它表示跟随默认）', async () => {
    const route = await routeOf({ effort: '' as never, llm: fakeLlm({ reasoning: { efforts: [{ id: 'off' }] } }) });
    expect('reasoningEffort' in (route ?? {})).toBe(false);
  });

  it('模型支持该档位时写入，且与 undefined 不同', async () => {
    const llm = fakeLlm({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } });
    const off = await routeOf({ effort: 'off', llm });
    expect(off?.reasoningEffort).toBe('off');
    expect(off).not.toEqual(await routeOf({ effort: undefined, llm }));
  });

  it('各档位原样透传', async () => {
    for (const level of ['off', 'low', 'medium', 'high', 'max'] as const) {
      const route = await routeOf({
        effort: level,
        llm: fakeLlm({ reasoning: { efforts: [{ id: level }] } }),
      });
      expect(route?.reasoningEffort).toBe(level);
    }
  });
});

describe('reasoningEffort 注入：按模型能力把关', () => {
  it('模型**没有** reasoning 能力 → 不注入（否则整轮会失败）', async () => {
    // 这是 longcat/LongCat-2.5-Preview 的真实情况
    const route = await routeOf({ effort: 'off', llm: fakeLlm({}) });
    expect('reasoningEffort' in (route ?? {})).toBe(false);
  });

  it('模型有 reasoning 但不支持该档位 → 不注入', async () => {
    const route = await routeOf({
      effort: 'max',
      llm: fakeLlm({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
    });
    expect('reasoningEffort' in (route ?? {})).toBe(false);
  });

  it('能力查询失败 → 保守不注入，且不缓存（下次还会重试）', async () => {
    const llm = {
      listProviders: () => ['p'],
      listModels: async () => [],
      resolveModelInfo: async () => { throw new Error('boom'); },
    };
    const resolver = makeResolver({ effort: 'high', llm });
    const route = await resolver.getEffectiveRouteChecked('test:no-override');
    expect('reasoningEffort' in (route ?? {})).toBe(false);
    // 再查一次仍然会尝试（没有把「失败」缓存成「不支持」）
    const again = await resolver.getEffectiveRouteChecked('test:no-override');
    expect('reasoningEffort' in (again ?? {})).toBe(false);
  });

  it('宿主没有 resolveModelInfo（旧版）→ 保守不注入', async () => {
    const route = await routeOf({
      effort: 'high',
      llm: { listProviders: () => ['p'], listModels: async () => [] },
    });
    expect('reasoningEffort' in (route ?? {})).toBe(false);
  });

  it('llm 服务完全不可用 → 保守不注入', async () => {
    const route = await routeOf({ effort: 'high', llm: undefined });
    expect('reasoningEffort' in (route ?? {})).toBe(false);
  });

  it('支持时注入、不支持时不注入，用的是同一份能力缓存', async () => {
    const resolveModelInfo = vi.fn(async () => ({ reasoning: { efforts: [{ id: 'off' }] } }));
    const resolver = makeResolver({
      effort: 'off',
      llm: { listProviders: () => ['p'], listModels: async () => [], resolveModelInfo },
    });
    await resolver.getEffectiveRouteChecked('test:no-override');
    await resolver.getEffectiveRouteChecked('test:no-override');
    // 第二次应命中缓存，不再查宿主
    expect(resolveModelInfo).toHaveBeenCalledTimes(1);
  });
});
