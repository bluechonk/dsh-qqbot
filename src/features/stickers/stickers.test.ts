/**
 * 表情包 — 情绪推断与选图测试
 *
 * 这两块合起来决定「什么时候发图、发哪张」，是 M5 唯一有风险的部分：
 * 配错表情比不配更尴尬（严肃场景突然一个卖萌图），所以「不发」永远是安全答案。
 */
import { describe, expect, it } from 'vitest';
import { inferMood, MOODS } from './mood.ts';
import type { Sticker } from './catalog.ts';
import {
  afterStickerSent,
  afterTextReply,
  selectSticker,
  shouldReplaceText,
  type StickerRuntimeState,
} from './select.ts';

describe('inferMood', () => {
  it('认出得意', () => {
    expect(inferMood('废话，我本来就厉害')).toBe('得意');
  });

  it('认出嘲讽', () => {
    expect(inferMood('就这？笑死')).toBe('嘲讽');
  });

  it('认出无语', () => {
    expect(inferMood('行吧，随你')).toBe('无语');
  });

  it('认出疑惑', () => {
    expect(inferMood('什么意思啊')).toBe('疑惑');
  });

  it('普通陈述不硬判情绪', () => {
    expect(inferMood('今天天气不错，我看了一眼窗外')).toBeUndefined();
  });

  it('空回复没有情绪', () => {
    expect(inferMood('')).toBeUndefined();
    expect(inferMood('   ')).toBeUndefined();
  });

  it('表里顺序优先：得意特征词压过卖萌语气词', () => {
    // 「废话」属得意，「嘛」属卖萌；得意在前，应判得意
    expect(inferMood('废话嘛，当然是我')).toBe('得意');
  });

  it('所有返回的标签都在 MOODS 内（不会出现野标签）', () => {
    const samples = ['废话', '就这', '哼', '嘿嘿', '行吧', '好耶', '烦', '？'];
    for (const sample of samples) {
      const mood = inferMood(sample);
      if (mood !== undefined) expect(MOODS).toContain(mood);
    }
  });
});

function sticker(overrides: Partial<Sticker> = {}): Sticker {
  return { id: 's1', file: 'a.png', mood: '得意', ...overrides };
}

const READY: StickerRuntimeState = { textRepliesSinceSticker: 3 };

describe('selectSticker', () => {
  it('情绪不明 → 不发（配错比不配尴尬）', () => {
    const d = selectSticker({ stickers: [sticker()], mood: undefined, state: READY });
    expect(d.sticker).toBeUndefined();
    expect(d.reason).toBe('mood-unknown');
  });

  it('图库为空 → 不发', () => {
    const d = selectSticker({ stickers: [], mood: '得意', state: READY });
    expect(d.reason).toBe('catalog-empty');
  });

  it('连续文字条数不够 → 不发', () => {
    const d = selectSticker({
      stickers: [sticker()], mood: '得意',
      state: { textRepliesSinceSticker: 1 },
    });
    expect(d.reason).toContain('too-soon');
  });

  it('够条件且情绪匹配 → 发', () => {
    const d = selectSticker({ stickers: [sticker()], mood: '得意', state: READY });
    expect(d.sticker?.id).toBe('s1');
    expect(d.reason).toBe('mood-得意');
  });

  it('情绪不匹配 → 不发真图（宁缺毋滥）', () => {
    const d = selectSticker({
      stickers: [sticker({ mood: '委屈' })], mood: '得意', state: READY,
    });
    expect(d.reason).toContain('no-sticker-for');
  });

  it('优先选「轻」的，避免用力过猛', () => {
    const d = selectSticker({
      stickers: [
        sticker({ id: 'heavy', strength: 'heavy' }),
        sticker({ id: 'light', strength: 'light' }),
      ],
      mood: '得意', state: READY,
    });
    expect(d.sticker?.id).toBe('light');
  });

  it('冷却期内换一张', () => {
    const now = 1_000_000;
    const d = selectSticker({
      stickers: [sticker({ id: 'a' }), sticker({ id: 'b' })],
      mood: '得意',
      state: { textRepliesSinceSticker: 3, lastSentId: 'a', lastSentAt: now - 60_000 },
      now,
    });
    expect(d.sticker?.id).toBe('b');
  });

  it('只有那一张且在冷却 → 不发（不连发同一张）', () => {
    const now = 1_000_000;
    const d = selectSticker({
      stickers: [sticker({ id: 'a' })],
      mood: '得意',
      state: { textRepliesSinceSticker: 3, lastSentId: 'a', lastSentAt: now - 60_000 },
      now,
    });
    expect(d.reason).toBe('only-sticker-cooling');
  });

  it('冷却过了可以再发同一张', () => {
    const now = 1_000_000;
    const d = selectSticker({
      stickers: [sticker({ id: 'a' })],
      mood: '得意',
      state: { textRepliesSinceSticker: 3, lastSentId: 'a', lastSentAt: now - 11 * 60_000 },
      now,
    });
    expect(d.sticker?.id).toBe('a');
  });
});

describe('shouldReplaceText', () => {
  it('极短回复用表情替代文字', () => {
    expect(shouldReplaceText('哦')).toBe(true);
    expect(shouldReplaceText('行吧')).toBe(true);
  });

  it('只有标点不算有内容', () => {
    expect(shouldReplaceText('……')).toBe(false);
  });

  it('正常长度回复不替代（该说话还是说话）', () => {
    expect(shouldReplaceText('累就靠过来点，别硬撑')).toBe(false);
  });

  it('空回复不替代', () => {
    expect(shouldReplaceText('')).toBe(false);
  });
});

describe('状态流转', () => {
  it('发完文字计数 +1', () => {
    expect(afterTextReply({ textRepliesSinceSticker: 0 }).textRepliesSinceSticker).toBe(1);
  });

  it('发完表情计数归零并记住 id', () => {
    const next = afterStickerSent(sticker({ id: 'x' }), 123);
    expect(next).toEqual({ textRepliesSinceSticker: 0, lastSentId: 'x', lastSentAt: 123 });
  });
});
