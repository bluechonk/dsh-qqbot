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
}

export class PeopleStore {
  private readonly filePath: string;
  private readonly enabled: boolean;
  private data: PeopleFile | undefined;
  private dirty = false;
  private lastWrite = 0;

  constructor(options: PeopleStoreOptions) {
    this.filePath = options.filePath;
    this.enabled = options.enabled;
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
    } catch {
      /* 写盘失败不影响聊天；下次还会尝试 */
    }
  }

  /** 懒加载（首次访问读盘，损坏则从空档案重建） */
  private load(): PeopleFile {
    if (this.data !== undefined) return this.data;
    this.data = readFile(this.filePath);
    return this.data;
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

/** 读取档案文件（不存在/损坏都返回空档案，不让 IO 问题影响聊天） */
function readFile(filePath: string): PeopleFile {
  const empty: PeopleFile = { version: 1, people: {} };
  if (!existsSync(filePath)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PeopleFile>;
    if (parsed.version !== 1 || typeof parsed.people !== 'object' || parsed.people === null) {
      return empty;
    }
    return { version: 1, people: parsed.people };
  } catch {
    return empty;
  }
}
