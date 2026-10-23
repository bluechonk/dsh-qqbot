/**
 * 记忆触发器 — 把「每 N 轮对话 → 异步摘要 → 并入档案」串起来。
 *
 * 设计（docs/群友档案.md 第四、六、十五节）：
 *   - 每个档案 key 维护一个**滚动对话缓冲**（他说的话 + 机器人的回复），
 *     满 N 轮触发一次摘要。缓冲是纯内存的，进程重启即清空——
 *     但事实早已写入 people.json，损失的只是「距上次摘要的几轮对话」，
 *     而且这层缓冲与 session 生命周期彻底解耦：/new、回收、重建都不影响它
 *   - 机器人的回复按「该 peer 最近一个发言人」归属（群聊里回复发给全群，
 *     精确归属做不到，这个近似对摘要足够）
 *   - 同一个 key 同时只允许一个摘要任务在跑（并发守卫）；失败只 warn 留痕
 *
 * 触发时机的取舍：初版设计的四个触发点里，「回收前 / /new」在缓冲方案下
 * 不再必要——缓冲不在 session 里，回收与重建动不到它；真正需要兜底的只有
 * 关闭时的 flush(true)（bootstrap 已有）。少两个触发点，少两条接线。
 */
import type { Logger } from '../../types.ts';
import type { ChatScope } from '../../types.ts';
import { buildSummaryPrompt, summarizeFacts, type LlmRuntimeLike, type SummaryModelOptions } from './summarizer.ts';
import type { PeopleStore } from './store.ts';

/** 每条消息在缓冲里的长度上限（防爆 token） */
const MAX_TURN_CHARS = 200;
/** 缓冲里最多保留多少行 */
const MAX_BUFFER_LINES = 40;

export interface MemoryTriggerOptions {
  appId: string;
  /** 摘要模型；provider/model 为空则整个触发器不生效（构造时 warn 一次） */
  model: SummaryModelOptions;
  summarizeEveryTurns: number;
  maxFacts: number;
  maxInputChars: number;
  logger: Logger;
}

/** 一次入站轮次 */
export interface TurnInput {
  scope: ChatScope;
  /** 群聊传群 openid，私聊传 'c2c' */
  scopeId: string;
  /** 发言人 openid */
  openid: string;
  /** 消息正文（空的轮次不计） */
  text: string;
}

/** 一次出站回复（归属到该 peer 最近的发言人） */
export interface ReplyInput {
  scope: ChatScope;
  scopeId: string;
  text: string;
}

interface KeyState {
  turns: number;
  buffer: string[];
}

/** 档案 key：与 store 的索引完全一致 */
function personKey(appId: string, scope: ChatScope, scopeId: string, openid: string): string {
  return `${appId}|${scope}:${scopeId}|${openid}`;
}

/** peer key：区分「同一个人」与「同一个会话」 */
function peerKey(appId: string, scope: ChatScope, scopeId: string): string {
  return `${appId}|${scope}:${scopeId}`;
}

export class MemoryTrigger {
  private readonly states = new Map<string, KeyState>();
  private readonly lastSender = new Map<string, string>();
  private readonly busy = new Set<string>();
  private readonly logger: Logger;
  private readonly appId: string;
  private readonly model: SummaryModelOptions;
  private readonly summarizeEveryTurns: number;
  private readonly maxFacts: number;
  private readonly maxInputChars: number;
  private readonly llm: LlmRuntimeLike | undefined;

  constructor(options: MemoryTriggerOptions, llm: LlmRuntimeLike | undefined, private readonly store: PeopleStore) {
    this.logger = options.logger;
    this.appId = options.appId;
    this.model = options.model;
    this.summarizeEveryTurns = options.summarizeEveryTurns;
    this.maxFacts = options.maxFacts;
    this.maxInputChars = options.maxInputChars;
    this.llm = llm;

    if (!llm?.stream) {
      this.logger.warn('im-qqbot: llm 服务不可用，长期记忆摘要不会执行（档案与注入不受影响）');
    } else if (!options.model.provider || !options.model.model) {
      this.logger.warn('im-qqbot: people.memory.provider/model 未配置，长期记忆摘要不会执行');
    }
  }

  /** 摘要是否真的能跑（供接线方决定要不要调 recordTurn，避免白计数） */
  get usable(): boolean {
    return Boolean(this.llm?.stream) && Boolean(this.model.provider && this.model.model);
  }

  /** 记一轮对话；每满 N 轮异步触发一次摘要（fire-and-forget，不阻塞回复） */
  recordTurn(input: TurnInput): void {
    if (!this.usable) return;
    const text = input.text.trim();
    if (text === '') return;

    const pk = peerKey(this.appId, input.scope, input.scopeId);
    this.lastSender.set(pk, input.openid);

    const key = personKey(this.appId, input.scope, input.scopeId, input.openid);
    const state = this.states.get(key) ?? { turns: 0, buffer: [] };
    state.turns += 1;
    state.buffer.push(`他说：${text.slice(0, MAX_TURN_CHARS)}`);
    if (state.buffer.length > MAX_BUFFER_LINES) state.buffer.splice(0, state.buffer.length - MAX_BUFFER_LINES);
    this.states.set(key, state);

    if (state.turns % this.summarizeEveryTurns !== 0) return;
    state.turns = 0;
    void this.run(key, input.scope, input.scopeId, input.openid);
  }

  /** 记一条机器人的回复，归属到该 peer 最近的发言人 */
  recordReply(input: ReplyInput): void {
    if (!this.usable) return;
    const text = input.text.trim();
    if (text === '') return;

    const pk = peerKey(this.appId, input.scope, input.scopeId);
    const openid = this.lastSender.get(pk);
    if (openid === undefined) return;

    const key = personKey(this.appId, input.scope, input.scopeId, openid);
    const state = this.states.get(key);
    // 缓冲为空说明上次摘要刚清空过，这条回复没有可归属的上下文
    if (state === undefined || state.buffer.length === 0) return;
    state.buffer.push(`机器人回：${text.slice(0, MAX_TURN_CHARS)}`);
  }

  /**
   * 执行一次摘要：缓冲 → 提示词 → 摘要模型 → 解析 → 并入档案。
   * 任何失败只 warn 留痕，绝不影响正常对话。
   */
  private async run(key: string, scope: ChatScope, scopeId: string, openid: string): Promise<void> {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const state = this.states.get(key);
      if (state === undefined || state.buffer.length === 0) return;

      const params = { appId: this.appId, scope, scopeId, openid };
      const known = this.store.memoryOf(params)?.facts.map((f) => f.text) ?? [];
      const prompt = buildSummaryPrompt(this.clip(state.buffer), known);

      const facts = await summarizeFacts(this.llm!, this.model, prompt, new AbortController().signal);
      if (facts === undefined) {
        this.logger.warn(`im-qqbot: memory summary discarded (unparseable output) for ${key}`);
        return;
      }
      if (facts.length === 0) {
        this.logger.info(`im-qqbot: memory summary found nothing new for ${key}`);
        state.buffer = [];
        return;
      }

      const r = this.store.mergeMemoryFacts(params, facts, this.maxFacts);
      if (r === undefined) {
        this.logger.warn(`im-qqbot: memory summary merge skipped (no profile) for ${key}`);
        return;
      }
      this.logger.info(
        `im-qqbot: memory summary merged for ${key}: `
        + `added=${r.added} refreshed=${r.refreshed} skipped=${r.skipped}`,
      );
      state.buffer = []; // 已并入档案，清空缓冲避免重复消化
    } catch (err) {
      this.logger.warn(
        `im-qqbot: memory summary failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.busy.delete(key);
    }
  }

  /** 缓冲拼接成转写文本，超长取最近的（断在行边界，避免切出半行） */
  private clip(buffer: readonly string[]): string {
    const joined = buffer.join('\n');
    if (joined.length <= this.maxInputChars) return joined;
    const tail = joined.slice(joined.length - this.maxInputChars);
    const br = tail.indexOf('\n');
    return br >= 0 ? tail.slice(br + 1) : tail;
  }
}
