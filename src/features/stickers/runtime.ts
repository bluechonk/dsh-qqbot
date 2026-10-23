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

/** 取图库（惰性创建；enabled=false 时内部会返回空数组） */
export function getStickerCatalog(enabled: boolean): StickerCatalog {
  if (catalog === undefined) {
    catalog = new StickerCatalog({
      filePath: pluginDataPath('stickers.json'),
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
}

/**
 * 把图库里的相对路径解析成绝对路径。
 *
 * 素材统一放在 `~/.dsh-qqbot/stickers/` 下，`file` 字段写相对路径
 * （例如 `deepseek-chan/得意.png`），这样整个素材目录可以整体搬走。
 */
export function resolveStickerPath(file: string): string {
  return resolve(pluginDataPath('stickers'), file);
}
