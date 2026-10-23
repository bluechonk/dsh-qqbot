/**
 * getProfileDir 推导策略测试
 *
 * 覆盖三种 profile 布局：
 * 1. Desktop pnpm workspace 嵌套布局（标志文件探测，旧启发式会返回错误目录）
 * 2. CLI 浅层 npm 布局（标志文件或 node_modules 启发式）
 * 3. 开发模式源码目录（无命中返回 null）
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { getProfileDir, pluginDataDir, pluginDataPath } from './utils.ts';

const tempDirs: string[] = [];

/**
 * 隔离宿主环境变量：DSH 进程会带 DSH_PROFILE_DIR，不隔离会盖掉路径上推用例。
 * （生产环境恰恰要靠它——见 getProfileDir 的探测顺序）
 */
const ENV_KEYS = ['DSH_PROFILE_DIR'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-profile-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('getProfileDir', () => {
  it('Desktop pnpm 嵌套布局：按 profile 标志文件命中 profile 根', () => {
    const root = tempDir();
    const profile = join(root, 'profiles', 'desktop');
    const plugin = join(
      profile, 'dependencies', 'node_modules', '.pnpm', 'dsh-qqbot@1.0.0',
      'node_modules', '@tencent-connect', 'dsh-qqbot',
    );
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');
    writeFileSync(join(profile, 'dependencies', 'pnpm-workspace.yaml'), 'packages:\n  - .\n');

    // 旧启发式会返回 .../dsh-qqbot@1.0.0（内层 node_modules 的父目录），标志文件策略返回 profile 根
    expect(getProfileDir(undefined, plugin)).toBe(profile);
  });

  it('CLI 浅层布局：cordis.patch.yml 命中 profile 根', () => {
    const root = tempDir();
    const profile = join(root, 'profiles', 'qqbot');
    const plugin = join(profile, 'node_modules', '@tencent-connect', 'dsh-qqbot');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');

    expect(getProfileDir(undefined, plugin)).toBe(profile);
  });

  it('全新 profile（尚无标志文件）：回退 node_modules 启发式', () => {
    const root = tempDir();
    const profile = join(root, 'profiles', 'qqbot');
    const plugin = join(profile, 'node_modules', '@tencent-connect', 'dsh-qqbot');
    mkdirSync(plugin, { recursive: true });

    expect(getProfileDir(undefined, plugin)).toBe(profile);
  });

  it('pnpm-workspace.yaml 单独存在时也命中', () => {
    const root = tempDir();
    const profile = join(root, 'profile');
    const plugin = join(profile, 'deps', 'node_modules', 'dsh-qqbot');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n');

    expect(getProfileDir(undefined, plugin)).toBe(profile);
  });

  it('dev 源码 checkout（根目录自带 cordis.patch.yml 仓库文件）：返回 null', () => {
    const root = tempDir();
    const checkout = join(root, 'dsh-qqbot');
    const src = join(checkout, 'src');
    mkdirSync(src, { recursive: true });
    // checkout 根有 bundle patch 仓库文件，但它不是 profile——不得命中
    writeFileSync(join(checkout, 'cordis.patch.yml'), '# bundle patch\n');
    writeFileSync(join(checkout, 'pnpm-workspace.yaml'), 'packages:\n');

    expect(getProfileDir(undefined, src)).toBeNull();
  });

  it('npm 安装：插件包内自带 bundle patch 不得命中，profile 根才有效', () => {
    const root = tempDir();
    const profile = join(root, 'profiles', 'desktop');
    const plugin = join(profile, 'node_modules', '@tencent-connect', 'dsh-qqbot');
    mkdirSync(plugin, { recursive: true });
    // 插件包内自带 dsh.bundle.patch 分发物——它是插件自己的，不是 profile 标志
    writeFileSync(join(plugin, 'cordis.patch.yml'), '# bundle patch\n');
    writeFileSync(join(profile, 'cordis.patch.yml'), '# profile patch\n');

    expect(getProfileDir(undefined, plugin)).toBe(profile);
  });

  it('开发模式源码目录：无命中返回 null', () => {
    const root = tempDir();
    const source = join(root, 'workspace', 'dsh-qqbot', 'src');
    mkdirSync(source, { recursive: true });

    expect(getProfileDir(undefined, source)).toBeNull();
  });

  it('link 安装：路径上推必然失败，靠宿主 profileContext 拿到 profile', () => {
    const root = tempDir();
    const profile = join(root, 'profiles', 'desktop');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');
    // link 装的插件真实路径在仓库里，整条路径没有 node_modules
    const linked = join(root, 'workspace', 'dsh-qqbot');
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, 'cordis.patch.yml'), '# bundle patch\n');

    // 没有 ctx 时确实拿不到（这正是设置页报错的原因）
    expect(getProfileDir(undefined, linked)).toBeNull();
    // 有 ctx 时按宿主事实来源命中
    const ctx = { get: (name: string) => (name === 'profileContext' ? { dir: profile } : undefined) };
    expect(getProfileDir(ctx, linked)).toBe(profile);
  });

  it('profileContext 缺失或目录不存在时退回路径上推', () => {
    const root = tempDir();
    const profile = join(root, 'profiles', 'qqbot');
    const plugin = join(profile, 'node_modules', '@tencent-connect', 'dsh-qqbot');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');

    // dir 指向不存在的目录 → 不可信，退回上推
    const stale = { get: () => ({ dir: join(root, 'nope') }) };
    expect(getProfileDir(stale, plugin)).toBe(profile);
    // ctx 取服务抛异常 → 不得让写入流程崩
    const broken = { get: () => { throw new Error('boom'); } };
    expect(getProfileDir(broken, plugin)).toBe(profile);
  });

  it('宿主环境变量 DSH_PROFILE_DIR 作为次选（无 ctx 时）', () => {
    const root = tempDir();
    const profile = join(root, 'profiles', 'desktop');
    mkdirSync(profile, { recursive: true });
    const elsewhere = join(root, 'workspace', 'dsh-qqbot', 'src');
    mkdirSync(elsewhere, { recursive: true });

    process.env.DSH_PROFILE_DIR = profile;
    expect(getProfileDir(undefined, elsewhere)).toBe(profile);

    // 指向不存在的目录时不可信，继续往下退
    process.env.DSH_PROFILE_DIR = join(root, 'nope');
    expect(getProfileDir(undefined, elsewhere)).toBeNull();
  });
});

describe('pluginDataDir / pluginDataPath', () => {
  it('不传 ns 时保持 ~/.dsh-qqbot（单实例行为逐字不变）', () => {
    expect(pluginDataDir()).toBe(resolve(homedir(), '.dsh-qqbot'));
    expect(pluginDataDir(undefined)).toBe(pluginDataDir());
  });

  it('多实例按 ns 分一层目录', () => {
    expect(pluginDataDir('im-qqbot-2')).toBe(resolve(homedir(), '.dsh-qqbot', 'im-qqbot-2'));
  });

  it('空白 ns 视为未设置（回落默认目录）', () => {
    expect(pluginDataDir('   ')).toBe(pluginDataDir());
  });

  it('pluginDataPath 与 pluginDataDir 一致', () => {
    expect(pluginDataPath('people.json')).toBe(resolve(pluginDataDir(), 'people.json'));
    expect(pluginDataPath('people.json', 'im-qqbot-2')).toBe(resolve(pluginDataDir('im-qqbot-2'), 'people.json'));
  });

  it('不同实例的数据文件互不重叠（多个机器人是不同的"人"）', () => {
    expect(pluginDataPath('people.json', 'im-qqbot')).not.toBe(pluginDataPath('people.json', 'im-qqbot-2'));
  });
});
