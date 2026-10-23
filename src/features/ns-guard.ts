/**
 * 实例命名空间守卫
 *
 * 多实例时每个实例必须有**唯一** `settingsNs`，它决定四样东西：
 * 绑定路由路径、Web 设置分区 id、凭据落盘的 patch 条目 id、本地数据目录。
 * 一旦重复，两个实例会互相覆盖配置与数据，而且**症状是静默的**
 * （这正是本项目最贵的 bug 类别）。
 *
 * 所以启动时必须校验：发现重复就拒绝启动该实例并给出明确报错，
 * 而不是让两个实例悄悄抢同一条路由。
 *
 * 参考 zaofan fork 的 `ns-guard.ts`（其 issue #11 就是这类 bug 的血泪：
 * patch 键行被误删导致所有会话 resume 失败）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

import { DEFAULT_SETTINGS_NS } from '../config.ts';

/** patch 条目中与命名空间相关的最小结构 */
interface PatchEntry {
  id?: string;
  config?: { settingsNs?: unknown };
}

/** 归一化 settingsNs（空值回落到默认，保证单实例行为不变） */
export function normalizeSettingsNs(ns: string | undefined): string {
  const trimmed = ns?.trim();
  return trimmed ? trimmed : DEFAULT_SETTINGS_NS;
}

/**
 * 找出重复的 settingsNs。
 *
 * 输入已归一化（调用方用 normalizeSettingsNs 处理过）。
 * 返回出现次数 > 1 的 ns 列表，按首次出现顺序去重。
 */
export function findDuplicateSettingsNs(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const ns of list) {
    if (seen.has(ns)) dupes.add(ns);
    else seen.add(ns);
  }
  return [...dupes];
}

/** 校验结果 */
export interface NsGuardResult {
  /** 是否有冲突 */
  ok: boolean;
  /** 冲突的命名空间（ok=false 时非空） */
  duplicates: string[];
  /** 参与校验的实例总数 */
  total: number;
}

/**
 * 扫描 profile patch，校验所有 im-qqbot 实例的 settingsNs 唯一性。
 *
 * 只认 `id` 以 `im-qqbot` 开头的条目（`im-qqbot` / `im-qqbot-1` …），
 * 不碰 profile 里其他插件行。文件不存在或没有相关条目时视为通过
 * （单实例、或实例由别处管理）。
 *
 * 解析失败返回 ok=false 并带上原因，由调用方决定是拒绝启动还是仅告警——
 * **不抛异常**，避免把「读不到文件」升级成「插件崩溃」。
 */
export function validateProfileSettingsNs(profileDir: string | undefined): NsGuardResult {
  const empty: NsGuardResult = { ok: true, duplicates: [], total: 0 };
  if (!profileDir) return empty;

  const patchPath = resolve(profileDir, 'cordis.patch.yml');
  if (!existsSync(patchPath)) return empty;

  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(patchPath, 'utf8'));
  } catch {
    return { ok: false, duplicates: [], total: 0 };
  }
  if (!Array.isArray(parsed)) return empty;

  const namespaces: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = (entry as PatchEntry).id;
    if (typeof id !== 'string' || !id.startsWith('im-qqbot')) continue;
    const ns = (entry as PatchEntry).config?.settingsNs;
    namespaces.push(normalizeSettingsNs(typeof ns === 'string' ? ns : undefined));
  }

  const duplicates = findDuplicateSettingsNs(namespaces);
  return { ok: duplicates.length === 0, duplicates, total: namespaces.length };
}
