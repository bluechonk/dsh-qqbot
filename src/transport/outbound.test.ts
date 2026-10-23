import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOutboundHandler } from './outbound.ts';
import type { QQBotSender, StreamSessionLike } from './outbound-buffer.ts';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { getReplyHistory, resetReplyHistory } from '../features/anti-repeat/index.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createSession(): StreamSessionLike {
  return { update: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue(undefined) };
}

function createBot(session: StreamSessionLike): QQBotSender {
  return {
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    openStream: vi.fn(() => session),
  };
}

const c2cTarget: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' };
const groupTarget: ReplyTarget = { scope: 'group', targetId: 'group1', msgId: 'msg1' };

function createRecord(target: ReplyTarget, sessionId = 'sess-qq'): SessionRecord {
  return {
    sessionKey: 'k',
    sessionId,
    replyTarget: target,
    agent: {},
    handle: {},
    createdAt: 0,
    lastActiveAt: 0,
  } as unknown as SessionRecord;
}

function createConfig(overrides?: Partial<ImQQBotConfig>): ImQQBotConfig {
  return {
    streaming: true,
    textChunkLimit: 4500,
    showToolResults: false,
    // 子配置必须给全：出站路径会读它们（防复读流水、表情包、回复延迟），
    // 缺了会以「读 undefined.enabled」的形式炸在测试里。
    antiRepeat: { enabled: true, historySize: 5 },
    stickers: { enabled: false, maxTextReplies: 3, cooldownMs: 600_000 },
    replyDelayMs: 0,
    replyDelayPerCharMs: 0,
    replyDelayJitterMs: 0,
    replyDelayMaxMs: 0,
    ...overrides,
  } as unknown as ImQQBotConfig;
}

/** 组装 handler：manager 按 sessionId 返回 record（默认 c2c 私聊） */
function setup(opts?: { record?: SessionRecord | undefined; config?: ImQQBotConfig }) {
  const session = createSession();
  const bot = createBot(session);
  const record = 'record' in (opts ?? {}) ? opts!.record : createRecord(c2cTarget);
  const manager = {
    findBySessionId: vi.fn((id: string) => (id === 'sess-qq' ? record : undefined)),
  } as unknown as SessionManager;
  const outbound = createOutboundHandler(manager, bot, opts?.config ?? createConfig(), createLogger());
  return { outbound, bot, session };
}

const delta = (attemptId: string, text: string) => ({ kind: 'text-delta' as const, attemptId, text });
const start = (attemptId: string) => ({ kind: 'attempt-start' as const, attemptId });

describe('OutboundRouter.routeStreamFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('流式帧路由到会话 buffer：openStream + update', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('hello');
  });

  it('attempt 切换 reset：同一条流式消息被新内容全量重写', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'partial'));
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('partial');

    outbound.routeStreamFrame('sess-qq', start('a2'));
    outbound.routeStreamFrame('sess-qq', delta('a2', 'full'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1); // 流式会话复用
    expect(session.update).toHaveBeenNthCalledWith(2, 'full'); // 全量替换
  });

  it('agent replacement（attemptId 重叠）：start 帧无条件重置', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('sess-qq:1'));
    outbound.routeStreamFrame('sess-qq', delta('sess-qq:1', 'stale'));
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('stale');

    // agent replacement 后 attempt 计数重启，attemptId 与旧 agent 相同
    outbound.routeStreamFrame('sess-qq', start('sess-qq:1'));
    outbound.routeStreamFrame('sess-qq', delta('sess-qq:1', 'fresh'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenNthCalledWith(2, 'fresh'); // 全量替换，无残留
  });

  it('迟到帧（旧 attemptId）被丢弃', async () => {
    const { outbound, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'x'));
    outbound.routeStreamFrame('sess-qq', start('a2'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'late')); // a1 的迟到帧
    await vi.advanceTimersByTimeAsync(200);

    expect(session.update).not.toHaveBeenCalledWith(expect.stringContaining('late'));
  });

  it('非 QQ 会话（无 record）忽略流式帧', async () => {
    const { outbound, bot } = setup({ record: undefined });

    outbound.routeStreamFrame('sess-web', start('a1'));
    outbound.routeStreamFrame('sess-web', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('群聊不流式：帧累积后由 assistant/message 静态发送', async () => {
    const { outbound, bot } = setup({ record: createRecord(groupTarget) });

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'group reply'));
    await vi.advanceTimersByTimeAsync(200);

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'group reply' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).toHaveBeenCalledWith(groupTarget, 'group reply');
  });

  it('assistant/message 到达时收尾流式：complete 且不重复静态发送', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeStreamFrame('sess-qq', start('a1'));
    outbound.routeStreamFrame('sess-qq', delta('a1', 'hello'));
    await vi.advanceTimersByTimeAsync(200);

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(session.complete).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('旧通道回归：durable assistant/chunk 事件仍进 buffer', async () => {
    const { outbound, bot, session } = setup();

    outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
      type: 'assistant/chunk',
      data: { chunk: { type: 'text-delta', text: 'legacy' } },
    });
    await vi.advanceTimersByTimeAsync(200);

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('legacy');
  });

  // ── 流式路径的记账回归 ──
  // 流式收尾走 OutboundBuffer.flush()，**不经过 send()**。
  // 曾经因此漏掉防复读流水：开了流式就静默失效，且没有任何报错。
  describe('流式路径的后续记账', () => {
    /** 走一遍「流式 → assistant/message 收尾」 */
    async function streamThenFinish(outbound: ReturnType<typeof setup>['outbound'], text: string) {
      outbound.routeStreamFrame('sess-qq', start('a1'));
      outbound.routeStreamFrame('sess-qq', delta('a1', text));
      await vi.advanceTimersByTimeAsync(200);
      outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text }] } },
      });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    }

    beforeEach(() => resetReplyHistory());

    it('流式收尾后记入防复读流水', async () => {
      const { outbound } = setup();
      await streamThenFinish(outbound, 'hello');
      expect(getReplyHistory().list('k')).toEqual(['hello']);
    });

    it('被模型沉默（[skip]）时**不**记入流水', async () => {
      const { outbound } = setup();
      await streamThenFinish(outbound, '[skip]');
      expect(getReplyHistory().list('k')).toEqual([]);
    });

    it('群聊流式被禁用，走静态发送也会记账', async () => {
      const { outbound, bot } = setup({ record: createRecord(groupTarget) });
      outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'group reply' }] } },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(bot.sendMarkdown).toHaveBeenCalledWith(groupTarget, 'group reply');
      expect(getReplyHistory().list('k')).toEqual(['group reply']);
    });
  });
});
