/**
 * 中间件链留痕
 *
 * 为什么需要它：本项目最大的风险类别是**静默失效**——不报错、不掉线、
 * 测试全绿，只是功能悄悄不对。中间件链上每个关卡都能让一条消息「消失」：
 * 去重、访问控制、@ 门控、限流、并发合并……此前只有自主接话门控会记日志，
 * 其余关卡丢弃时**纹丝不动**，主人看到的是「消息发了但机器人没反应」。
 *
 * 修法：在链首挂一个**哨兵**中间件。洋葱模型下，下游任何 `ctx.stop()`
 * 都会让 `await next()` 正常返回，哨兵在 `finally` 里读 `ctx.stopReason`
 * 落盘——**一处捕获所有短路**，包括 SDK 没提供钩子的关卡（如 messageFilter 去重）。
 *
 * 并发合并（merge）是唯一的例外：被合并的消息**不 stop**，而是并入选定的
 * 幸存者 ctx，因此哨兵看不见。它由 `onMerge` 单独留痕。
 *
 * 落盘：`~/.dsh-qqbot/middleware-events.jsonl`（与 proactive-scores.jsonl 同目录）。
 *
 * 文件名是 `events` 而不是 `drops`：它记的**不只是丢弃**——命令被识别并处理
 * （`handled`）同样要留痕，否则「我发的命令没生效」这类问题分不清
 * 「没被识别」还是「识别了但没回复」。
 */
import { appendFileSync, mkdirSync, statSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

/** 一条留痕的类别 */
export type MiddlewareDropKind =
  /** 消息被丢掉，没有进 agent */
  | 'drop'
  /** 命令被执行了，但调用者没权限（安全审计用） */
  | 'denied'
  /** 并发合并：N 条消息并成 1 轮（内容不丢，但没有各自的回合） */
  | 'merge'
  /**
   * 命令被识别并处理了。
   *
   * 为什么值得记：排查「我发的命令没生效」时，第一步要分清
   * **命令没被识别**（退化成聊天 → 这里没有记录，看会话日志能看到它进了 agent）
   * 还是**识别了但没回复**（这里有一条 `handled`，问题在发送侧）。
   * 早期刻意不记 `command:matched`，结果这个区分做不了（实测踩过）。
   */
  | 'handled';

export interface MiddlewareDropEntry {
  ts: number;
  kind: MiddlewareDropKind;
  /** SDK 给的 stop 原因，或 merge 的固定标记 */
  reason: string;
  /** c2c / group */
  chatKind?: string;
  senderId?: string;
  /** 群 openid 或私聊对象 */
  targetId?: string;
  messageId?: string;
  /** merge：本批合并了几条 */
  count?: number;
  /** merge：本批的 messageId 列表 */
  ids?: string[];
}

export interface MiddlewareDropLogOptions {
  /** 日志文件路径 */
  filePath: string;
  /** 是否启用（关闭则完全不落盘） */
  enabled: boolean;
}

/** 日志体积上限（字节），超过后滚动 */
const MAX_BYTES = 1024 * 1024;
/** 滚动后保留行数 */
const KEEP_LINES = 500;

export class MiddlewareDropLog {
  private readonly filePath: string;
  private readonly enabled: boolean;

  constructor(options: MiddlewareDropLogOptions) {
    this.filePath = options.filePath;
    this.enabled = options.enabled;
  }

  /** 记一条留痕（失败不抛——留痕本身不能影响主流程） */
  record(entry: MiddlewareDropEntry): void {
    if (!this.enabled) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      this.maybeRoll();
    } catch {
      /* 留痕失败不影响主流程 */
    }
  }

  private maybeRoll(): void {
    try {
      if (statSync(this.filePath).size <= MAX_BYTES) return;
      const lines = readFileSync(this.filePath, 'utf8').split('\n').filter((l) => l.trim() !== '');
      if (lines.length <= KEEP_LINES) return;
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, `${lines.slice(-KEEP_LINES).join('\n')}\n`, 'utf8');
      renameSync(tmp, this.filePath);
    } catch {
      /* 滚动失败忽略 */
    }
  }
}

/**
 * 把 stop 原因归类。
 *
 * 返回 `undefined` 只表示「没有 stop」（链正常走完）。
 *
 * 四类的分法：
 *   - `command:matched:*` → `handled`（命令被识别并处理了，**不是**丢弃）
 *   - `command:unauthorized:*` / `command:scope-denied:*` → `denied`（越权，安全审计）
 *   - 其余一律 `drop`
 */
export function classifyStopReason(reason: string | undefined): MiddlewareDropKind | undefined {
  if (reason === undefined) return undefined;
  if (reason.startsWith('command:matched:')) return 'handled';
  if (reason.startsWith('command:unauthorized:') || reason.startsWith('command:scope-denied:')) {
    return 'denied';
  }
  return 'drop';
}

/** 从 ctx 提取留痕字段（缺失一律省略，不写 undefined） */
export function describeContext(ctx: MiddlewareContext): Pick<MiddlewareDropEntry, 'chatKind' | 'senderId' | 'targetId' | 'messageId'> {
  const msg = ctx.message;
  const out: Pick<MiddlewareDropEntry, 'chatKind' | 'senderId' | 'targetId' | 'messageId'> = {};
  if (msg.kind !== undefined) out.chatKind = msg.kind;
  if (msg.senderId !== undefined) out.senderId = msg.senderId;
  const targetId = ctx.replyTarget?.targetId;
  if (targetId !== undefined) out.targetId = targetId;
  if (msg.messageId !== undefined) out.messageId = msg.messageId;
  return out;
}

/**
 * 链首哨兵：捕获下游一切 `ctx.stop()`。
 *
 * 必须注册在链的**最前面**（errorHandler 之后即可）——只有这样，
 * 下游任何短路后 `await next()` 才会回到这里。
 */
export function chainSentinel(log: MiddlewareDropLog): Middleware {
  return async (ctx, next) => {
    try {
      await next();
    } finally {
      const kind = classifyStopReason(ctx.stopReason);
      if (kind === undefined) return;
      log.record({
        ts: Date.now(),
        kind,
        reason: ctx.stopReason ?? '<no-reason>',
        ...describeContext(ctx),
      });
    }
  };
}

/**
 * 并发合并留痕 + 合并本身。
 *
 * SDK 的 `defaultMerge` **没有导出**，只能镜像一份。改这里之前先看
 * `node_modules/@tencent-connect/qqbot-nodejs/src/middleware/concurrency-guard.ts`
 * 的 `defaultMerge`——合并语义变了要同步。
 *
 * 为什么要镜像：不传 `onMerge` 就拿不到「合并了几条」这个信息，
 * 而「发两条只回一条」正是靠它才能解释。
 */
export function mergeWithLog(log: MiddlewareDropLog, buffered: MiddlewareContext[]): MiddlewareContext {
  const first = buffered[0];
  if (first === undefined) {
    // 理论上不会发生（SDK 只在非空时调用），兜底避免抛错
    throw new Error('middleware-log: merge called with empty buffer');
  }

  if (buffered.length === 1) return first;

  log.record({
    ts: Date.now(),
    kind: 'merge',
    reason: 'concurrency:merge',
    count: buffered.length,
    ids: buffered.map((c) => c.message.messageId).filter((id): id is string => id !== undefined),
    ...describeContext(buffered[0]!),
  });

  // ── 以下为 SDK defaultMerge 的镜像 ──
  const contentBearing = buffered.filter((c) => (c.message.content ?? '') !== '');
  const contents = contentBearing.map((c) => c.message.content as string);
  if (contents.length > 0) first.message.content = contents.join('\n');

  const envelopes = contentBearing
    .map((c) => c.state.envelope as string | undefined)
    .filter((e): e is string => Boolean(e));
  if (envelopes.length > 0) first.state.envelope = envelopes.join('\n\n');

  const attachments = contentBearing.flatMap((c) => c.message.attachments ?? []);
  if (attachments.length > 0) first.message.attachments = attachments;

  return first;
}
