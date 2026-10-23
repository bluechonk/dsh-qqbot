/**
 * /preset 命令 — 单测
 *
 * 锁两件事：
 *   · 不带参数 → 展示当前 + 可用列表（不切换）
 *   · 带参数 → 走 setPresetOverride，失败时把原因回给用户
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock 会被提升到文件顶部，工厂里不能引用外部变量 —— 用 vi.hoisted 先声明
const { sendMarkdownChunked } = vi.hoisted(() => ({
  sendMarkdownChunked: vi.fn(async () => undefined),
}));

vi.mock('../shared/index.ts', () => ({
  getScopePeer: () => ({ scope: 'group', peerId: 'G1' }),
  sendMarkdownChunked: (...args: unknown[]) => sendMarkdownChunked(...args),
}));

const { presetCommand } = await import('./preset.ts');
import type { CommandDeps, CategorizedCommand } from './types.ts';

function makeCommand(overrides: Partial<CommandDeps['manager']> = {}): CategorizedCommand {
  const manager = {
    getEffectivePreset: () => 'qqchat',
    listAvailablePresets: async () => [
      { id: 'qqchat', name: 'QQ 聊天' },
      { id: 'standard', name: '标准' },
    ],
    setPresetOverride: async () => ({ ok: true, presetId: 'standard' }),
    ...overrides,
  } as unknown as CommandDeps['manager'];
  const config = { textChunkLimit: 4500 } as unknown as CommandDeps['config'];
  return presetCommand({ manager, config } as CommandDeps);
}

/** SDK 的 ParsedCommand.raw 是「命令名之后的参数串」，不含命令名本身 */
function ctx(args: string) {
  return {
    message: { senderId: 'S1', kind: 'group', content: `/preset ${args}`.trim() },
    command: { name: 'preset', args: args.split(/\s+/).filter(Boolean), raw: args },
    state: {},
  } as never;
}

describe('/preset 命令', () => {
  beforeEach(() => { sendMarkdownChunked.mockClear(); });

  it('不带参数：展示当前与可用列表，标出当前项', async () => {
    const cmd = makeCommand();
    await cmd.handler(ctx(''));
    expect(sendMarkdownChunked).toHaveBeenCalledTimes(1);
    const payload = String(sendMarkdownChunked.mock.calls[0]![1]);
    expect(payload).toContain('当前:');
    expect(payload).toContain('qqchat');
    expect(payload).toContain('standard');
    expect(payload).toContain('当前');
  });

  it('带参数：切换到指定 preset', async () => {
    const setPresetOverride = vi.fn(async () => ({ ok: true, presetId: 'standard' }));
    const cmd = makeCommand({ setPresetOverride });
    const out = await cmd.handler(ctx('standard'));
    expect(setPresetOverride).toHaveBeenCalledWith('group', 'G1', 'standard');
    expect(String(out)).toContain('standard');
    expect(sendMarkdownChunked).not.toHaveBeenCalled();
  });

  it('切到当前 preset：直接回一句，不触发切换', async () => {
    const setPresetOverride = vi.fn();
    const cmd = makeCommand({ setPresetOverride });
    const out = await cmd.handler(ctx('qqchat'));
    expect(setPresetOverride).not.toHaveBeenCalled();
    expect(String(out)).toContain('无需切换');
  });

  it('切换失败：把失败原因回给用户', async () => {
    const cmd = makeCommand({
      setPresetOverride: async () => ({ ok: false, reason: 'unknown-preset', message: '没有这个 preset' }),
    });
    const out = await cmd.handler(ctx('nope'));
    expect(String(out)).toContain('unknown-preset');
    expect(String(out)).toContain('没有这个 preset');
  });

  it('拿不到 preset 列表时优雅降级（不报错）', async () => {
    const cmd = makeCommand({ listAvailablePresets: async () => [] });
    await cmd.handler(ctx(''));
    const payload = String(sendMarkdownChunked.mock.calls[0]![1]);
    expect(payload).toContain('拿不到可用 preset');
  });
});
