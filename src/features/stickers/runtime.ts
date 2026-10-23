/**
 * 表情包 — 进程内运行时
 *
 * 图库与每个会话的发送状态（已发过几张文字、上次发了哪张）都放这里，
 * 单例避免 inbound/outbound 互相 import 造成环。
 */
import { resolve } from 'node:path';
import { pluginDataPath } from '../../shared/index.ts';
import { StickerCatalog } from './catalog.ts';
import type { StickerRuntimeState } from './select.ts';

let catalog: StickerCatalog | undefined;
/** sessionKey → 表情发送状态 */
const states = new Map<string, StickerRuntimeState>();

/**
 * 图库路径覆盖（仅供测试）。
 *
 * 生产路径固定在 `~/.dsh-qqbot/stickers.json`，写死的话整条表情流程
 * 在测试里只能走到「图库为空」，等于没有集成覆盖。
 */
let catalogPathOverride: string | undefined;
/** 素材根目录覆盖（仅供测试），配合 catalogPathOverride 一起用 */
let assetRootOverride: string | undefined;

/** 仅供测试：把图库与素材目录指向临时位置；传 undefined 恢复默认 */
export function setStickerPathsForTest(paths?: { catalogPath?: string; assetRoot?: string }): void {
  catalogPathOverride = paths?.catalogPath;
  assetRootOverride = paths?.assetRoot;
  catalog = undefined;
}

/** 取图库（惰性创建；enabled=false 时内部会返回空数组） */
export function getStickerCatalog(enabled: boolean): StickerCatalog {
  if (catalog === undefined) {
    catalog = new StickerCatalog({
      filePath: catalogPathOverride ?? pluginDataPath('stickers.json'),
      enabled,
    });
  }
  return catalog;
}

/** 取某会话的发送状态（惰性初始化：计数从 0 起，意味着要先攒够文字的条数） */
export function getStickerState(sessionKey: string): StickerRuntimeState {
  const existing = states.get(sessionKey);
  if (existing !== undefined) return existing;
  const fresh: StickerRuntimeState = { textRepliesSinceSticker: 0 };
  states.set(sessionKey, fresh);
  return fresh;
}

/** 回写某会话的发送状态 */
export function setStickerState(sessionKey: string, state: StickerRuntimeState): void {
  states.set(sessionKey, state);
}

/** 仅供测试重置 */
export function resetStickerRuntime(): void {
  catalog = undefined;
  states.clear();
  catalogPathOverride = undefined;
  assetRootOverride = undefined;
}

/**
 * 把图库里的相对路径解析成绝对路径。
 *
 * 素材统一放在 `~/.dsh-qqbot/stickers/` 下，`file` 字段写相对路径
 * （例如 `deepseek-chan/得意.png`），这样整个素材目录可以整体搬走。
 */
export function resolveStickerPath(file: string): string {
  return resolve(assetRootOverride ?? pluginDataPath('stickers'), file);
}
