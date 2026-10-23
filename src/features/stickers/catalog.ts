/**
 * 表情包 — 图库目录
 *
 * 落盘 `~/.dsh-qqbot/stickers.json`，**不随仓库分发任何图片素材**
 * （版权归原作者，见 README 的素材来源说明）。
 *
 * 条目结构对应 docs/拟人化路线图.md 的三层标签：
 *   L1 语义描述 ← 素材方写好的台词/desc（导入时直接读，零成本、质量最高）
 *   L2 场景标签 ← 情绪 + 场景 + 强度（人工批量指定）
 *   L3 检索向量 ← 本版未做（需要嵌入模型，先留字段）
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Mood } from './mood.ts';

/** 强度：轻/重（同一个情绪下区分力度） */
export type Strength = 'light' | 'heavy';

/** 一条表情包 */
export interface Sticker {
  /** 稳定 id（导入时生成，发送时用它定位文件） */
  id: string;
  /** 图片文件名（相对素材目录） */
  file: string;
  /** L1：台词/描述（素材自带的原文，最有价值） */
  text?: string;
  /** L2：情绪标签 */
  mood?: Mood;
  /** L2：场景标签（被夸 / 摸鱼 / 干饭 …） */
  scene?: string;
  /** L2：强度 */
  strength?: Strength;
  /** L3：检索向量（本版未用，留位） */
  vector?: readonly number[];
}

interface CatalogFile {
  version: 1;
  stickers: Sticker[];
}

export interface StickerCatalogOptions {
  filePath: string;
  enabled: boolean;
}

export class StickerCatalog {
  private readonly filePath: string;
  private readonly enabled: boolean;
  private data: CatalogFile | undefined;

  constructor(options: StickerCatalogOptions) {
    this.filePath = options.filePath;
    this.enabled = options.enabled;
  }

  /** 全部表情（图库为空时返回空数组，调用方据此跳过） */
  all(): readonly Sticker[] {
    if (!this.enabled) return [];
    return this.load().stickers;
  }

  /** 按 id 取一张 */
  get(id: string): Sticker | undefined {
    return this.all().find((s) => s.id === id);
  }

  /** 图库是否为空（为空时整个表情功能静默跳过） */
  isEmpty(): boolean {
    return this.all().length === 0;
  }

  /** 整体替换（导入向导用；本版无 UI，供手工编辑文件） */
  replace(stickers: readonly Sticker[]): void {
    if (!this.enabled) return;
    this.data = { version: 1, stickers: [...stickers] };
    this.save();
  }

  /** 懒加载：文件不存在或损坏都返回空图库，不让 IO 问题影响聊天 */
  private load(): CatalogFile {
    if (this.data !== undefined) return this.data;
    this.data = readCatalog(this.filePath);
    return this.data;
  }

  private save(): void {
    if (this.data === undefined) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.filePath);
    } catch {
      /* 写盘失败不影响聊天 */
    }
  }
}

/** 读目录文件；不存在/损坏/结构不对都退回空图库 */
function readCatalog(filePath: string): CatalogFile {
  const empty: CatalogFile = { version: 1, stickers: [] };
  if (!existsSync(filePath)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<CatalogFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.stickers)) return empty;
    // 过滤掉缺关键字段的条目，避免后面发送时才发现
    const stickers = parsed.stickers.filter(
      (s): s is Sticker =>
        typeof s === 'object' && s !== null
        && typeof (s as Sticker).id === 'string'
        && typeof (s as Sticker).file === 'string',
    );
    return { version: 1, stickers };
  } catch {
    return empty;
  }
}
