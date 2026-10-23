/**
 * 未知网关事件留痕
 *
 * SDK 只对已知事件建模（消息 / 互动 / 频道 / 好友增删 …），其余一律以
 * `rawEvent` 透传。QQ 平台的某些能力（如「戳一戳」）在腾讯自家 SDK 的
 * 事件常量里查不到，需要**先证明平台是否真的推送**，再决定要不要实现。
 *
 * 这里把每一个未知事件原样落盘，用于：
 *   1. 探测平台是否推送某类事件（例如让某人戳一下机器人，看有没有记录）
 *   2. 排查「明明触发了却没反应」——先确认事件到底有没有到
 *
 * 只记事件类型与裁剪后的 payload，不记消息正文全量，避免日志失控。
 */
import { appendFileSync, mkdirSync, statSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 日志体积上限（字节），超过后滚动 */
const MAX_BYTES = 1024 * 1024;
/** 滚动后保留行数 */
const KEEP_LINES = 500;
/** payload 序列化上限（字符），防止超长字段把日志撑爆 */
const MAX_PAYLOAD_CHARS = 1200;

export interface RawEventLogOptions {
  /** 日志文件路径 */
  filePath: string;
  /** 是否启用（关闭则完全不落盘） */
  enabled: boolean;
}

export class RawEventLog {
  private readonly filePath: string;
  private readonly enabled: boolean;

  constructor(options: RawEventLogOptions) {
    this.filePath = options.filePath;
    this.enabled = options.enabled;
  }

  /** 记录一个未知网关事件（失败不抛） */
  record(eventType: string, data: unknown): void {
    if (!this.enabled) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const line = JSON.stringify({
        ts: Date.now(),
        eventType,
        data: clip(data),
      });
      appendFileSync(this.filePath, `${line}\n`, 'utf8');
      this.maybeRoll();
    } catch {
      /* 留痕失败不影响主流程 */
    }
  }

  private maybeRoll(): void {
    try {
      if (statSync(this.filePath).size <= MAX_BYTES) return;
      const lines = readFileSync(this.filePath, 'utf8').split('\n').filter((l) => l.trim() !== '');
      if (lines.length <= KEEP_LINES) return;
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, `${lines.slice(-KEEP_LINES).join('\n')}\n`, 'utf8');
      renameSync(tmp, this.filePath);
    } catch {
      /* 滚动失败忽略 */
    }
  }
}

/** 把 payload 裁剪成适合落盘的形状 */
function clip(data: unknown): unknown {
  try {
    const text = JSON.stringify(data);
    if (text === undefined) return String(data);
    if (text.length <= MAX_PAYLOAD_CHARS) return JSON.parse(text) as unknown;
    return `${text.slice(0, MAX_PAYLOAD_CHARS)}…`;
  } catch {
    return '<unserializable>';
  }
}
