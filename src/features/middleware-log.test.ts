/**
 * 中间件链丢弃留痕 — 单测
 *
 * 重点是「分类」与「合并镜像」：
 * · 分类决定哪些 stop 会被记下来（命令正常处理不记，越权要记）
 * · 合并镜像是 SDK defaultMerge 的副本，语义漂移会让「发两条只回一条」
 *   从「可解释」退化成「真的丢内容」
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MiddlewareDropLog,
  chainSentinel,
  classifyStopReason,
  describeContext,
  mergeWithLog,
} from './middleware-log.ts';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

function tempLog(enabled = true): { log: MiddlewareDropLog; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mwlog-'));
  return {
    dir,
    file: join(dir, 'middleware-drops.jsonl'),
    log: new MiddlewareDropLog({ filePath: join(dir, 'middleware-drops.jsonl'), enabled }),
  };
}

function lines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('classifyStopReason', () => {
  it('无原因不记（链没被短路）', () => {
    expect(classifyStopReason(undefined)).toBeUndefined();
  });

  it('命令被正常处理不记（消息没丢，记了只会淹没真正的丢弃）', () => {
    expect(classifyStopReason('command:matched:model')).toBeUndefined();
    expect(classifyStopReason('command:matched:bot-help')).toBeUndefined();
  });

  it('命令级拒绝记为 denied（安全审计）', () => {
    expect(classifyStopReason('command:unauthorized:model')).toBe('denied');
    expect(classifyStopReason('command:scope-denied:new')).toBe('denied');
  });

  it('SDK 各关卡的 stop 都记为 drop', () => {
    expect(classifyStopReason('deduplication')).toBe('drop');
    expect(classifyStopReason('self-echo')).toBe('drop');
    expect(classifyStopReason('access:not in allowlist (group)')).toBe('drop');
    expect(classifyStopReason('mention-gate:no_mention')).toBe('drop');
    expect(classifyStopReason('mention-gate:other_mention')).toBe('drop');
    expect(classifyStopReason('rate-limit:global')).toBe('drop');
    expect(classifyStopReason('concurrency:merge-full')).toBe('drop');
  });
});

describe('MiddlewareDropLog', () => {
  it('落盘一条 JSONL', () => {
    const { log, file, dir } = tempLog();
    try {
      log.record({ ts: 1, kind: 'drop', reason: 'deduplication', chatKind: 'group', senderId: 'S1' });
      const entries = lines(file);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'drop', reason: 'deduplication', chatKind: 'group', senderId: 'S1' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('关闭时不写文件', () => {
    const { log, file, dir } = tempLog(false);
    try {
      log.record({ ts: 1, kind: 'drop', reason: 'deduplication' });
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写入失败不影响调用方（目录不可写时静默）', () => {
    const { log } = tempLog();
    const bad = new MiddlewareDropLog({ filePath: join('Z:', 'no-such-drive', 'x.jsonl'), enabled: true });
    expect(() => bad.record({ ts: 1, kind: 'drop', reason: 'x' })).not.toThrow();
    expect(() => log.record({ ts: 1, kind: 'drop', reason: 'x' })).not.toThrow();
  });
});

describe('describeContext', () => {
  it('只输出存在的字段', () => {
    const ctx = {
      message: { kind: 'group', senderId: 'S1', messageId: 'M1' },
      replyTarget: { scope: 'group', targetId: 'G1' },
    } as unknown as MiddlewareContext;
    expect(describeContext(ctx)).toEqual({ chatKind: 'group', senderId: 'S1', targetId: 'G1', messageId: 'M1' });
  });

  it('缺失字段省略而不是写 undefined', () => {
    const ctx = { message: {}, replyTarget: {} } as unknown as MiddlewareContext;
    expect(describeContext(ctx)).toEqual({});
  });
});

describe('chainSentinel', () => {
  /** 造一个最小 ctx：只需 stop / stopReason / message / replyTarget */
  function fakeCtx() {
    let stopped = false;
    let stopReason: string | undefined;
    return {
      ctx: {
        stop: (reason?: string) => { stopped = true; stopReason = reason; },
        get stopped() { return stopped; },
        get stopReason() { return stopReason; },
        message: { kind: 'group', senderId: 'S1', messageId: 'M1' },
        replyTarget: { scope: 'group', targetId: 'G1' },
      } as unknown as MiddlewareContext,
      isStopped: () => stopped,
      reason: () => stopReason,
    };
  }

  it('下游 stop 后记一条留痕', async () => {
    const { log, file, dir } = tempLog();
    try {
      const { ctx } = fakeCtx();
      const sentinel = chainSentinel(log);
      await sentinel(ctx, async () => { ctx.stop('deduplication'); });
      const entries = lines(file);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'drop', reason: 'deduplication', senderId: 'S1' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('下游正常走完不记', async () => {
    const { log, file, dir } = tempLog();
    try {
      const { ctx } = fakeCtx();
      await chainSentinel(log)(ctx, async () => { /* 正常 */ });
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('下游抛错时仍要记下已发生的 stop，并把错误继续抛给 errorHandler', async () => {
    const { log, file, dir } = tempLog();
    try {
      const { ctx } = fakeCtx();
      const boom = async () => { ctx.stop('access:denied by deny-list (G1)'); throw new Error('boom'); };
      await expect(chainSentinel(log)(ctx, boom)).rejects.toThrow('boom');
      const entries = lines(file);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'drop', reason: 'access:denied by deny-list (G1)' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('越权命令记为 denied', async () => {
    const { log, file, dir } = tempLog();
    try {
      const { ctx } = fakeCtx();
      await chainSentinel(log)(ctx, async () => { ctx.stop('command:unauthorized:model'); });
      expect(lines(file)[0]).toMatchObject({ kind: 'denied' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mergeWithLog', () => {
  function msgCtx(content: string, messageId: string, extra: Partial<MiddlewareContext['message']> = {}): MiddlewareContext {
    return {
      message: { kind: 'group', senderId: 'S1', messageId, content, ...extra },
      replyTarget: { scope: 'group', targetId: 'G1' },
      state: {},
    } as unknown as MiddlewareContext;
  }

  it('单条不记（没有合并发生）', () => {
    const { log, file, dir } = tempLog();
    try {
      const only = msgCtx('a', 'M1');
      const out = mergeWithLog(log, [only]);
      expect(out).toBe(only);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('多条：留痕 count + ids，内容用换行拼接', () => {
    const { log, file, dir } = tempLog();
    try {
      const a = msgCtx('第一句', 'M1');
      const b = msgCtx('第二句', 'M2');
      const out = mergeWithLog(log, [a, b]);
      expect(out).toBe(a);
      expect(out.message.content).toBe('第一句\n第二句');
      const entries = lines(file);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'merge', count: 2, ids: ['M1', 'M2'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('空内容的消息不参与拼接（与 SDK 一致）', () => {
    const { log, dir } = tempLog();
    try {
      const a = msgCtx('第一句', 'M1');
      const b = msgCtx('', 'M2');
      const out = mergeWithLog(log, [a, b]);
      expect(out.message.content).toBe('第一句');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('合并 attachments（合并批次里的附件都要保留）', () => {
    const { log, dir } = tempLog();
    try {
      const a = msgCtx('第一句', 'M1', { attachments: [{ fileName: 'a.png' }] });
      const b = msgCtx('第二句', 'M2', { attachments: [{ fileName: 'b.png' }] });
      const out = mergeWithLog(log, [a, b]);
      expect(out.message.attachments).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('留痕失败不影响合并本身', () => {
    const bad = new MiddlewareDropLog({ filePath: join('Z:', 'no-such-drive', 'x.jsonl'), enabled: true });
    const a = msgCtx('第一句', 'M1');
    const b = msgCtx('第二句', 'M2');
    const out = mergeWithLog(bad, [a, b]);
    expect(out.message.content).toBe('第一句\n第二句');
  });
});
