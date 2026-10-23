/**
 * 防复读 — 纯逻辑部分
 *
 * 复读机是 LLM 群聊最大的扣分项，比「不拟人」更劝退：
 * 「哼，又来？」说三遍，群里立刻知道这是机器。
 *
 * 本模块走**预防式**而不是事后纠正：
 *   - 事后纠正（发现重复 → 回灌「你刚说过X」让其重写）要多跑一轮模型，
 *     翻倍延迟与 token，而 qqchat 是陪聊场景，延迟很敏感。
 *   - 预防式只需把「你最近说过什么」塞进上下文，模型自己就会换说法。
 *
 * 这里只做纯函数：相似度判定 + 提示渲染，便于单测。
 */

/** 相似度阈值：超过这个值就算「说过差不多的话」 */
export const SIMILAR_THRESHOLD = 0.72;

/** 把文本切成字符二元组（中文没有词边界，bigram 最稳） */
function bigrams(text: string): Set<string> {
  const normalized = String(text ?? '')
    .toLowerCase()
    // 抹掉标点与空白：语气差别不该算「不同」
    .replace(/[\s，。！？、；：,.!?;:…~～\-—"'“”‘’()（）【】\[\]]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) {
    out.add(normalized.slice(i, i + 2));
  }
  // 单字文本没有 bigram，退回单字集合，避免全判 0
  if (out.size === 0 && normalized.length === 1) out.add(normalized);
  return out;
}

/**
 * 两段文本的相似度（字符 bigram 的 Jaccard 系数，0~1）。
 *
 * 为什么不用编辑距离：这里判的是「说法是否雷同」而不是「字面差几个字」，
 * Jaccard 对词序变化更宽容。
 */
export function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const gram of left) {
    if (right.has(gram)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 在历史回复里找最像的一条，返回相似度与原文 */
export function findMostSimilar(
  reply: string,
  history: readonly string[],
): { score: number; matched?: string } {
  let best = { score: 0, matched: undefined as string | undefined };
  for (const previous of history) {
    const score = similarity(reply, previous);
    if (score > best.score) best = { score, matched: previous };
  }
  return best;
}

/** 是否构成「复读」 */
export function isRepeating(
  reply: string,
  history: readonly string[],
  threshold = SIMILAR_THRESHOLD,
): boolean {
  return findMostSimilar(reply, history).score >= threshold;
}

/**
 * 渲染「你最近说过」提示。
 *
 * 三个刻意的取舍：
 *
 * 1. **保留原话引用**，不省这点 token。这些原话是很好的**语气锚点**，
 *    能帮她把人格延续下去；省掉换不来什么，却让语气更容易飘。
 *    （实测：引 3 句 ≈ 60 token，在 7K 上下文里不到 1%）
 * 2. **但把「换个说法」的边界写清楚**。实测踩过：只说「换个说法，别复读」
 *    会把她推离自己刚说过的准确内容，逼她自己发明新角度。用户发短消息
 *    （「这就是你」四个字）时缺方向可循，于是跑题——那次她把
 *    「这是个 Q 版小人」读成了「你在笑我矮」。所以补一句「别为了不重复而跑题」。
 * 3. **写得像提醒而不是禁令**：说「别重复」会让她开始解释自己为什么不重复。
 */
export function buildRecentRepliesLine(history: readonly string[]): string {
  const usable = history
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-3);
  if (usable.length === 0) return '';

  const quoted = usable.map((line) => `「${clip(line, 30)}」`).join('');
  return `【你最近说过】${quoted}——换个说法，但别为了不重复而跑题。\n`;
}

/** 截断到指定长度，超出加省略号 */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
