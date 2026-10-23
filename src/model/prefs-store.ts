/**
 * PrefsStore — per-peer 会话偏好持久化（模型 + preset）
 *
 * 隔离文件 I/O 操作，便于单元测试时 mock。
 * 存储路径：~/.dsh-qqbot/model-prefs.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { ModelRoute } from './types.ts';

/** 日志回调（可选） */
type DebugFn = (msg: string) => void;

/** 隔离偏好文件结构 */
interface PrefsFile {
  overrides: Record<string, ModelRoute>;
  /** sessionKey → 最新 sessionId（重建会话后更新，用于重启后恢复到重建后的会话） */
  sessionIds: Record<string, string>;
  /** sessionKey → 用户选的 preset（per-peer 偏好，恢复它原本的语义） */
  presets: Record<string, string>;
  /**
   * sessionKey → 会话**实际创建时**用的 preset。
   *
   * 必须与 `presets` 分开：两者混用会导致「刚切换完就被自己的一致性检测丢掉」
   * ——切换写的是偏好，而一致性检测要拿「会话真实跑的」来比。
   */
  sessionPresets: Record<string, string>;
}

export class PrefsStore {
  /** per-peer 模型偏好（内存态） */
  private overrides = new Map<string, ModelRoute>();
  /** per-peer 最新 sessionId（重建会话后更新，内存态） */
  private sessionIds = new Map<string, string>();
  /** per-peer preset 偏好（内存态） */
  private presets = new Map<string, string>();
  /** 会话实际创建时用的 preset（内存态） */
  private sessionPresets = new Map<string, string>();
  /** 隔离偏好文件路径 */
  private readonly prefsPath: string;
  private readonly debugLog?: DebugFn;

  /**
   * @param debugLog 调试日志回调
   * @param prefsPath 偏好文件路径（仅测试注入用；默认 ~/.dsh-qqbot/model-prefs.json）
   */
  constructor(debugLog?: DebugFn, prefsPath?: string) {
    this.prefsPath = prefsPath ?? resolve(homedir(), '.dsh-qqbot', 'model-prefs.json');
    this.debugLog = debugLog;
    this.load();
  }

  // ── Override 操作 ──

  getOverride(sessionKey: string): ModelRoute | undefined {
    return this.overrides.get(sessionKey);
  }

  setOverride(sessionKey: string, route: ModelRoute): void {
    this.overrides.set(sessionKey, route);
    this.write();
  }

  clearOverride(sessionKey: string): boolean {
    const deleted = this.overrides.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  hasOverride(sessionKey: string): boolean {
    return this.overrides.has(sessionKey);
  }

  // ── SessionId 操作 ──

  getSessionId(sessionKey: string): string | undefined {
    return this.sessionIds.get(sessionKey);
  }

  setSessionId(sessionKey: string, sessionId: string): void {
    this.sessionIds.set(sessionKey, sessionId);
    this.write();
  }

  clearSessionId(sessionKey: string): boolean {
    const deleted = this.sessionIds.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  // ── Preset 操作 ──

  getPreset(sessionKey: string): string | undefined {
    return this.presets.get(sessionKey);
  }

  setPreset(sessionKey: string, presetId: string): void {
    this.presets.set(sessionKey, presetId);
    this.write();
  }

  clearPreset(sessionKey: string): boolean {
    const deleted = this.presets.delete(sessionKey);
    if (deleted) this.write();
    return deleted;
  }

  // ── 会话实际 preset 操作（一致性检测用） ──

  /** 会话**实际创建时**用的 preset */
  getSessionPreset(sessionKey: string): string | undefined {
    return this.sessionPresets.get(sessionKey);
  }

  /** 记录会话实际用的 preset 并持久化 */
  setSessionPreset(sessionKey: string, presetId: string): void {
    this.sessionPresets.set(sessionKey, presetId);
    this.write();
  }

  // ── 私有方法 ──

  private load(): void {
    try {
      if (!existsSync(this.prefsPath)) return;
      const content = readFileSync(this.prefsPath, 'utf8');
      const data = JSON.parse(content) as PrefsFile;
      if (data.overrides && typeof data.overrides === 'object') {
        for (const [key, route] of Object.entries(data.overrides)) {
          if (route.provider && route.model) {
            this.overrides.set(key, { provider: route.provider, model: route.model });
          }
        }
      }
      if (data.sessionIds && typeof data.sessionIds === 'object') {
        for (const [key, sessionId] of Object.entries(data.sessionIds)) {
          if (typeof sessionId === 'string' && sessionId) {
            this.sessionIds.set(key, sessionId);
          }
        }
      }
      if (data.presets && typeof data.presets === 'object') {
        for (const [key, presetId] of Object.entries(data.presets)) {
          if (typeof presetId === 'string' && presetId) {
            this.presets.set(key, presetId);
          }
        }
      }
      // 旧版本没有这个字段：缺失时回落到 presets（老数据里两者本来就是同一个）
      const sessionPresetSource = data.sessionPresets ?? data.presets;
      if (sessionPresetSource && typeof sessionPresetSource === 'object') {
        for (const [key, presetId] of Object.entries(sessionPresetSource)) {
          if (typeof presetId === 'string' && presetId) {
            this.sessionPresets.set(key, presetId);
          }
        }
      }
    } catch (err) {
      this.debugLog?.(`loadPrefs failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.prefsPath), { recursive: true });
      const data: PrefsFile = {
        overrides: Object.fromEntries(this.overrides.entries()),
        sessionIds: Object.fromEntries(this.sessionIds.entries()),
        presets: Object.fromEntries(this.presets.entries()),
        sessionPresets: Object.fromEntries(this.sessionPresets.entries()),
      };
      writeFileSync(this.prefsPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      this.debugLog?.(`writePrefs failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
