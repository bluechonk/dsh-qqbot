/**
 * 群友长期记忆 — 纯逻辑部分
 *
 * 三件事：
 *   1. `MemoryFact` 结构与 `memory` 块的读写（追加、去重、封顶）
 *   2. 渲染注入行（【关于他】…，紧跟档案行之后走旁白区）
 *   3. 兼容老档案（没有 memory 字段照常工作）
 *
 * 全部做成纯函数，是为了零成本、可测试：
 * qqchat 预设是零工具的，记忆的积累只能靠插件侧异步摘要，不能靠模型。
 *
 * 去重复用 anti-repeat/format.ts 的 bigram Jaccard，阈值调高到 0.85：
 * 摘要不依赖「已摘要到第 N 条」的断点（compaction 会重排事件序号，断点必错乱），
 * 幂等完全靠写入端去重——同一段对话被重复摘要，产出的相似事实由这里吸收。
 */
import { similarity } from '../anti-repeat/format.ts';

/** 一条长期记忆：短、事实性（「养了只叫豆豆的猫」） */
export interface MemoryFact {
  /** 一句话，第三人称 */
  text: string;
  /** 记下的时间戳（ms） */
  at: number;
  /** 来源：插件侧摘要 / 本地启发式 */
  source: 'summary' | 'heuristic';
}

/** `people.json` 里每个人的 memory 块（可选字段，老档案没有） */
export interface PersonMemory {
  /** 结构版本，便于将来迁移 */
  version: 1;
  facts: MemoryFact[];
  /** 上次摘要时间戳（ms） */
  summarizedAt?: number;
}

/** 相似度阈值：bigram Jaccard 达到它即视为「同一件事」 */
const DEDUP_THRESHOLD = 0.85;

/**
 * 把一条新事实并入 memory 块。
 *
 * - 与已有事实相似（Jaccard ≥ 0.85）→ 只刷新那条的时间戳，不新增
 * - 否则追加；条数超过 maxFacts 时按「最久未被重新确认」（at 最旧）淘汰
 * - 相同文本的完全重复不更新时间戳：摘要本就是异步重复触发的，
 *   恒定的事实没必要靠刷新伪装成新记忆
 *
 * 返回改动说明：`added` / `refreshed` / `skipped`（完全重复），
 * 调用方据此留痕（静默变化是本项目最贵的 bug）。
 */
export function mergeFact(
  memory: PersonMemory,
  text: string,
  at: number,
  maxFacts: number,
): { memory: PersonMemory; kind: 'added' | 'refreshed' | 'skipped' } {
  const trimmed = text.trim();
  if (!trimmed) return { memory, kind: 'skipped' };

  const existing = memory.facts ?? [];
  const dup = existing.find((f) => f.text === trimmed);
  if (dup) return { memory, kind: 'skipped' };

  const similar = existing.find((f) => similarity(f.text, trimmed) >= DEDUP_THRESHOLD);
  if (similar) {
    return {
      memory: {
        ...memory,
        facts: existing.map((f) => (f === similar ? { ...f, at } : f)),
      },
      kind: 'refreshed',
    };
  }

  // 封顶：超出后按 at 最旧淘汰，保证注入的始终是最近被确认的那批
  const facts = [...existing, { text: trimmed, at, source: 'summary' as const }];
  const capped = facts.length > maxFacts
    ? [...facts].sort((a, b) => a.at - b.at).slice(facts.length - maxFacts)
    : facts;

  return { memory: { ...memory, facts: capped }, kind: 'added' };
}

/**
 * 注入条数上限：私聊用配置值，群聊减半（群里别像查户口）。
 * `configured` 来自 `people.memory.injectFacts`（默认 5 → 群 2）。
 */
export function injectLimit(isGroup: boolean, configured = 5): number {
  return isGroup ? Math.floor(configured / 2) : configured;
}

/**
 * 把 memory 渲染成注入行。
 *
 * 刻意写得像旁白而不是表格——表格会让模型开始复述资料（与 buildProfileLine 同一取向）。
 * 只取最近 N 条（按 at 倒序），单条截断，超长省略。
 */
export function buildMemoryLine(
  memory: PersonMemory | undefined,
  options: { isGroup: boolean; injectFacts?: number; maxCharsPerFact?: number },
): string {
  const facts = memory?.facts ?? [];
  if (facts.length === 0) return '';

  const limit = injectLimit(options.isGroup, options.injectFacts);
  const maxChars = options.maxCharsPerFact ?? 40;
  const recent = [...facts].sort((a, b) => b.at - a.at).slice(0, limit);
  const parts = recent.map((f) =>
    f.text.length > maxChars ? `${f.text.slice(0, maxChars)}…` : f.text,
  );

  if (parts.length === 0) return '';
  return `【关于他】${parts.join('；')}。\n`;
}

/**
 * 剥掉模型常加的 markdown 代码围栏（```json … ```），只留内部 JSON。
 * 内容本身仍必须是 JSON——围栏只是外壳，不是解析放宽。
 */
function stripCodeFence(raw: string): string {
  const t = raw.trim();
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  return m?.[1]?.trim() ?? t;
}

/**
 * 解析摘要器输出（LLM 返回的 JSON）→ 事实文本数组。
 *
 * 严格白名单：非 JSON、缺字段、类型不对、条目不是非空字符串，一律返回 undefined
 * 让调用方整批丢弃——不猜、不修补、不写半截数据。
 */
export function parseSummaryOutput(raw: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const facts = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return undefined;
  if (!facts.every((f) => typeof f === 'string' && f.trim() !== '')) return undefined;
  return facts as string[];
}
