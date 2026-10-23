/**
 * PrefsStore — preset 两份语义的单测
 *
 * 核心是「用户偏好」与「会话实际用的 preset」必须分开：
 * 混用会导致「刚切换完就被自己的一致性检测丢掉」。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrefsStore } from './prefs-store.ts';

const KEY = 'qqbot:app:group:G1';

function tempStore(): { store: PrefsStore; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prefs-'));
  const file = join(dir, 'model-prefs.json');
  return { dir, file, store: new PrefsStore(undefined, file) };
}

function writePrefs(file: string, data: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(data), 'utf8');
}

describe('PrefsStore preset 语义', () => {
  it('偏好与实际 preset 互不影响', () => {
    const { store } = tempStore();
    store.setPreset(KEY, 'standard');
    expect(store.getPreset(KEY)).toBe('standard');
    // 只写偏好，不该污染「会话实际用的」
    expect(store.getSessionPreset(KEY)).toBeUndefined();

    store.setSessionPreset(KEY, 'qqchat');
    expect(store.getSessionPreset(KEY)).toBe('qqchat');
    // 反向也不受影响
    expect(store.getPreset(KEY)).toBe('standard');
  });

  it('两者都持久化', () => {
    const { store, file } = tempStore();
    store.setPreset(KEY, 'standard');
    store.setSessionPreset(KEY, 'qqchat');

    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      presets: Record<string, string>;
      sessionPresets: Record<string, string>;
    };
    expect(data.presets[KEY]).toBe('standard');
    expect(data.sessionPresets[KEY]).toBe('qqchat');
  });

  it('旧数据（无 sessionPresets 字段）回落到 presets', () => {
    const { store, file } = tempStore();
    writePrefs(file, { overrides: {}, sessionIds: {}, presets: { [KEY]: 'qqchat' } });
    const reloaded = new PrefsStore(undefined, file);
    expect(reloaded.getSessionPreset(KEY)).toBe('qqchat');
  });

  it('clearPreset 只清偏好，不动实际值', () => {
    const { store } = tempStore();
    store.setPreset(KEY, 'standard');
    store.setSessionPreset(KEY, 'standard');
    expect(store.clearPreset(KEY)).toBe(true);
    expect(store.getPreset(KEY)).toBeUndefined();
    expect(store.getSessionPreset(KEY)).toBe('standard');
  });

  it('文件损坏时静默降级为空（不抛）', () => {
    const { store, file } = tempStore();
    writePrefs(file, { presets: 'not-an-object' });
    const reloaded = new PrefsStore(undefined, file);
    expect(reloaded.getPreset(KEY)).toBeUndefined();
    expect(reloaded.getSessionPreset(KEY)).toBeUndefined();
    expect(() => store.setPreset(KEY, 'x')).not.toThrow();
  });
});

// 用例一律用 mkdtempSync 自建临时目录，不碰真实 ~/.dsh-qqbot
void rmSync;
