/**
 * 防复读 — 进程内单例
 *
 * inbound 要读（注入「你最近说过」），outbound 要写（记下已发出的回复），
 * 两边共用同一份流水，所以放在这里做单例，避免互相 import 造成环。
 */
import { ReplyHistory } from './store.ts';

let instance: ReplyHistory | undefined;

/** 取全局发言流水（惰性创建；首次调用时的 size 决定容量） */
export function getReplyHistory(size?: number): ReplyHistory {
  if (instance === undefined) instance = new ReplyHistory(size);
  return instance;
}

/** 仅供测试重置 */
export function resetReplyHistory(): void {
  instance = undefined;
}
