/**
 * preset 解析 —— 纯函数，便于单测
 *
 * 优先级：**用户偏好** > 插件配置 > 默认 qqchat
 *
 * 抽出来是因为这条链最容易写错：偏好是 per-peer 的（存在 model-prefs.json），
 * 配置是插件级的，两者都缺省时必须回落到 qqchat（QQ 聊天模式），
 * 不能回落到宿主默认 preset——那会带来全套工具，违背零工具设计。
 */
import { FIXED_PRESET_ID } from '../config.ts';

export function resolvePresetId(
  preference: string | undefined,
  configPreset: string | undefined,
  fallback: string = FIXED_PRESET_ID,
): string {
  if (preference !== undefined && preference !== '') return preference;
  if (configPreset !== undefined && configPreset !== '') return configPreset;
  return fallback;
}
