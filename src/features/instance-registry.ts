/**
 * 实例注册表 — profile patch 里所有 im-qqbot 实例的读取与增删
 *
 * 多机器人时页面需要知道「有几个实例、各自什么状态」，
 * 增删启停也要落到 patch 上（宿主 HMR 靠文件变化触发重载）。
 *
 * 本模块只做**纯 patch 操作**（读 / 写 cordis.patch.yml），
 * 不碰 HTTP，便于单测。路由层负责把结果序列化成 JSON。
 *
 * 约定：patch 条目的 `id` **就是** `settingsNs`（`im-qqbot` / `im-qqbot-1` …），
 * 所以「找实例」= 「找 id 以 im-qqbot 开头的条目」。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';

import { DEFAULT_SETTINGS_NS } from '../config.ts';

/** 本插件在 profile patch 里的名字（cordis 靠它决定加载哪个插件） */
export const PLUGIN_PATCH_NAME = '@bluechonk/dsh-qqbot';

/** patch 条目的最小结构 */
interface PatchEntry {
  id?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 一个实例的对外视图（不含 appSecret） */
export interface InstanceInfo {
  /** patch 条目 id，等于 settingsNs */
  id: string;
  /** 实例命名空间（与 id 相同，单独给出便于前端理解） */
  settingsNs: string;
  /** 显示名（未配置时为空） */
  botName?: string;
  /** 是否启用 */
  enabled: boolean;
  /** 是否已绑定凭据 */
  bound: boolean;
  /** 脱敏 appId（未绑定为空串） */
  appId: string;
}

/** 解析 patch 为条目数组（与 persist.ts 同策略：失败抛错，由调用方保留原文件） */
function parseEntries(content: string): PatchEntry[] {
  if (!content.trim()) return [];
  const parsed = yaml.load(content);
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) throw new Error('cordis.patch.yml 顶层必须是 YAML 数组');
  const entries = parsed.filter(
    (e): e is PatchEntry =>
      typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).id === 'string',
  );
  if (parsed.length > 0 && entries.length === 0) {
    throw new Error('cordis.patch.yml 含条目但无带 id 的 patch 行');
  }
  return entries;
}

/** 读取条目（文件不存在返回空数组） */
function readEntries(patchPath: string): PatchEntry[] {
  if (!existsSync(patchPath)) return [];
  return parseEntries(readFileSync(patchPath, 'utf8'));
}

/** 写回条目（保证合法 YAML；目录不存在时创建） */
function writeEntries(patchPath: string, entries: PatchEntry[]): void {
  mkdirSync(dirname(patchPath), { recursive: true });
  writeFileSync(patchPath, yaml.dump(entries), 'utf8');
}

/** 脱敏 appId：只留前 4 位 */
function maskAppId(appId: unknown): string {
  return typeof appId === 'string' && appId ? `${appId.slice(0, 4)}***` : '';
}

/** 是否为本插件的实例条目 */
function isInstanceEntry(id: string): boolean {
  return id === DEFAULT_SETTINGS_NS || id.startsWith(`${DEFAULT_SETTINGS_NS}-`);
}

/**
 * 列出所有实例。
 *
 * 只认 `im-qqbot` 开头的条目，不碰 profile 里其他插件行。
 */
export function listInstances(patchPath: string): InstanceInfo[] {
  return readEntries(patchPath)
    .filter((e) => typeof e.id === 'string' && isInstanceEntry(e.id))
    .map((e) => {
      const config = e.config ?? {};
      return {
        id: e.id as string,
        settingsNs: e.id as string,
        botName: typeof config.botName === 'string' ? config.botName : undefined,
        enabled: config.enabled !== false,
        bound: typeof config.appId === 'string' && config.appId.length > 0,
        appId: maskAppId(config.appId),
      };
    });
}

/** 生成下一个可用的实例 id（`im-qqbot-2` / `im-qqbot-3` …） */
export function nextInstanceId(existing: readonly string[]): string {
  let n = 2;
  while (existing.includes(`${DEFAULT_SETTINGS_NS}-${n}`)) n += 1;
  return `${DEFAULT_SETTINGS_NS}-${n}`;
}

/**
 * 新增实例（只加 patch 行，不写凭据）。
 *
 * 返回新实例 id；id 已存在时返回 null（调用方提示冲突）。
 *
 * ⚠️ config 里必须写 `settingsNs: id`：ns 守卫读的是 `config.settingsNs`
 * （空值回落到默认 `im-qqbot`），漏写会让新实例与默认实例**同名冲突**，
 * 整个插件拒绝启动、所有路由 404（实测踩过）。
 */
export function addInstance(patchPath: string, botName?: string): string | null {
  const entries = readEntries(patchPath);
  const ids = entries.map((e) => e.id as string);
  const id = nextInstanceId(ids);
  if (ids.includes(id)) return null;
  entries.push({
    id,
    // cordis 靠 name 决定加载哪个插件——漏写这行，新实例根本不会被实例化
    name: PLUGIN_PATCH_NAME,
    config: {
      enabled: true,
      settingsNs: id,
      ...(botName ? { botName } : {}),
    },
  });
  writeEntries(patchPath, entries);
  return id;
}

/**
 * 移除实例（连同它的 patch 行）。
 *
 * 默认实例 `im-qqbot` 不允许删除——它是「至少有一个」的保证。
 * 返回是否真的删掉了。
 */
export function removeInstance(patchPath: string, settingsNs: string): boolean {
  if (settingsNs === DEFAULT_SETTINGS_NS) return false;
  const entries = readEntries(patchPath);
  const next = entries.filter((e) => e.id !== settingsNs);
  if (next.length === entries.length) return false;
  writeEntries(patchPath, next);
  return true;
}

/** 启用 / 停用实例（不建连接、不响应消息） */
export function setInstanceEnabled(patchPath: string, settingsNs: string, enabled: boolean): boolean {
  const entries = readEntries(patchPath);
  const entry = entries.find((e) => e.id === settingsNs);
  if (entry === undefined) return false;
  entry.config = { ...(entry.config ?? {}), enabled };
  writeEntries(patchPath, entries);
  return true;
}

/** profile patch 的完整路径 */
export function profilePatchPath(profileDir: string): string {
  return resolve(profileDir, 'cordis.patch.yml');
}
