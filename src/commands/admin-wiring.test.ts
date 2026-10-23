/**
 * 命令权限接线测试
 *
 * 验的是「接线」而不是「判定」：判定逻辑在 features/admin/guard.test.ts。
 * 这里要确认**每个命令都被正确接上了**——漏接一个就等于对所有人开放。
 *
 * 所以测试的重点是「默认拒绝」：不显式标 adminOnly:false 的命令必须拦住。
 */
import { describe, expect, it, vi } from 'vitest';
import { buildCommandList } from './index.ts';
import type { CommandDeps, CategorizedCommand } from './types.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';

const OWNER = 'EC162542C77F402DC4C07E3735E786A9';
const STRANGER = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';

function makeDeps(admin: ImQQBotConfig['admin']): CommandDeps {
  const manager = {
    getEffectiveModel: vi.fn(() => undefined),
    getSessionRecord: vi.fn(() => undefined),
    listAvailableModels: vi.fn(async () => []),
  } as unknown as SessionManager;
  const config = {
    admin,
    textChunkLimit: 4500,
    preset: 'qqchat',
  } as unknown as ImQQBotConfig;
  return { manager, config };
}

/** 造一个最小的命令上下文（只带 authorized 需要读的字段） */
function ctx(senderId: string) {
  return {
    message: { senderId, kind: 'group' },
    state: {},
    command: { name: 'x', args: [], raw: '' },
  } as never;
}

/** 按任意名字（含别名）找命令 */
function find(deps: CommandDeps, name: string) {
  const cmd = buildCommandList(deps).find((c) => {
    const names = Array.isArray(c.name) ? c.name : [c.name];
    return names.includes(name);
  });
  if (!cmd) throw new Error(`命令不存在: ${name}`);
  return cmd;
}

/** 命令的 authorized 校验结果（true = 放行） */
function authorize(deps: CommandDeps, name: string, senderId: string): unknown {
  const cmd = find(deps, name);
  if (!cmd.authorized) return true; // 没接校验 = 人人可用
  return cmd.authorized(ctx(senderId));
}

describe('命令权限接线', () => {
  const adminOnly = makeDeps({ enabled: true, openids: [OWNER] });

  it('高权限命令拦住普通群友', () => {
    for (const name of ['model', 'new', 'compact', 'preset', 'stop', 'bot-status']) {
      const result = authorize(adminOnly, name, STRANGER);
      expect(result, `${name} 应该拦住普通群友`).not.toBe(true);
    }
  });

  it('高权限命令放行主人', () => {
    for (const name of ['model', 'new', 'compact', 'preset', 'stop', 'bot-status']) {
      expect(authorize(adminOnly, name, OWNER), `${name} 应该放行主人`).toBe(true);
    }
  });

  it('开放命令对所有人放行（whoami 必须在配置前就能用）', () => {
    for (const name of ['whoami', 'bot-ping', 'bot-version', 'bot-help']) {
      expect(authorize(adminOnly, name, STRANGER), `${name} 应该对所有人开放`).toBe(true);
    }
  });

  it('/help 是 /bot-help 的别名（最顺手的名字也该能用）', () => {
    // SDK 的 autoHelp 被关掉了，所以 /help 不是自动注册的；
    // 但主人第一反应就是发 /help，别名让它也能用。
    // 关键：**必须是同一个命令对象**（别名），不是注册第二个命令。
    const list = buildCommandList(adminOnly);
    const namesOf = (c: CategorizedCommand): string[] => (Array.isArray(c.name) ? c.name : [c.name]);
    const canonical = list.find((c) => namesOf(c).includes('bot-help'));
    const alias = list.find((c) => namesOf(c).includes('help'));
    expect(canonical).toBeDefined();
    expect(alias).toBe(canonical);
    expect(authorize(adminOnly, 'help', STRANGER)).toBe(true);
  });

  it('名单为空时连主人也进不来（安全默认：先锁上）', () => {
    const locked = makeDeps({ enabled: true, openids: [] });
    expect(authorize(locked, 'model', OWNER)).not.toBe(true);
    // 但开放命令仍可用，否则主人无法自助拿到 openid
    expect(authorize(locked, 'whoami', OWNER)).toBe(true);
  });

  it('关闭校验时一切放行（明确的「关掉这个功能」）', () => {
    const off = makeDeps({ enabled: false, openids: [] });
    for (const name of ['model', 'new', 'stop', 'bot-status']) {
      expect(authorize(off, name, STRANGER)).toBe(true);
    }
  });

  it('拒绝时返回的是可直接展示的文案，而不是 false', () => {
    const msg = authorize(adminOnly, 'model', STRANGER);
    expect(typeof msg).toBe('string');
    expect(String(msg)).toContain('主人');
  });

  it('默认拒绝：未显式标 adminOnly:false 的命令都必须有校验', () => {
    const list = buildCommandList(adminOnly);
    const open = new Set(['whoami', 'bot-ping', 'bot-version', 'bot-help']);
    for (const cmd of list) {
      const name = Array.isArray(cmd.name) ? cmd.name[0]! : cmd.name;
      if (open.has(name)) continue;
      expect(cmd.authorized, `${name} 缺少权限校验（默认应当拒绝）`).toBeTypeOf('function');
    }
  });
});
