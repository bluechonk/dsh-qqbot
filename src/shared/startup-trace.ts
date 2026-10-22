/**
 * 启动留痕 — 插件启动失败时把原因写到本地文件
 *
 * 宿主把插件加载错误打进自己的 stdout，桌面端不方便取回；
 * 这里额外落一份到 ~/.dsh-qqbot/startup.log，排查时直接看这个文件。
 *
 * 只记失败与关键状态，不记凭据。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** 启动日志文件路径 */
export function startupLogPath(): string {
  return resolve(homedir(), '.dsh-qqbot', 'startup.log');
}

/** 追加一行启动日志（失败不影响主流程） */
export function traceStartup(message: string, detail?: unknown): void {
  try {
    mkdirSync(resolve(homedir(), '.dsh-qqbot'), { recursive: true });
    const extra = detail === undefined
      ? ''
      : ` ${detail instanceof Error ? `${detail.name}: ${detail.message}` : safeStringify(detail)}`;
    appendFileSync(startupLogPath(), `${new Date().toISOString()} ${message}${extra}\n`, 'utf8');
  } catch {
    /* 留痕失败不影响主流程 */
  }
}

/** 安全序列化（循环引用不抛异常） */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
