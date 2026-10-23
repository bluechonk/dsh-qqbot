/**
 * 表情包 — 情绪推断（M5）
 *
 * 为什么需要它：qqchat 是**零工具**预设，模型没法调用 `send_sticker`。
 * 所以表情不能由模型选，只能由插件在**拿到回复文本之后**自己判断「她现在的情绪」，
 * 再据此挑一张图。
 *
 * 一个副作用是好的：插件挑图比模型挑更稳、更便宜，也不会因为模型「忘了用工具」
 * 而永远发不出表情。
 *
 * 这里是纯函数：回复文本 → 情绪标签（对应 catalog 的 L2 情绪维度）。
 */

/** 情绪标签集（与 docs 里 L2 设计一致，故意做小：标签多了选不出来） */
export const MOODS = [
  '得意', '嘲讽', '委屈', '卖萌', '无语', '开心', '生气', '疑惑',
] as const;

export type Mood = (typeof MOODS)[number];

/**
 * 情绪关键词表。
 *
 * 只收「高置信度」的词——宁可判断不出情绪也不乱配图，
 * 配错表情比不配更尴尬（严肃场景突然一个卖萌图）。
 */
const MOOD_WORDS: ReadonlyArray<{ mood: Mood; words: readonly string[] }> = [
  { mood: '得意', words: ['本来就', '废话', '当然', '算你', '厉害吧', '小看我', '切'] },
  { mood: '嘲讽', words: ['就这', '笑死', '你也配', '菜', '歪', '不行啊', '哈哈哈'] },
  { mood: '委屈', words: ['哼', '不理你', '过分', '欺负', '凭什么', '算了'] },
  { mood: '卖萌', words: ['嘛', '啦', '呀', '嘿嘿', '呜', '贴贴', '抱'] },
  { mood: '无语', words: ['无语', '服了', '行吧', '随你', '……', '呵呵'] },
  { mood: '开心', words: ['好耶', '开心死', '我喜欢', '好玩', '太棒了'] },
  { mood: '生气', words: ['讨厌', '烦', '生气', '滚', '闭嘴'] },
  { mood: '疑惑', words: ['？', '啥', '什么意思', '为什么', '奇怪'] },
];

/**
 * 从回复文本里推断情绪。
 *
 * 按表顺序取**第一个命中**：表是刻意排序的，「得意/嘲讽」这类特征词
 * 比「卖萌」的语气词更有辨识度，先匹配它们更准。
 */
export function inferMood(reply: string): Mood | undefined {
  const text = String(reply ?? '');
  if (!text.trim()) return undefined;
  for (const entry of MOOD_WORDS) {
    if (entry.words.some((word) => text.includes(word))) return entry.mood;
  }
  return undefined;
}
