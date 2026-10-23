/**
 * agentBody 拼接测试
 *
 * 这是「中间件状态 → 模型实际看到什么」的契约。拼接顺序或分隔错了，
 * 模型会误读（比如把群友档案和防复读提示当成同一段），
 * 但**不会有任何报错**——属于必须靠断言守住的一类。
 *
 * 期望的拼接顺序（从前到后）：
 *   群友档案 → 防复读 → 自主接话背景 → 动态上下文 → 引用 → 用户消息
 */
import { describe, expect, it, vi } from 'vitest';
import { assembleAgentBody } from './inbound.ts';
import type { Logger } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** 最小可用的入站消息 */
function msg(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'group',
    senderId: 'u1',
    senderName: '老王',
    content: '这个报错怎么解决啊',
    messageId: 'm1',
    timestamp: '0',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    ...overrides,
  } as never;
}

function state(overrides: Record<string, unknown> = {}) {
  return { mention: { wasMentioned: true }, ...overrides } as never;
}

const LOG = createLogger();

describe('assembleAgentBody', () => {
  it('没有任何提示时，body 就是用户消息本身', () => {
    const body = assembleAgentBody(msg(), state(), 'group', LOG);
    expect(body).toContain('这个报错怎么解决啊');
    // 不应出现任何旁白标记
    expect(body).not.toContain('【群友档案】');
    expect(body).not.toContain('【你最近说过】');
    expect(body).not.toContain('【群聊背景】');
  });

  it('空消息且未点名 → 丢弃', () => {
    const body = assembleAgentBody(
      msg({ content: '' }),
      state({ mention: { wasMentioned: false } }),
      'group',
      LOG,
    );
    expect(body).toBeNull();
  });

  it('群聊被 @ 时，即使内容为空也保留（@ 本身是有效触发信号）', () => {
    const body = assembleAgentBody(
      msg({ content: '' }),
      state({ mention: { wasMentioned: true } }),
      'group',
      LOG,
    );
    expect(body).not.toBeNull();
  });

  it('私聊内容为空则丢弃（私聊没有 @ 这一说）', () => {
    const body = assembleAgentBody(
      msg({ content: '', kind: 'c2c' }),
      state({ mention: { wasMentioned: false } }),
      'c2c',
      LOG,
    );
    expect(body).toBeNull();
  });

  it('前置旁白按「档案 → 防复读 → 接话背景」顺序排列', () => {
    const prefix = '【群友档案】他叫老王。\n【你最近说过】「哼」——换个说法。\n';
    const body = assembleAgentBody(
      msg(),
      state({ proactive: { mode: 'chose' } }),
      'group',
      LOG,
      prefix,
    )!;

    const iProfile = body.indexOf('【群友档案】');
    const iRecent = body.indexOf('【你最近说过】');
    const iProactive = body.indexOf('【群聊背景】');
    const iContent = body.indexOf('这个报错怎么解决啊');

    expect(iProfile).toBeGreaterThanOrEqual(0);
    expect(iRecent).toBeGreaterThan(iProfile);
    expect(iProactive).toBeGreaterThan(iRecent);
    // 旁白必须在用户消息之前
    expect(iContent).toBeGreaterThan(iProactive);
  });

  it('只有被点名时给自主接话背景；observed 模式不给', () => {
    const chose = assembleAgentBody(
      msg(), state({ proactive: { mode: 'chose' } }), 'group', LOG,
    )!;
    expect(chose).toContain('【群聊背景】');

    const observed = assembleAgentBody(
      msg(), state({ proactive: { mode: 'observed' } }), 'group', LOG,
    )!;
    expect(observed).not.toContain('【群聊背景】');
  });

  it('旁白与用户消息之间不粘连（换行分隔）', () => {
    const prefix = '【群友档案】他叫老王。\n';
    const body = assembleAgentBody(msg(), state(), 'group', LOG, prefix)!;
    // 「。\n」之后应该直接是下一条内容，不能出现「。这个报错」
    expect(body).not.toMatch(/。\s*这个报错/);
  });

  it('引用消息插在用户消息之前', () => {
    const body = assembleAgentBody(
      msg(),
      state({ quote: { text: '被引用的原话' } }),
      'group',
      LOG,
    )!;
    expect(body.indexOf('被引用的原话')).toBeLessThan(body.indexOf('这个报错怎么解决啊'));
  });

  it('群聊被 @ 时带上历史；私聊不带', () => {
    const history = [
      { senderName: '小张', content: '前面那句', timestamp: '0' },
    ];
    const group = assembleAgentBody(
      msg(), state({ history }), 'group', LOG,
    )!;
    expect(group).toContain('前面那句');

    const c2c = assembleAgentBody(
      msg({ kind: 'c2c' }), state({ history }), 'c2c', LOG,
    )!;
    expect(c2c).not.toContain('前面那句');
  });

  it('未点名时群聊历史不注入（她没被叫，不该看到整段群聊）', () => {
    const history = [{ senderName: '小张', content: '前面那句', timestamp: '0' }];
    const body = assembleAgentBody(
      msg(),
      state({ mention: { wasMentioned: false }, history }),
      'group',
      LOG,
    )!;
    expect(body).not.toContain('前面那句');
  });
});
