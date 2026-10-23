/**
 * 未知网关事件留痕测试
 *
 * 这个模块的唯一职责是「如实记录」，不能被 payload 形状搞崩：
 * 循环引用、超长字段、非 JSON 值都必须安全降级。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RawEventLog } from './raw-event-log.ts';

const dirs: string[] = [];

function tempLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-raw-'));
  dirs.push(dir);
  return join(dir, 'raw-events.jsonl');
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('RawEventLog', () => {
  it('关闭时不落盘', () => {
    const file = tempLog();
    new RawEventLog({ filePath: file, enabled: false }).record('TEST', { a: 1 });
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('记录事件类型与 payload', () => {
    const file = tempLog();
    new RawEventLog({ filePath: file, enabled: true })
      .record('GROUP_POKE', { user_openid: 'u1', group_openid: 'g1' });
    const line = JSON.parse(readFileSync(file, 'utf8').trim()) as {
      ts: number; eventType: string; data: Record<string, unknown>;
    };
    expect(line.eventType).toBe('GROUP_POKE');
    expect(line.data).toMatchObject({ user_openid: 'u1', group_openid: 'g1' });
    expect(typeof line.ts).toBe('number');
  });

  it('超长 payload 被裁剪成字符串，不撑爆日志', () => {
    const file = tempLog();
    const huge = { text: 'x'.repeat(5000) };
    new RawEventLog({ filePath: file, enabled: true }).record('BIG', huge);
    const line = JSON.parse(readFileSync(file, 'utf8').trim()) as { data: unknown };
    expect(typeof line.data).toBe('string');
    expect((line.data as string).length).toBeLessThan(1400);
  });

  it('循环引用不抛异常', () => {
    const file = tempLog();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => new RawEventLog({ filePath: file, enabled: true }).record('CYCLE', cyclic))
      .not.toThrow();
  });

  it('多条记录按行追加', () => {
    const file = tempLog();
    const log = new RawEventLog({ filePath: file, enabled: true });
    log.record('A', {});
    log.record('B', {});
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).eventType).toBe('B');
  });
});
