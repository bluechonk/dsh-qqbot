/**
 * 群友档案 — 进程内单例
 *
 * 抽出来是因为有两个使用方：
 *   - inbound 每条消息 `touch()`（认人、记称呼）
 *   - bootstrap 关闭时 `flush(true)` 强制落盘
 *
 * 后者的存在理由：`flush()` 有 5 秒节流，群聊密集时（消息间隔 < 5s）
 * 会一直跳过写盘，`dirty` 一直为真。宿主退出时若不强制落盘，
 * 内存里的档案就全丢了——丢的正是最有价值的部分（学到的别名）。
 */
import { pluginDataPath } from '../../shared/index.ts';
import { PeopleStore } from './store.ts';

let instance: PeopleStore | undefined;

/** 取档案存储（惰性创建；enabled=false 时调用方应跳过使用） */
export function getPeopleStore(enabled: boolean): PeopleStore {
  if (instance === undefined) {
    instance = new PeopleStore({
      filePath: pluginDataPath('people.json'),
      enabled,
    });
  }
  return instance;
}

/**
 * 强制落盘（关闭时调用）。
 *
 * 刻意不创建实例：如果整个进程从没收到过消息，就没必要写一个空文件。
 */
export function flushPeopleStoreIfCreated(): void {
  instance?.flush(true);
}

/** 仅供测试重置 */
export function resetPeopleStore(): void {
  instance = undefined;
}
