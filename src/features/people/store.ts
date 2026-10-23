/**
 * 群友档案存储
 *
 * 落盘 `~/.dsh-qqbot/people.json`，按 `appId|会话范围|openid` 索引。
 *
 * 为什么按 (机器人, 群) 而不是只按 openid：
 * 同一个群可能被两个机器人加了，它们对群友的称呼与亲疏应当各自独立——
 * 它们是不同的「人」，用同一份档案会串味。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersonProfile } from './format.ts';
import { mergeFact, type PersonMemory } from './memory.ts';
import type { Logger } from '../../types.ts';

/** 档案文件结构 */
interface PeopleFile {
  version: 1;
  /** key = `${appId}|${scope}|${openid}` */
  people: Record<string, PersonProfile>;
}

/** 最多记多少人（超出后淘汰最久未见的），避免文件无限增长 */
const MAX_PEOPLE = 2000;
/** 两次落盘的最小间隔（ms）：不为每条消息都写盘 */
const WRITE_THROTTLE_MS = 5000;

export interface PeopleStoreOptions {
  /** 档案文件路径 */
  filePath: string;
  /** 是否启用（关闭则完全不读写） */
  enabled: boolean;
  /**
   * 日志（可选，但强烈建议给）。
   *
   * 读写失败**必须留痕**：档案是「学到的别名」这类不可再生数据，
   * 静默失败等于用户永远不知道自己的档案丢了。
   */
  logger?: Logger;
}

export class PeopleStore {
  private readonly filePath: string;
  private readonly enabled: boolean;
  private readonly logger: Logger | undefined;
  private data: PeopleFile | undefined;
  private dirty = false;
  private lastWrite = 0;

  constructor(options: PeopleStoreOptions) {
    this.filePath = options.filePath;
    this.enabled = options.enabled;
    this.logger = options.logger;
  }

  /**
   * 见到一个人：更新昵称、别名、次数与时间戳，返回最新档案。
   *
   * 每次收到消息都会调用，所以要便宜：只在内存改，写盘节流。
   */
  touch(params: {
    appId: string;
    scope: 'group' | 'c2c';
    /** 群聊用 groupOpenid；私聊传 'c2c' */
    scopeId: string;
    openid: string;
    name?: string;
    /** 从正文里抽出的别名（可选） */
    alias?: string;
  }): PersonProfile | undefined {
    if (!this.enabled) return undefined;
    const { appId, scope, scopeId, openid, name, alias } = params;
    if (!openid) return undefined;

    const file = this.load();
    const key = `${appId}|${scope}:${scopeId}|${openid}`;
    const now = Date.now();

    const existing = file.people[key];
    const profile: PersonProfile = existing ?? {
      openid,
      aliases: [],
      count: 0,
      firstSeen: now,
      lastSeen: now,
    };

    if (name && name !== profile.name) profile.name = name;
    if (alias && !profile.aliases.includes(alias)) {
      profile.aliases.push(alias);
      // 只留最近 5 个别名，多了没用还占地方
      if (profile.aliases.length > 5) profile.aliases = profile.aliases.slice(-5);
    }
    profile.count += 1;
    profile.lastSeen = now;

    file.people[key] = profile;
    this.dirty = true;
    this.evictIfNeeded(file);
    this.flush();
    return profile;
  }

  /** 读一个人的长期记忆（不产生写入） */
  memoryOf(params: {
    appId: string;
    scope: 'group' | 'c2c';
    scopeId: string;
    openid: string;
  }): PersonMemory | undefined {
    if (!this.enabled) return undefined;
    const file = this.load();
    return file.people[`${params.appId}|${params.scope}:${params.scopeId}|${params.openid}`]?.memory;
  }

  /**
   * 并入摘要产出的事实：逐条 mergeFact（去重 + 封顶），有真实变化才落盘。
   *
   * 返回三类计数，调用方据此留痕；档案不存在或未启用返回 undefined。
   * 全部被去重吸收（added + refreshed === 0）时不写盘——下一次摘要
   * 会重复消化同一段近期对话，由去重吸收，这正是不要 seq 断点的意义。
   */
  mergeMemoryFacts(
    params: {
      appId: string;
      scope: 'group' | 'c2c';
      scopeId: string;
      openid: string;
    },
    texts: readonly string[],
    maxFacts: number,
  ): { added: number; refreshed: number; skipped: number } | undefined {
    if (!this.enabled) return undefined;
    const key = `${params.appId}|${params.scope}:${params.scopeId}|${params.openid}`;
    const file = this.load();
    const profile = file.people[key];
    if (!profile) return undefined;

    const now = Date.now();
    let memory: PersonMemory = profile.memory ?? { version: 1, facts: [] };
    let added = 0;
    let refreshed = 0;
    let skipped = 0;
    for (const text of texts) {
      const r = mergeFact(memory, text, now, maxFacts);
      memory = r.memory;
      if (r.kind === 'added') added += 1;
      else if (r.kind === 'refreshed') refreshed += 1;
      else skipped += 1;
    }

    if (added + refreshed === 0) return { added, refreshed, skipped };

    profile.memory = { ...memory, version: 1, summarizedAt: now };
    this.dirty = true;
    this.evictIfNeeded(file);
    this.flush();
    return { added, refreshed, skipped };
  }

  /** 读一个人的档案（不产生写入） */
  get(params: {
    appId: string;
    scope: 'group' | 'c2c';
    scopeId: string;
    openid: string;
  }): PersonProfile | undefined {
    if (!this.enabled) return undefined;
    const file = this.load();
    return file.people[`${params.appId}|${params.scope}:${params.scopeId}|${params.openid}`];
  }

  /** 立即落盘（节流窗口内跳过；force 用于 dispose） */
  flush(force = false): void {
    if (!this.enabled || !this.dirty || this.data === undefined) return;
    const now = Date.now();
    if (!force && now - this.lastWrite < WRITE_THROTTLE_MS) return;

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.filePath);
      this.dirty = false;
      this.lastWrite = now;
    } catch (err) {
      // 写盘失败必须留痕：档案是「学到的别名」这类不可再生数据
      this.logger?.error(
        `im-qqbot: people.json write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 懒加载（首次访问读盘，损坏则保留原文件并从空档案重建） */
  private load(): PeopleFile {
    if (this.data !== undefined) return this.data;
    this.data = this.read();
    return this.data;
  }

  /**
   * 读盘。
   *
   * ⚠️ 解析失败时**把损坏文件改名保留**，而不是直接返回空档案。
   * 否则下一次 flush 会用空数据覆盖它，用户的档案永久消失——
   * 这是「静默数据丢失」最典型的一种。
   */
  private read(): PeopleFile {
    const empty: PeopleFile = { version: 1, people: {} };
    if (!existsSync(this.filePath)) return empty;

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<PeopleFile>;
      if (parsed.version !== 1 || typeof parsed.people !== 'object' || parsed.people === null) {
        this.quarantine('结构不符合预期');
        return empty;
      }
      return { version: 1, people: parsed.people };
    } catch (err) {
      this.quarantine(err instanceof Error ? err.message : String(err));
      return empty;
    }
  }

  /** 把读不动的档案改名留档，避免被后续写入覆盖 */
  private quarantine(reason: string): void {
    const backup = `${this.filePath}.corrupt`;
    try {
      renameSync(this.filePath, backup);
      this.logger?.error(
        `im-qqbot: people.json unreadable (${reason}); kept as ${backup}, starting fresh`,
      );
    } catch (err) {
      // 连改名都失败：至少把原因喊出来，别让人以为档案还在
      this.logger?.error(
        `im-qqbot: people.json unreadable (${reason}) and could not be kept: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 超过上限时按 lastSeen 淘汰最久未见的 */
  private evictIfNeeded(file: PeopleFile): void {
    const keys = Object.keys(file.people);
    if (keys.length <= MAX_PEOPLE) return;
    const sorted = keys.sort(
      (a, b) => (file.people[a]?.lastSeen ?? 0) - (file.people[b]?.lastSeen ?? 0),
    );
    for (const key of sorted.slice(0, keys.length - MAX_PEOPLE)) {
      delete file.people[key];
    }
  }
}
