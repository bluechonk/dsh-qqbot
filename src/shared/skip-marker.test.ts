import { describe, expect, it } from 'vitest';
import { isSkipReply, SKIP_MARKER } from './skip-marker.ts';

describe('isSkipReply', () => {
  it('整段恰为沉默标记时判真', () => {
    expect(isSkipReply(SKIP_MARKER)).toBe(true);
  });

  it('允许首尾空白', () => {
    expect(isSkipReply('  [skip]  ')).toBe(true);
    expect(isSkipReply('\n[skip]\n')).toBe(true);
  });

  it('正文里包含标记但不等于标记时不判真', () => {
    expect(isSkipReply('我看 [skip] 这个')).toBe(false);
    expect(isSkipReply('[skip] 然后说点什么')).toBe(false);
  });

  it('空文本判假', () => {
    expect(isSkipReply('')).toBe(false);
    expect(isSkipReply('   ')).toBe(false);
  });
});
