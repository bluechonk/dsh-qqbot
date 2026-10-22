/**
 * 判定日志 — 便于事后调阈值
 *
 * 每条群消息的判定结果落一行 jsonl，方便回答：
 *   「她为什么没接话？」「这条为什么接了？」「阈值该调到多少？」
 *
 * 滚动策略：超过体积阈值才检查，保留最新 N 行（原子替换）。
 * 默认只记判定分与特征，**不记消息正文**（群消息属隐私）。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 日志体积上限（字节），超过后触发滚动 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;
/** 滚动后保留的行数 */
const LOG_KEEP_LINES = 2000;
/** 每检查多少次才 stat 一次（省 IO） */
const LOG_CHECK_EVERY = 100;

export interface ObserverOptions {
  /** 日志文件路径 */
  filePath: string;
  /** 是否记录（关闭则完全不落盘） */
  enabled: boolean;
}

export class ProactiveObserver {
  private readonly filePath: string;
  private readonly enabled: boolean;
  private sinceCheck = 0;

  constructor(options: ObserverOptions) {
    this.filePath = options.filePath;
    this.enabled = options.enabled;
  }

  /** 追加一条判定记录（失败不影响主流程） */
  log(record: Record<string, unknown>): void {
    if (!this.enabled) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify({ ts: Date.now(), ...record })}\n`, 'utf8');
      this.maybeRoll();
    } catch {
      /* 记录失败不影响主流程 */
    }
  }

  /** 达到检查间隔时检查体积，超限则裁剪 */
  private maybeRoll(): void {
    if (++this.sinceCheck < LOG_CHECK_EVERY) return;
    this.sinceCheck = 0;
    try {
      if (statSync(this.filePath).size <= LOG_MAX_BYTES) return;
      // 重新读一遍并保留尾部
      const lines = readFileSync(this.filePath, 'utf8').split('\n').filter((l) => l.trim() !== '');
      if (lines.length <= LOG_KEEP_LINES) return;
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, `${lines.slice(-LOG_KEEP_LINES).join('\n')}\n`, 'utf8');
      renameSync(tmp, this.filePath);
    } catch {
      /* 滚动失败不影响记录 */
    }
  }
}
