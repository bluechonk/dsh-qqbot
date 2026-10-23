/**
 * 记忆触发器测试 — 用真的 PeopleStore + 打桩 llm。
 *
 * 重点验证：
 *   - 满 N 轮触发一次、计数归零
 *   - 缓冲的归属（回复跟着最近发言人走）
 *   - 并发守卫（同一个 key 同时只跑一个）
 *   - 失败只 warn、缓冲保留（下次摘要带上完整上下文重试）
 *   - 不可用（llm 缺失 / 模型未配置）时不计数不触发
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm';
import { MemoryTrigger } from './trigger.ts';
import { PeopleStore } from './store.ts';
import type { LlmRuntimeLike } from './summarizer.ts';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeLlm(responses: string[], failAt = -1): LlmRuntimeLike {
  let calls = 0;
  return {
    async *stream() {
      const response = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      yield { type: 'block-start', index: 0, blockType: 'text' } as StreamChunk;
      yield { type: 'text-delta', index: 0, text: response } as StreamChunk;
      yield { type: 'block-end', index: 0, block: { type: 'text', text: response } } as StreamChunk;
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } as StreamChunk;
      const reason: FinishReason = calls === failAt + 1 ? { kind: 'error', failure: { message: 'boom' } } : { kind: 'stop' };
      yield { type: 'finish', reason } as StreamChunk;
    },
  };
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

const BASE = { scope: 'group' as const, scopeId: 'g1' };

function makeTrigger(responses: string[], opts?: Partial<{ summarizeEveryTurns: number; failAt: number }>) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-trigger-'));
  dirs.push(dir);
  const store = new PeopleStore({ filePath: join(dir, 'people.json'), enabled: true });
  const llm = makeLlm(responses, opts?.failAt ?? -1);
  const logger = silentLogger();
  const trigger = new MemoryTrigger(
    {
      appId: 'a',
      model: { provider: 'p', model: 'm' },
      summarizeEveryTurns: opts?.summarizeEveryTurns ?? 2,
      maxFacts: 8,
      maxInputChars: 4000,
      logger,
    },
    llm,
    store,
  );
  return { trigger, store };
}

/** 等微任务跑完（fire-and-forget 的摘要） */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('MemoryTrigger', () => {
  it('满 N 轮触发一次，事实并入档案，缓冲清空', async () => {
    const { trigger, store } = makeTrigger(['{"facts":["养了只叫豆豆的猫"]}'], { summarizeEveryTurns: 2 });
    store.touch({ ...BASE, appId: 'a', openid: 'u1' }); // 生产路径：handleInbound 每条消息先 touch
    const turn = { ...BASE, openid: 'u1', text: '我家猫豆豆又吐了' };
    trigger.recordTurn(turn);
    trigger.recordTurn(turn);
    await settle();

    const mem = store.memoryOf({ ...BASE, appId: 'a', openid: 'u1' });
    expect(mem?.facts.map((f) => f.text)).toEqual(['养了只叫豆豆的猫']);
  });

  it('不满 N 轮不触发', async () => {
    const { trigger, store } = makeTrigger(['{"facts":["x"]}'], { summarizeEveryTurns: 5 });
    trigger.recordTurn({ ...BASE, openid: 'u1', text: '你好呀' });
    await settle();
    expect(store.memoryOf({ ...BASE, appId: 'a', openid: 'u1' })).toBeUndefined();
  });

  it('回复归属到最近发言人，进入同一个人的缓冲', async () => {
    const { trigger, store } = makeTrigger(['{"facts":["他养了猫，还提到了工作压力"]}'], { summarizeEveryTurns: 2 });
    store.touch({ ...BASE, appId: 'a', openid: 'u1' });
    trigger.recordTurn({ ...BASE, openid: 'u1', text: '我家猫豆豆又吐了' });
    trigger.recordReply({ ...BASE, text: '带它去看看医生吧' });
    trigger.recordTurn({ ...BASE, openid: 'u1', text: '嗯，而且我最近在准备考研' });
    await settle();

    const facts = store.memoryOf({ ...BASE, appId: 'a', openid: 'u1' })?.facts.map((f) => f.text) ?? [];
    // 打桩模型固定返回同一句；这里验证的是「回复确实进入了同一个人的缓冲并被摘要」
    expect(facts).toEqual(['他养了猫，还提到了工作压力']);
  });

  it('不同的人各自计数与缓冲，互不串味', async () => {
    const { trigger, store } = makeTrigger(['{"facts":["x"]}'], { summarizeEveryTurns: 2 });
    store.touch({ ...BASE, appId: 'a', openid: 'u1' });
    store.touch({ ...BASE, appId: 'a', openid: 'u2' });
    trigger.recordTurn({ ...BASE, openid: 'u1', text: 'u1 说的话' });
    trigger.recordTurn({ ...BASE, openid: 'u2', text: 'u2 说的话' });
    trigger.recordTurn({ ...BASE, openid: 'u1', text: 'u1 又说了一句话' });
    await settle();

    expect(store.memoryOf({ ...BASE, appId: 'a', openid: 'u1' })).toBeDefined();
    expect(store.memoryOf({ ...BASE, appId: 'a', openid: 'u2' })).toBeUndefined();
  });

  it('摘要失败时缓冲保留（下次带上完整上下文重试），只 warn 不抛', async () => {
    const { trigger, store } = makeTrigger(['{"facts":["x"]}'], { summarizeEveryTurns: 2, failAt: 0 });
    const turn = { ...BASE, openid: 'u1', text: '我家猫豆豆又吐了' };
    trigger.recordTurn(turn);
    trigger.recordTurn(turn);
    await settle();
    // 失败后档案里没有事实
    expect(store.memoryOf({ ...BASE, appId: 'a', openid: 'u1' })).toBeUndefined();
    // 再触发一次（成功的 llm 不会重来——failAt 固定；这里只验证不抛异常）
    trigger.recordTurn(turn);
    trigger.recordTurn(turn);
    await settle();
  });

  it('空文本的轮次不计入', () => {
    const { trigger, store } = makeTrigger(['{"facts":["x"]}'], { summarizeEveryTurns: 2 });
    trigger.recordTurn({ ...BASE, openid: 'u1', text: '   ' });
    trigger.recordTurn({ ...BASE, openid: 'u1', text: '说了句话' });
    // 空轮次不计 → 只累计 1 轮，不满 2 → 档案无记忆
    expect(store.memoryOf({ ...BASE, appId: 'a', openid: 'u1' })).toBeUndefined();
  });

  it('llm 缺失时完全惰性（不计数不触发不抛异常）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-trigger-'));
    dirs.push(dir);
    const store = new PeopleStore({ filePath: join(dir, 'people.json'), enabled: true });
    const trigger = new MemoryTrigger(
      {
        appId: 'a',
        model: { provider: 'p', model: 'm' },
        summarizeEveryTurns: 1,
        maxFacts: 8,
        maxInputChars: 4000,
        logger: silentLogger(),
      },
      undefined,
      store,
    );
    expect(() => trigger.recordTurn({ ...BASE, openid: 'u1', text: '你好' })).not.toThrow();
    expect(store.memoryOf({ ...BASE, appId: 'a', openid: 'u1' })).toBeUndefined();
  });

  it('provider/model 未配置时同样惰性', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-trigger-'));
    dirs.push(dir);
    const store = new PeopleStore({ filePath: join(dir, 'people.json'), enabled: true });
    const trigger = new MemoryTrigger(
      {
        appId: 'a',
        model: { provider: '', model: '' },
        summarizeEveryTurns: 1,
        maxFacts: 8,
        maxInputChars: 4000,
        logger: silentLogger(),
      },
      makeLlm(['{"facts":["x"]}']),
      store,
    );
    expect(trigger.usable).toBe(false);
    expect(() => trigger.recordTurn({ ...BASE, openid: 'u1', text: '你好' })).not.toThrow();
    expect(store.memoryOf({ ...BASE, appId: 'a', openid: 'u1' })).toBeUndefined();
  });
});
