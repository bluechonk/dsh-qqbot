/**
 * 实例注册表 — 单测
 *
 * 锁住四件事：列表只认 im-qqbot 条目 / appId 脱敏 / 新增不覆盖已有 /
 * 默认实例不可删。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addInstance,
  listInstances,
  nextInstanceId,
  profilePatchPath,
  removeInstance,
  setInstanceEnabled,
} from './instance-registry.ts';

function tempPatch(content = ''): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'instreg-'));
  const file = join(dir, 'cordis.patch.yml');
  if (content) writeFileSync(file, content, 'utf8');
  return { dir, file };
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe('listInstances', () => {
  it('只认 im-qqbot 开头的条目', () => {
    const { file, dir } = tempPatch(`- id: ui-chat
  name: '@deepseek-ai/dsh-client-ui-chat'
- id: im-qqbot
  config:
    appId: '1905526094'
- id: im-qqbot-2
  config:
    enabled: false
`);
    try {
      const list = listInstances(file);
      expect(list.map((i) => i.id)).toEqual(['im-qqbot', 'im-qqbot-2']);
    } finally {
      cleanup(dir);
    }
  });

  it('appId 脱敏，且能看出有没有绑定', () => {
    const { file, dir } = tempPatch(`- id: im-qqbot
  config:
    appId: '1905526094'
- id: im-qqbot-2
  config:
    enabled: true
`);
    try {
      const [a, b] = listInstances(file);
      expect(a?.appId).toBe('1905***');
      expect(a?.bound).toBe(true);
      expect(b?.appId).toBe('');
      expect(b?.bound).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('enabled 缺省视为 true，显式 false 才停用', () => {
    const { file, dir } = tempPatch(`- id: im-qqbot
  config:
    appId: '1'
- id: im-qqbot-2
  config:
    enabled: false
`);
    try {
      const [a, b] = listInstances(file);
      expect(a?.enabled).toBe(true);
      expect(b?.enabled).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('文件不存在时返回空列表（不抛）', () => {
    const { dir } = tempPatch('');
    try {
      expect(listInstances(join(dir, 'cordis.patch.yml'))).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it('读回写入的 patch 仍是合法 YAML', () => {
    const { file, dir } = tempPatch(`- id: im-qqbot
  config:
    appId: '1'
`);
    try {
      addInstance(file, '工作号');
      const raw = readFileSync(file, 'utf8');
      expect(raw).toContain('im-qqbot-2');
      expect(listInstances(file)).toHaveLength(2);
    } finally {
      cleanup(dir);
    }
  });
});

describe('nextInstanceId', () => {
  it('从 im-qqbot-2 起，跳过已占用的', () => {
    expect(nextInstanceId([])).toBe('im-qqbot-2');
    expect(nextInstanceId(['im-qqbot', 'im-qqbot-2'])).toBe('im-qqbot-3');
    expect(nextInstanceId(['im-qqbot-3'])).toBe('im-qqbot-2');
  });
});

describe('addInstance / removeInstance / setInstanceEnabled', () => {
  it('新增实例并带显示名', () => {
    const { file, dir } = tempPatch(`- id: im-qqbot
  config:
    appId: '1'
`);
    try {
      expect(addInstance(file, '工作号')).toBe('im-qqbot-2');
      const added = listInstances(file).find((i) => i.id === 'im-qqbot-2');
      expect(added?.botName).toBe('工作号');
      expect(added?.enabled).toBe(true);
      expect(added?.bound).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('删除非默认实例成功，默认实例不可删', () => {
    const { file, dir } = tempPatch(`- id: im-qqbot
  config:
    appId: '1'
- id: im-qqbot-2
  config:
    enabled: true
`);
    try {
      expect(removeInstance(file, 'im-qqbot')).toBe(false);
      expect(listInstances(file)).toHaveLength(2);
      expect(removeInstance(file, 'im-qqbot-2')).toBe(true);
      expect(listInstances(file).map((i) => i.id)).toEqual(['im-qqbot']);
    } finally {
      cleanup(dir);
    }
  });

  it('删除不存在的实例返回 false', () => {
    const { file, dir } = tempPatch(`- id: im-qqbot
  config:
    appId: '1'
`);
    try {
      expect(removeInstance(file, 'im-qqbot-9')).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('启停写入 enabled 字段', () => {
    const { file, dir } = tempPatch(`- id: im-qqbot-2
  config:
    enabled: true
`);
    try {
      expect(setInstanceEnabled(file, 'im-qqbot-2', false)).toBe(true);
      expect(listInstances(file)[0]?.enabled).toBe(false);
      expect(setInstanceEnabled(file, 'im-qqbot-9', false)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('profilePatchPath 指向 profile 目录下的 cordis.patch.yml', () => {
    expect(profilePatchPath('/tmp/p')).toContain('cordis.patch.yml');
  });
});
