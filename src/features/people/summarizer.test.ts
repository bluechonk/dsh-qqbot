/**
 * 摘要器测试 — 打桩 llm.stream，覆盖提示词组装与输出解析的失败分支。
 */
import { describe, expect, it } from 'vitest';
import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm';
import { buildSummaryPrompt, summarizeFacts, type LlmRuntimeLike, type SummaryModelOptions } from './summarizer.ts';

const MODEL: SummaryModelOptions = { provider: 'p', model: 'm' };

/** 打桩 llm：把一段文本按真实流的形状吐出来 */
function stubLlm(response: string, finish: FinishReason = { kind: 'stop' }): LlmRuntimeLike {
  return {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk;
      yield { type: 'text-delta', index: 0, text: response } as StreamChunk;
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: response },
      } as StreamChunk;
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } as StreamChunk;
      yield { type: 'finish', reason: finish } as StreamChunk;
    },
  };
}

/** 记录收到的 GenerateOptions，供断言 provider/model 传递正确 */
function recordingLlm(response: string, captured: { options?: unknown }): LlmRuntimeLike {
  return {
    async *stream(options) {
      captured.options = options;
      yield* stubLlm(response).stream(options);
    },
  };
}

describe('buildSummaryPrompt', () => {
  it('包含对话、规则与 JSON 输出要求', () => {
    const prompt = buildSummaryPrompt('他说：我家猫豆豆又吐了', []);
    expect(prompt).toContain('我家猫豆豆又吐了');
    expect(prompt).toContain('{"facts":');
    expect(prompt).toContain('不记寒暄与当次情绪');
  });

  it('已记住的事实进入提示词（避免重复记）', () => {
    const prompt = buildSummaryPrompt('对话', ['养了只叫豆豆的猫']);
    expect(prompt).toContain('- 养了只叫豆豆的猫');
  });

  it('没有已记住的事实时标注暂无', () => {
    expect(buildSummaryPrompt('对话', [])).toContain('（暂无）');
  });
});

describe('summarizeFacts', () => {
  const signal = new AbortController().signal;

  it('合法 JSON → 解析出事实数组', async () => {
    const facts = await summarizeFacts(stubLlm('{"facts":["养了只叫豆豆的猫"]}'), MODEL, '提示词', signal);
    expect(facts).toEqual(['养了只叫豆豆的猫']);
  });

  it('围栏包裹的 JSON 也能解析', async () => {
    const facts = await summarizeFacts(stubLlm('```json\n{"facts":["在考研"]}\n```'), MODEL, '提示词', signal);
    expect(facts).toEqual(['在考研']);
  });

  it('空数组是合法结果（没有新信息）', async () => {
    const facts = await summarizeFacts(stubLlm('{"facts":[]}'), MODEL, '提示词', signal);
    expect(facts).toEqual([]);
  });

  it('解析失败 → undefined（整批丢弃，不抛异常）', async () => {
    const facts = await summarizeFacts(stubLlm('我觉得可以记这几条：养了只猫'), MODEL, '提示词', signal);
    expect(facts).toBeUndefined();
  });

  it('空回复 → undefined', async () => {
    const facts = await summarizeFacts(stubLlm(''), MODEL, '提示词', signal);
    expect(facts).toBeUndefined();
  });

  it('error finish → 抛异常（调用方留痕）', async () => {
    await expect(
      summarizeFacts(stubLlm('', { kind: 'error', failure: { message: '额度耗尽' } }), MODEL, '提示词', signal),
    ).rejects.toThrow('额度耗尽');
  });

  it('provider / model / maxTokens 透传给 llm.stream', async () => {
    const captured: { options?: unknown } = {};
    await summarizeFacts(recordingLlm('{"facts":[]}', captured), { provider: 'p1', model: 'm1', maxTokens: 77 }, '提示词', signal);
    const options = captured.options as { provider: string; model: string; maxTokens: number };
    expect(options.provider).toBe('p1');
    expect(options.model).toBe('m1');
    expect(options.maxTokens).toBe(77);
  });

  it('未传 maxTokens 时默认 512', async () => {
    const captured: { options?: unknown } = {};
    await summarizeFacts(recordingLlm('{"facts":[]}', captured), MODEL, '提示词', signal);
    expect((captured.options as { maxTokens: number }).maxTokens).toBe(512);
  });
});
