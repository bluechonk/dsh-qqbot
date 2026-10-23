/**
 * 插件侧异步摘要器 — 把「与某人的最近对话」提炼成长期记忆事实。
 *
 * 设计（docs/群友档案.md 第七、十五节）：
 *   - 输入含**机器人的回复**：它回了什么，本身就是「什么值得在意」的信号
 *   - 输出严格 JSON `{"facts": [...]}`；解析失败返回 undefined，调用方整批丢弃并留痕
 *   - 摘要模型可配置（provider/model），走 `ctx.get('llm').stream`，与 vision-tool 同一约定
 *
 * 本模块只负责「一次摘要调用」：拼提示词、调模型、解析。
 * 触发时机、并发守卫、写入档案在 gateway 接线与 store 里。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { parseSummaryOutput } from './memory.ts';

/** llm 服务最小接口（与 vision-tool 同一约定） */
export interface LlmRuntimeLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

/** 摘要模型的调用配置（provider/model 必填，未配置则整个功能跳过） */
export interface SummaryModelOptions {
  provider: string;
  model: string;
  /** 单次摘要的输出上限；事实都是短句，默认给小值 */
  maxTokens?: number;
}

/** 将终端 finish reason 转成摘要调用失败 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new Error(finish.failure.message);
    default:
      return undefined;
  }
}

/** 单条事实的长度上限（与注入行的截断一致，防爆 token） */
const MAX_FACT_CHARS = 40;

/**
 * 拼摘要提示词（纯函数，可测）。
 *
 * 要点来自设计稿第七节：只记本人长期事实、不记寒暄与当次情绪、
 * 没有新信息返回空数组、带正反例 few-shot、附已有事实避免重复记。
 */
export function buildSummaryPrompt(transcript: string, knownFacts: readonly string[]): string {
  const known = knownFacts.length > 0
    ? `已经记住的事实（不要重复记，除非有实质更新）：\n${knownFacts.map((f) => `- ${f}`).join('\n')}`
    : '已经记住的事实：（暂无）';

  return [
    '你在为一个聊天机器人的长期记忆做摘要。下面是它与某一个人的最近对话。',
    '',
    '只提炼关于这个人的、长期有用的事实：怎么称呼、喜好、经历、正在忙的事、重要的人际关系。',
    '',
    '规则：',
    `- 只记这个人本人的事；不记机器人自己的话，不记寒暄与当次情绪，不记一次性话题`,
    `- 每条一句话、第三人称、具体，长度不超过 ${MAX_FACT_CHARS} 字`,
    '- 例：他说「我家猫豆豆又吐了」→ 记「养了只叫豆豆的猫」；他说「今天好累」→ 不记（当次情绪）',
    '- 没有值得记的新信息就返回空数组——硬凑一条比什么都不记更糟',
    '- 只输出 JSON：{"facts": ["…", "…"]}，不要输出其它任何内容',
    '',
    known,
    '',
    '最近对话：',
    transcript,
  ].join('\n');
}

/**
 * 调摘要模型并解析输出。
 *
 * 返回 undefined 表示「这次摘要没有可用产出」（空回复 / 解析失败），
 * 调用方整批丢弃并留痕；模型调用本身的失败以异常抛出，同样由调用方留痕。
 */
export async function summarizeFacts(
  llm: LlmRuntimeLike,
  model: SummaryModelOptions,
  prompt: string,
  signal: AbortSignal,
): Promise<string[] | undefined> {
  const message = createUserMessage({
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: 'dsh-im-qqbot' },
  });

  const options: GenerateOptions = {
    provider: model.provider,
    model: model.model,
    messages: [message],
    maxTokens: model.maxTokens ?? 512,
    signal,
  };

  const assembler = new BlockAssembler();
  for await (const chunk of llm.stream(options)) {
    assembler.push(chunk);
  }
  const terminal = finishError(assembler.finish);
  if (terminal !== undefined) throw terminal;

  const text = assembler.blocks()
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim();
  if (text.length === 0) return undefined;
  return parseSummaryOutput(text);
}
