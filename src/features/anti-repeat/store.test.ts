/**
 * 防复读流水测试
 *
 * 纯内存、按会话隔离：不同群的复读判定互不影响。
 */
import { describe, expect, it } from 'vitest';
import { ReplyHistory } from './store.ts';

describe('ReplyHistory', () => {
  it('记录后能读回（旧→新）', () => {
    const h = new ReplyHistory(5);
    h.record('k1', '第一句');
    h.record('k1', '第二句');
    expect(h.list('k1')).toEqual(['第一句', '第二句']);
  });

  it('超出容量时丢最早的', () => {
    const h = new ReplyHistory(2);
    h.record('k1', 'a');
    h.record('k1', 'b');
    h.record('k1', 'c');
    expect(h.list('k1')).toEqual(['b', 'c']);
  });

  it('空内容不记（[skip] 之外的空串不算发言）', () => {
    const h = new ReplyHistory(5);
    h.record('k1', '   ');
    h.record('k1', '');
    expect(h.list('k1')).toEqual([]);
  });

  it('按会话隔离', () => {
    const h = new ReplyHistory(5);
    h.record('k1', '群 A 的话');
    h.record('k2', '群 B 的话');
    expect(h.list('k1')).toEqual(['群 A 的话']);
    expect(h.list('k2')).toEqual(['群 B 的话']);
  });

  it('clear 只清指定会话', () => {
    const h = new ReplyHistory(5);
    h.record('k1', 'a');
    h.record('k2', 'b');
    h.clear('k1');
    expect(h.list('k1')).toEqual([]);
    expect(h.list('k2')).toEqual(['b']);
  });

  it('未记录的会话返回空数组而不是 undefined', () => {
    expect(new ReplyHistory().list('nope')).toEqual([]);
  });
});
