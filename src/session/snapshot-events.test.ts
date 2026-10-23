/**
 * 会话事件快照读取测试
 *
 * 这段逻辑的由来：DSH 的 `sessions.fork()` 返回的是**子会话对象**而不是
 * `{ events }`，早期按旧契约读 `.events` 拿到 undefined，切模型时在
 * `seed.length` 处抛 "Cannot read properties of undefined (reading 'length')"。
 * 所以这里必须同时兼容 `snapshotEvents()` 与 `.events`，且拿不到要返回 undefined
 * 让调用方降级，而不是抛异常。
 */
import { describe, expect, it } from 'vitest';
import { snapshotSessionEvents } from './session-manager.ts';

describe('snapshotSessionEvents', () => {
  it('优先用 snapshotEvents()（DSH 官方读法）', () => {
    const events = [{ type: 'turn/start' }];
    expect(snapshotSessionEvents({ snapshotEvents: () => events, events: [] })).toBe(events);
  });

  it('没有 snapshotEvents 时退化到 events 属性', () => {
    const events = [{ type: 'a' }];
    expect(snapshotSessionEvents({ events })).toBe(events);
  });

  it('snapshotEvents 抛异常时仍能退化到 events', () => {
    const events = [{ type: 'b' }];
    const session = {
      snapshotEvents: () => { throw new Error('boom'); },
      events,
    };
    expect(snapshotSessionEvents(session)).toBe(events);
  });

  it('snapshotEvents 返回非数组时退化', () => {
    const events = [{ type: 'c' }];
    expect(snapshotSessionEvents({ snapshotEvents: () => 'nope', events })).toBe(events);
  });

  it('两者都拿不到时返回 undefined（调用方据此降级）', () => {
    expect(snapshotSessionEvents({})).toBeUndefined();
    expect(snapshotSessionEvents({ events: 'not-array' })).toBeUndefined();
    expect(snapshotSessionEvents(null)).toBeUndefined();
    expect(snapshotSessionEvents(undefined)).toBeUndefined();
  });

  it('空会话返回空数组而不是 undefined（合法状态，不是失败）', () => {
    expect(snapshotSessionEvents({ snapshotEvents: () => [] })).toEqual([]);
  });
});
