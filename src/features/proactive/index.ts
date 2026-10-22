/**
 * 自主接话 — 模块出口与数据目录
 *
 * 目标：让机器人在群里**不用被点名**也能有选择地接话。
 * 详见 docs/proactive-group-chat.md。
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export * from './types.ts';
export * from './lexical-gate.ts';
export * from './cooldown.ts';
export * from './observer.ts';

/** 插件本地数据根目录（与 model-prefs.json 同处，便于统一管理） */
export function proactiveDataDir(): string {
  return resolve(homedir(), '.dsh-qqbot');
}

/** 插件本地数据文件路径 */
export function proactiveDataPath(fileName: string): string {
  return resolve(proactiveDataDir(), fileName);
}
