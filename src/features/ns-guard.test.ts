/**
 * 实例命名空间守卫 — 单测
 *
 * 多实例时 settingsNs 重复会让两个实例互相覆盖配置与数据，
 * 而症状是**静默的**（本项目最贵的 bug 类别）。
 * 这里的断言就是「宁可拒绝启动，也不悄悄抢同一条路由」。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findDuplicateSettingsNs,
  normalizeSettingsNs,
  validateProfileSettingsNs,
} from './ns-guard.ts';
import { DEFAULT_SETTINGS_NS } from '../config.ts';

describe('normalizeSettingsNs', () => {
  it('缺省回落到 im-qqbot（单实例行为逐字不变）', () => {
    expect(normalizeSettingsNs(undefined)).toBe(DEFAULT_SETTINGS_NS);
    expect(DEFAULT_SETTINGS_NS).toBe('im-qqbot');
  });

  it('空串与纯空白都视为未设置', () => {
    expect(normalizeSettingsNs('')).toBe(DEFAULT_SETTINGS_NS);
    expect(normalizeSettingsNs('   ')).toBe(DEFAULT_SETTINGS_NS);
  });

  it('有值就 trim 后原样保留', () => {
    expect(normalizeSettingsNs('im-qqbot-2')).toBe('im-qqbot-2');
    expect(normalizeSettingsNs('  im-qqbot-2  ')).toBe('im-qqbot-2');
  });
});

describe('findDuplicateSettingsNs', () => {
  it('空列表与无重复都返回空', () => {
    expect(findDuplicateSettingsNs([])).toEqual([]);
    expect(findDuplicateSettingsNs(['im-qqbot', 'im-qqbot-2'])).toEqual([]);
  });

  it('找出重复项', () => {
    expect(findDuplicateSettingsNs(['a', 'a'])).toEqual(['a']);
    expect(findDuplicateSettingsNs(['a', 'b', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('三重重复只报一次', () => {
    expect(findDuplicateSettingsNs(['x', 'x', 'x'])).toEqual(['x']);
  });
});

describe('validateProfileSettingsNs', () => {
  function writePatch(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'nsguard-'));
    writeFileSync(join(dir, 'cordis.patch.yml'), content, 'utf8');
    return dir;
  }

  it('没有 profile 目录时通过（单实例/开发模式）', () => {
    expect(validateProfileSettingsNs(undefined)).toEqual({ ok: true, duplicates: [], total: 0 });
  });

  it('patch 文件不存在时通过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsguard-'));
    try {
      expect(validateProfileSettingsNs(dir)).toEqual({ ok: true, duplicates: [], total: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('只认 im-qqbot 开头的条目，不碰其他插件行', () => {
    const dir = writePatch(`- id: ui-chat
  name: '@deepseek-ai/dsh-client-ui-chat'
- id: im-qqbot
  config:
    appId: '1'
`);
    try {
      const result = validateProfileSettingsNs(dir);
      expect(result.ok).toBe(true);
      expect(result.total).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('两个实例用同一个 ns → 冲突', () => {
    const dir = writePatch(`- id: im-qqbot-1
  config:
    settingsNs: im-qqbot
- id: im-qqbot-2
  config:
    settingsNs: im-qqbot
`);
    try {
      const result = validateProfileSettingsNs(dir);
      expect(result.ok).toBe(false);
      expect(result.duplicates).toEqual(['im-qqbot']);
      expect(result.total).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未写 settingsNs 的实例回落到默认 ns，因此两个都缺省会冲突', () => {
    const dir = writePatch(`- id: im-qqbot-1
  config:
    appId: '1'
- id: im-qqbot-2
  config:
    appId: '2'
`);
    try {
      expect(validateProfileSettingsNs(dir).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ns 各不相同 → 通过', () => {
    const dir = writePatch(`- id: im-qqbot-1
  config:
    settingsNs: im-qqbot-1
- id: im-qqbot-2
  config:
    settingsNs: im-qqbot-2
`);
    try {
      const result = validateProfileSettingsNs(dir);
      expect(result.ok).toBe(true);
      expect(result.total).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('YAML 解析失败不抛异常，返回不通过', () => {
    const dir = writePatch('这不是: 合法的: YAML: 数组: [');
    try {
      const result = validateProfileSettingsNs(dir);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('顶层不是数组时通过（不是本插件的 patch 文件）', () => {
    const dir = writePatch('foo: bar\n');
    try {
      expect(validateProfileSettingsNs(dir).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
