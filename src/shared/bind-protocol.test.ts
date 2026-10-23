/**
 * 绑定协议路径 — 单测
 *
 * 锁住「单实例路径逐字不变」与「多实例各占一条路径」这两条契约。
 * 前者保证升级不破坏现有部署，后者保证多机器人不抢同一条路由。
 */
import { describe, expect, it } from 'vitest';
import {
  BIND_CONFIG_PATH,
  BIND_MANUAL_PATH,
  BIND_REFRESH_PATH,
  BIND_STATE_PATH,
  BIND_UNBIND_PATH,
  DEFAULT_BIND_NS,
  bindConfigPath,
  bindManualPath,
  bindRefreshPath,
  bindStatePath,
  bindUnbindPath,
} from './bind-protocol.ts';

describe('bind-protocol 路径', () => {
  it('默认实例的路径与旧版逐字一致（升级不破坏现有部署）', () => {
    expect(bindStatePath(DEFAULT_BIND_NS)).toBe('/qqbot/im-qqbot/bind');
    expect(bindRefreshPath(DEFAULT_BIND_NS)).toBe('/qqbot/im-qqbot/bind/refresh');
    expect(bindManualPath(DEFAULT_BIND_NS)).toBe('/qqbot/im-qqbot/bind/manual');
    expect(bindUnbindPath(DEFAULT_BIND_NS)).toBe('/qqbot/im-qqbot/bind/unbind');
    expect(bindConfigPath(DEFAULT_BIND_NS)).toBe('/qqbot/im-qqbot/config');
  });

  it('旧常量等价于默认实例的路径函数', () => {
    expect(BIND_STATE_PATH).toBe(bindStatePath(DEFAULT_BIND_NS));
    expect(BIND_REFRESH_PATH).toBe(bindRefreshPath(DEFAULT_BIND_NS));
    expect(BIND_MANUAL_PATH).toBe(bindManualPath(DEFAULT_BIND_NS));
    expect(BIND_UNBIND_PATH).toBe(bindUnbindPath(DEFAULT_BIND_NS));
    expect(BIND_CONFIG_PATH).toBe(bindConfigPath(DEFAULT_BIND_NS));
  });

  it('多实例各占一条路径，互不抢路由', () => {
    expect(bindStatePath('im-qqbot-2')).toBe('/qqbot/im-qqbot-2/bind');
    expect(bindConfigPath('im-qqbot-2')).toBe('/qqbot/im-qqbot-2/config');
    // 两个实例的状态路由必须不同
    expect(bindStatePath('im-qqbot')).not.toBe(bindStatePath('im-qqbot-2'));
  });

  it('路径是纯函数（同输入同输出）', () => {
    expect(bindStatePath('a')).toBe(bindStatePath('a'));
  });
});
