/**
 * 群友长期记忆 — 纯逻辑测试
 *
 * 覆盖：mergeFact 的三类结果与封顶淘汰、注入行渲染（群/私条数、截断）、
 * parseSummaryOutput 的严格白名单。
 */
import { describe, expect, it } from 'vitest';
import { buildMemoryLine, mergeFact, parseSummaryOutput, type PersonMemory } from './memory.ts';

function mem(texts: string[]): PersonMemory {
  return { version: 1, facts: texts.map((text, i) => ({ text, at: 1000 + i, source: 'summary' as const })) };
}

describe('mergeFact', () => {
  it('空文本跳过，不产生条目', () => {
    const r = mergeFact(mem(['养猫']), '   ', 2000, 8);
    expect(r.kind).toBe('skipped');
    expect(r.memory.facts).toHaveLength(1);
  });

  it('完全相同文本跳过，不刷新时间戳', () => {
    const r = mergeFact(mem(['养了只叫豆豆的猫']), '养了只叫豆豆的猫', 2000, 8);
    expect(r.kind).toBe('skipped');
    expect(r.memory.facts[0].at).toBe(1000);
  });

  it('bigram 高相似（加了个称呼）→ 刷新时间戳不新增，保留原文案', () => {
    // 「我养了只叫豆豆的猫」与「养了只叫豆豆的猫」的 bigram Jaccard = 7/8 = 0.875 ≥ 0.85
    const r = mergeFact(mem(['养了只叫豆豆的猫']), '我养了只叫豆豆的猫', 2000, 8);
    expect(r.kind).toBe('refreshed');
    expect(r.memory.facts).toHaveLength(1);
    expect(r.memory.facts[0].at).toBe(2000);
    expect(r.memory.facts[0].text).toBe('养了只叫豆豆的猫');
  });

  it('bigram 低相似（明显不同的措辞）→ 视为两条独立事实', () => {
    // 「养了一只叫豆豆的猫」vs「养了只叫豆豆的猫」的 Jaccard = 6/9 ≈ 0.667 < 0.85
    const r = mergeFact(mem(['养了只叫豆豆的猫']), '养了一只叫豆豆的猫', 2000, 8);
    expect(r.kind).toBe('added');
    expect(r.memory.facts).toHaveLength(2);
  });

  it('完全不同的文本追加', () => {
    const r = mergeFact(mem(['养了只叫豆豆的猫']), '在准备考研', 2000, 8);
    expect(r.kind).toBe('added');
    expect(r.memory.facts).toHaveLength(2);
  });

  it('超过 maxFacts 淘汰 at 最旧的', () => {
    const m = mem(['一', '二', '三']);
    const r = mergeFact(m, '四', 4000, 3);
    expect(r.kind).toBe('added');
    expect(r.memory.facts.map((f) => f.text)).toEqual(['二', '三', '四']);
  });

  it('空 memory 从零追加', () => {
    const r = mergeFact({ version: 1, facts: [] }, '在准备考研', 2000, 8);
    expect(r.kind).toBe('added');
    expect(r.memory.facts).toHaveLength(1);
  });
});

describe('buildMemoryLine', () => {
  it('无 memory 或空 facts 返回空串', () => {
    expect(buildMemoryLine(undefined, { isGroup: false })).toBe('');
    expect(buildMemoryLine({ version: 1, facts: [] }, { isGroup: false })).toBe('');
  });

  it('群聊只注入 2 条，按 at 倒序取最近的', () => {
    const line = buildMemoryLine(mem(['旧事实', '中间事实', '新事实']), { isGroup: true });
    expect(line).toBe('【关于他】新事实；中间事实。\n');
  });

  it('私聊注入 5 条', () => {
    const texts = ['一', '二', '三', '四', '五', '六'];
    const line = buildMemoryLine(mem(texts), { isGroup: false });
    expect(line).toBe('【关于他】六；五；四；三；二。\n');
  });

  it('单条超长截断并加省略号', () => {
    const long = '这是一个特别特别特别长的事实远远超过了四十个字的限制所以说必须被截断掉才可以注入到上下文里面去';
    const line = buildMemoryLine(mem([long]), { isGroup: false, maxCharsPerFact: 40 });
    expect(line).toBe(`【关于他】${long.slice(0, 40)}…。\n`);
  });
});

describe('parseSummaryOutput', () => {
  it('合法 JSON 返回字符串数组', () => {
    expect(parseSummaryOutput('{"facts":["养了只猫","在考研"]}')).toEqual(['养了只猫', '在考研']);
  });

  it('模型用 markdown 围栏包 JSON 也能解析', () => {
    expect(parseSummaryOutput('```json\n{"facts":["养了只猫"]}\n```')).toEqual(['养了只猫']);
    expect(parseSummaryOutput('```\n{"facts":["养了只猫"]}\n```')).toEqual(['养了只猫']);
  });

  it('空 facts 是合法结果（没有新信息）', () => {
    expect(parseSummaryOutput('{"facts":[]}')).toEqual([]);
  });

  it('非 JSON、非对象、缺字段、类型不对、空字符串条目 → 全部 undefined', () => {
    expect(parseSummaryOutput('不是json')).toBeUndefined();
    expect(parseSummaryOutput('["养了只猫"]')).toBeUndefined();
    expect(parseSummaryOutput('{}')).toBeUndefined();
    expect(parseSummaryOutput('{"facts":"养了只猫"}')).toBeUndefined();
    expect(parseSummaryOutput('{"facts":[1,2]}')).toBeUndefined();
    expect(parseSummaryOutput('{"facts":[""]}')).toBeUndefined();
    expect(parseSummaryOutput('null')).toBeUndefined();
  });
});
