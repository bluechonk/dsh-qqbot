/**
 * 表情包 — 模块出口（M5）
 *
 * 与 docs 原设计的差异：原设计用 `send_sticker` 工具让模型选图，
 * 但 qqchat 是**零工具**预设，工具用不了。改为**插件自主配图**：
 * 拿到回复文本后推断情绪，按时机规则挑一张。
 *
 * 好处是更稳更便宜，也不会因为模型「忘了调工具」而永远发不出表情。
 */
export * from './mood.ts';
export * from './catalog.ts';
export * from './select.ts';
export {
  getStickerCatalog, getStickerState, setStickerState, resetStickerRuntime, resolveStickerPath,
} from './runtime.ts';
