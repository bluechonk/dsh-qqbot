import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutboundHandler } from './outbound.ts';
import type { QQBotSender, StreamSessionLike } from './outbound-buffer.ts';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import { getReplyHistory, resetReplyHistory } from '../features/anti-repeat/index.ts';
import {
  resetStickerRuntime,
  setStickerPathsForTest,
  setStickerState,
} from '../features/stickers/index.ts';

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
    // scope / peerId 必须给：blocked 恢复要靠它们定位会话（getOrCreate 里也会设）
    scope: target.scope,
    peerId: target.targetId,
    agent: {},
    handle: {},
    createdAt: 0,
    lastActivity: 0,
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

  // ── 表情包发送的集成覆盖 ──
  // 图库路径写死的话，整条表情流程在测试里只能走到「图库为空」，
  // 等于没有覆盖。这里用临时图库真正跑一遍。
  describe('表情包发送', () => {
    const dirs: string[] = [];

    /** 建一个含一张「得意」图的临时图库，返回 catalog 路径 */
    function tempCatalog(): string {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-sticker-'));
      dirs.push(dir);
      const catalogPath = join(dir, 'stickers.json');
      writeFileSync(catalogPath, JSON.stringify({
        version: 1,
        stickers: [{ id: 's1', file: 'a.png', mood: '得意', strength: 'light' }],
      }), 'utf8');
      return catalogPath;
    }

    /** 造一个能收图的 bot（带 sendImage） */
    function setupWithStickers(record: SessionRecord) {
      const session = createSession();
      const bot = { ...createBot(session), sendImage: vi.fn().mockResolvedValue(undefined) };
      const manager = {
        findBySessionId: vi.fn((id: string) => (id === 'sess-qq' ? record : undefined)),
      } as unknown as SessionManager;
      const config = createConfig({
        stickers: { enabled: true, maxTextReplies: 1, cooldownMs: 0 },
      });
      const outbound = createOutboundHandler(
        manager, bot as unknown as QQBotSender, config, createLogger(),
      );
      return { outbound, bot };
    }

    beforeEach(() => {
      resetStickerRuntime();
      // 先攒够「连续文字条数」：count 从 0 起，阈值 1 → 发一条文字后就该配图
      setStickerState('k', { textRepliesSinceSticker: 1 });
    });

    afterEach(() => {
      resetStickerRuntime();
      while (dirs.length > 0) {
        const dir = dirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    });

    it('有 msgId 时发送表情（mood 命中「得意」）', async () => {
      setStickerPathsForTest({ catalogPath: tempCatalog(), assetRoot: 'C:/tmp' });
      const { outbound, bot } = setupWithStickers(createRecord(groupTarget));

      outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '废话，我本来就厉害' }] } },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(bot.sendImage).toHaveBeenCalledTimes(1);
      const [target, source] = bot.sendImage!.mock.calls[0]!;
      expect(target).toBe(groupTarget);
      expect((source as { localPath: string }).localPath).toContain('a.png');
    });

    // ⚠️ SDK 的 sendMediaMessage 只透传 msg_id，完全忽略 eventId。
    // 没有 msgId 就发图 = 变成主动消息，浪费配额且大概率失败。
    it('没有 msgId（event 型回复目标）时**不发图**，文字照发', async () => {
      setStickerPathsForTest({ catalogPath: tempCatalog(), assetRoot: 'C:/tmp' });
      const eventTarget: ReplyTarget = { scope: 'group', targetId: 'group1', msgId: undefined };
      const { outbound, bot } = setupWithStickers(createRecord(eventTarget));

      outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '废话，我本来就厉害' }] } },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(bot.sendImage).not.toHaveBeenCalled();
      expect(bot.sendMarkdown).toHaveBeenCalledWith(eventTarget, '废话，我本来就厉害');
    });

    it('图库为空时不发图（功能默认关闭的等价状态）', async () => {
      setStickerPathsForTest({ catalogPath: join(tmpdir(), 'nope-not-exist.json') });
      const { outbound, bot } = setupWithStickers(createRecord(groupTarget));

      outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '废话，我本来就厉害' }] } },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(bot.sendImage).not.toHaveBeenCalled();
    });
  });

  // ── blocked 轮次的自动恢复 ──
  // 真实案例：某群会话连续 8 轮 turn/end{blocked}，模型完全不被调用，
  // 机器人彻底哑掉且没有任何报错——最难发现的一类故障。
  describe('blocked 轮次的自动恢复', () => {
    /** 造一个能记录 remove 调用的 manager */
    function setupWithRemove() {
      const session = createSession();
      const bot = createBot(session);
      const record = createRecord(groupTarget);
      const remove = vi.fn().mockResolvedValue(undefined);
      const manager = {
        findBySessionId: vi.fn((id: string) => (id === 'sess-qq' ? record : undefined)),
        remove,
      } as unknown as SessionManager;
      const outbound = createOutboundHandler(
        manager, bot, createConfig({ streaming: false }), createLogger(),
      );
      return { outbound, remove };
    }

    const turnEnd = (reason: unknown) => ({
      type: 'turn/end',
      data: { reason },
    });

    it('blocked → 丢弃会话，让下一条消息重建', async () => {
      const { outbound, remove } = setupWithRemove();
      outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd({ kind: 'blocked' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(remove).toHaveBeenCalledWith('group', 'group1');
    });

    it('completed / error 不触发丢弃', async () => {
      const { outbound, remove } = setupWithRemove();
      outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd({ kind: 'completed' }));
      outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd({
        kind: 'error', error: { code: 'SOME_ERROR', message: 'x' },
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(remove).not.toHaveBeenCalled();
    });

    it('反复 blocked 时有频率上限，避免重建抖动', async () => {
      const { outbound, remove } = setupWithRemove();
      for (let i = 0; i < 10; i++) {
        outbound.routeSessionEvent({ header: { id: 'sess-qq' } }, turnEnd({ kind: 'blocked' }));
      }
      await vi.advanceTimersByTimeAsync(0);
      // 上限 5 次；超出后只记日志不再重建
      expect(remove).toHaveBeenCalledTimes(5);
    });
  });
});
