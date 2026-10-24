/**
 * 上下文快照测试 —— 「上下文的上下文」的形态契约
 */
import { describe, expect, it } from 'vitest';
import { createContextMessage } from './context-snapshot.ts';

describe('createContextMessage', () => {
  it('空分节返回 undefined（没有上下文时不发空块）', () => {
    expect(createContextMessage([])).toBeUndefined();
  });

  it('来源标识为插件快照（kind=plugin + form=snapshot）', () => {
    const msg = createContextMessage([{ name: 'qqbot.profile', text: '【群友档案】他叫老王。\n' }]);
    expect(msg).toBeDefined();
    const source = (msg as { source: Record<string, unknown> }).source;
    expect(source.kind).toBe('plugin');
    expect(source.plugin).toBe('dsh-im-qqbot');
    expect(source.form).toBe('snapshot');
  });

  it('sections 与正文一致（正文给人看，sections 给结构化渲染）', () => {
    const sections = [
      { name: 'qqbot.quiet-hours', text: '【深夜模式】夜深了。\n' },
      { name: 'qqbot.profile', text: '【群友档案】他叫老王。\n' },
    ];
    const msg = createContextMessage(sections) as {
      source: { sections: readonly { name: string; text: string }[] };
      content: { type: string; text: string }[];
    };
    expect(msg.source.sections).toEqual(sections);
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]!.type).toBe('text');
    expect(msg.content[0]!.text).toBe('【深夜模式】夜深了。\n【群友档案】他叫老王。\n');
  });

  it('单个分节也能成块', () => {
    const msg = createContextMessage([{ name: 'qqbot.memory', text: '【关于他】在考研。\n' }]);
    expect(msg).toBeDefined();
    expect(((msg as { source: { sections: unknown[] } }).source.sections)).toHaveLength(1);
  });
});
