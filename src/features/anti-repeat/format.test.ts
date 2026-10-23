/**
 * 防复读 — 纯逻辑测试
 *
 * 判「说法是否雷同」而不是「字面差几个字」，所以用 bigram Jaccard：
 * 中文没有词边界，bigram 最稳；抹掉标点是因为语气差别不该算「不同说法」。
 */
import { describe, expect, it } from 'vitest';
import {
  buildRecentRepliesLine,
  findMostSimilar,
  isRepeating,
  similarity,
} from './format.ts';

describe('similarity', () => {
  it('完全相同为 1', () => {
    expect(similarity('哼，又来？', '哼，又来？')).toBe(1);
  });

  it('只差标点仍算相同（语气差别不该算不同说法）', () => {
    expect(similarity('哼，又来？', '哼 又来')).toBe(1);
  });

  it('完全不相干接近 0', () => {
    expect(similarity('今天天气不错', '这个报错怎么修')).toBeLessThan(0.1);
  });

  it('换了说法但骨架雷同 → 判为相似', () => {
    // 典型的 LLM 复读：同一句话稍微改几个字
    expect(similarity('哼，又来？', '哼，又来了')).toBeGreaterThan(0.5);
    expect(similarity('别烦我啊', '别烦我啊你')).toBeGreaterThan(0.5);
  });

  it('只是开头撞了、后半完全不同 → 不算相似（避免误判）', () => {
    // 这句只共享「哼，又来？」的开头，后半差异大，不该被判成复读
    expect(similarity('哼，又来？你怎么老是这样', '哼，又来？你老是这个样子'))
      .toBeLessThan(0.5);
  });

  it('空串与空串为 1，空串与非空为 0', () => {
    expect(similarity('', '')).toBe(1);
    expect(similarity('', '有内容')).toBe(0);
  });
});

describe('isRepeating', () => {
  it('命中历史则算复读', () => {
    expect(isRepeating('哼，又来？', ['哼，又来？', '别烦我'])).toBe(true);
  });

  it('与历史都不像则不算', () => {
    expect(isRepeating('今天的月亮真圆', ['哼，又来？', '别烦我'])).toBe(false);
  });

  it('历史为空不算复读', () => {
    expect(isRepeating('随便说点什么', [])).toBe(false);
  });

  it('阈值可调', () => {
    const a = '哼，又来？你怎么老是这样';
    const b = '哼，又来？你老是这个样子';
    expect(isRepeating(a, [b], 0.2)).toBe(true);
    expect(isRepeating(a, [b], 0.99)).toBe(false);
  });
});

describe('findMostSimilar', () => {
  it('返回最像的那条与分数', () => {
    const result = findMostSimilar('哼，又来？', ['别烦我', '哼，又来？']);
    expect(result.score).toBe(1);
    expect(result.matched).toBe('哼，又来？');
  });

  it('无历史时分数为 0', () => {
    expect(findMostSimilar('随便', [])).toEqual({ score: 0, matched: undefined });
  });
});

describe('buildRecentRepliesLine', () => {
  it('没有历史时不注入', () => {
    expect(buildRecentRepliesLine([])).toBe('');
    expect(buildRecentRepliesLine(['  ', ''])).toBe('');
  });

  it('带出最近的发言并提示换说法', () => {
    const line = buildRecentRepliesLine(['哼，又来？', '别烦我']);
    expect(line).toContain('哼，又来？');
    expect(line).toContain('复读');
  });

  it('最多只带 3 条，避免把上下文撑长', () => {
    const line = buildRecentRepliesLine(['a1', 'b2', 'c3', 'd4', 'e5']);
    expect(line).toContain('c3');
    expect(line).toContain('e5');
    expect(line).not.toContain('a1');
  });

  it('过长的发言被截断', () => {
    const long = '很'.repeat(100);
    const line = buildRecentRepliesLine([long]);
    expect(line.length).toBeLessThan(100);
    expect(line).toContain('…');
  });
});
