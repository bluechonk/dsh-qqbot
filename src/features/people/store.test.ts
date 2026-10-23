/**
 * 群友档案存储测试
 *
 * 重点验证：
 *   - (机器人, 群) 隔离：同一个群被两个机器人加，档案不串味
 *   - 别名去重与上限
 *   - 关闭时不碰磁盘
 *   - 损坏文件不影响聊天（从空档案重建）
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PeopleStore } from './store.ts';

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-people-'));
  dirs.push(dir);
  return join(dir, 'people.json');
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const BASE = { scope: 'group' as const, scopeId: 'g1', openid: 'u1' };

describe('PeopleStore', () => {
  it('关闭时不落盘也不返回档案', () => {
    const file = tempFile();
    const store = new PeopleStore({ filePath: file, enabled: false });
    expect(store.touch({ ...BASE, appId: 'a', name: 'x' })).toBeUndefined();
    store.flush(true);
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('首次见到就建档案，count 从 1 起', () => {
    const store = new PeopleStore({ filePath: tempFile(), enabled: true });
    const p = store.touch({ ...BASE, appId: 'a', name: '蓝鲸' });
    expect(p).toMatchObject({ openid: 'u1', name: '蓝鲸', count: 1 });
  });

  it('多次见到累加次数、更新昵称', () => {
    const store = new PeopleStore({ filePath: tempFile(), enabled: true });
    store.touch({ ...BASE, appId: 'a', name: '旧名' });
    const p = store.touch({ ...BASE, appId: 'a', name: '新名' });
    expect(p?.count).toBe(2);
    expect(p?.name).toBe('新名');
  });

  it('别名去重且只留最近 5 个', () => {
    const store = new PeopleStore({ filePath: tempFile(), enabled: true });
    for (const alias of ['a', 'a', 'b', 'c', 'd', 'e', 'f']) {
      store.touch({ ...BASE, appId: 'a', alias });
    }
    const p = store.get({ ...BASE, appId: 'a' });
    // 去重后是 a,b,c,d,e,f 六个，只留最近 5 个 → 丢掉最早的 a
    expect(p?.aliases).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('(机器人, 群) 隔离：换机器人或换群都是独立档案', () => {
    const store = new PeopleStore({ filePath: tempFile(), enabled: true });
    store.touch({ ...BASE, appId: 'botA', alias: '主人' });
    store.touch({ ...BASE, appId: 'botB', alias: '老板' });

    expect(store.get({ ...BASE, appId: 'botA' })?.aliases).toEqual(['主人']);
    expect(store.get({ ...BASE, appId: 'botB' })?.aliases).toEqual(['老板']);
    // 换个群也不串
    expect(store.get({ ...BASE, appId: 'botA', scopeId: 'g2' })).toBeUndefined();
  });

  it('flush 后能重新读回（持久化）', () => {
    const file = tempFile();
    const first = new PeopleStore({ filePath: file, enabled: true });
    first.touch({ ...BASE, appId: 'a', name: '蓝鲸', alias: '肥鱼' });
    first.flush(true);

    const second = new PeopleStore({ filePath: file, enabled: true });
    const p = second.get({ ...BASE, appId: 'a' });
    expect(p).toMatchObject({ name: '蓝鲸', count: 1 });
    expect(p?.aliases).toContain('肥鱼');
  });

  it('文件损坏时从空档案重建，不抛异常', () => {
    const file = tempFile();
    writeFileSync(file, '{ not json', 'utf8');
    const store = new PeopleStore({ filePath: file, enabled: true });
    expect(() => store.touch({ ...BASE, appId: 'a', name: 'x' })).not.toThrow();
    expect(store.get({ ...BASE, appId: 'a' })?.name).toBe('x');
  });

  it('私聊用 c2c 作用域，与群聊隔离', () => {
    const store = new PeopleStore({ filePath: tempFile(), enabled: true });
    store.touch({ appId: 'a', scope: 'group', scopeId: 'g1', openid: 'u1', alias: '群里' });
    store.touch({ appId: 'a', scope: 'c2c', scopeId: 'c2c', openid: 'u1', alias: '私下' });
    expect(store.get({ appId: 'a', scope: 'group', scopeId: 'g1', openid: 'u1' })?.aliases)
      .toEqual(['群里']);
    expect(store.get({ appId: 'a', scope: 'c2c', scopeId: 'c2c', openid: 'u1' })?.aliases)
      .toEqual(['私下']);
  });
});

/**
 * 写盘节流。
 *
 * 这组测试的由来：群聊密集时（消息间隔 < 5 秒）flush() 会一直跳过写盘，
 * `dirty` 一直为真。**宿主退出时若不强制落盘，内存里的档案就全丢了**——
 * 丢的正是最有价值的部分（学到的别名）。
 * 所以 bootstrap 关闭时必须调 flush(true)。
 */
describe('PeopleStore 写盘节流', () => {
  it('节流窗口内 flush() 不写盘', () => {
    const file = tempFile();
    const store = new PeopleStore({ filePath: file, enabled: true });
    store.touch({ ...BASE, appId: 'a', alias: '主人' });
    // 第一次 touch 已经写过一次，紧接着再改一次
    store.touch({ ...BASE, appId: 'a', alias: '老板' });
    store.flush(); // 仍在窗口内 → 跳过
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
      people: Record<string, { aliases: string[] }>;
    };
    const entry = Object.values(onDisk.people)[0]!;
    expect(entry.aliases).not.toContain('老板');
  });

  it('flush(true) 强制写盘，绕过节流', () => {
    const file = tempFile();
    const store = new PeopleStore({ filePath: file, enabled: true });
    store.touch({ ...BASE, appId: 'a', alias: '主人' });
    store.touch({ ...BASE, appId: 'a', alias: '老板' });
    store.flush(true);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
      people: Record<string, { aliases: string[] }>;
    };
    const entry = Object.values(onDisk.people)[0]!;
    expect(entry.aliases).toContain('老板');
  });

  it('密集消息后强制落盘，不丢任何一条', () => {
    const file = tempFile();
    const store = new PeopleStore({ filePath: file, enabled: true });
    // 模拟群聊刷屏：连续 10 条，间隔远小于节流窗口
    for (let i = 0; i < 10; i++) store.touch({ ...BASE, appId: 'a' });
    store.flush(true);

    const reloaded = new PeopleStore({ filePath: file, enabled: true });
    expect(reloaded.get({ ...BASE, appId: 'a' })?.count).toBe(10);
  });

  it('没有改动时 flush 不产生文件（不写空档案）', () => {
    const file = tempFile();
    const store = new PeopleStore({ filePath: file, enabled: true });
    store.flush(true);
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });
});
