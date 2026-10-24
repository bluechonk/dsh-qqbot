/**
 * 上下文快照 —— 「上下文的上下文」
 *
 * 之前所有提示（深夜 / 群聊氛围 / 群友档案 / 记忆 / 防复读）都拼在**用户消息的
 * 文本**里，与用户说的话混在同一条消息中。但 DSH 的上下文是分层的：
 * runtime-context 快照、`<system-reminder>`、技能指令都是**独立的 user/message
 * 事件**，各有自己的 source。
 *
 * 这里把插件的提示改成同样形态：一条 `source.kind='plugin'` + `form='snapshot'`
 * 的消息，经 `agent.inbox.prepend('next-turn', ...)` 注入下一轮**最前面**；
 * 用户消息只留用户真正说的话（+ 图片 + 引用）。
 *
 * 为什么用 inbox 而不是连发两条 followup：followup 的文档明写
 * 「该消息成为自己那一轮的唯一普通消息」——连发两条会变成两轮，
 * 上下文块会被单独当一轮处理。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** 快照分节（name 用于排障时定位是哪一块） */
export interface ContextSection {
  readonly name: string;
  readonly text: string;
}

/** 插件上下文快照的来源标识 */
const CONTEXT_SOURCE = { kind: 'plugin' as const, plugin: 'dsh-im-qqbot' as const };

/**
 * 构建上下文快照消息。
 *
 * content 与 sections 保持一致——DSH 的 runtime-context 也是这样：正文用于
 * 渲染与兼容，sections 用于结构化呈现。空 sections 返回 undefined，
 * 调用方据此跳过注入（没有上下文时不发空块）。
 */
export function createContextMessage(sections: readonly ContextSection[]) {
  if (sections.length === 0) return undefined;
  // 每个分节的 text 自带结尾换行，直接拼接（join('\n') 会多出一个空行）
  const text = sections.map((s) => s.text).join('');
  return createUserMessage({
    content: [{ type: 'text' as const, text }],
    source: { ...CONTEXT_SOURCE, form: 'snapshot' as const, sections },
  });
}
