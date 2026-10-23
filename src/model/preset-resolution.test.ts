/**
 * preset 解析 — 单测
 *
 * 这条链是「零工具」设计的最后一道闸：回落错了就会给机器人挂上终端与文件工具。
 */
import { describe, expect, it } from 'vitest';
import { resolvePresetId } from './preset-resolution.ts';
import { FIXED_PRESET_ID } from '../config.ts';

describe('resolvePresetId', () => {
  it('用户偏好优先', () => {
    expect(resolvePresetId('standard', 'qqchat')).toBe('standard');
    expect(resolvePresetId('standard', undefined)).toBe('standard');
  });

  it('无偏好时用插件配置', () => {
    expect(resolvePresetId(undefined, 'work')).toBe('work');
  });

  it('两者都缺省时回落 qqchat（不是宿主默认）', () => {
    expect(resolvePresetId(undefined, undefined)).toBe(FIXED_PRESET_ID);
    expect(FIXED_PRESET_ID).toBe('qqchat');
  });

  it('空串视为未设置（配置里写空是常见的「不覆盖」写法）', () => {
    expect(resolvePresetId('', '')).toBe(FIXED_PRESET_ID);
    expect(resolvePresetId('', 'work')).toBe('work');
  });

  it('可用自定义回落值（测试与未来扩展）', () => {
    expect(resolvePresetId(undefined, undefined, 'fallback')).toBe('fallback');
  });
});
