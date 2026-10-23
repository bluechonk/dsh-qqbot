/**
 * 端内绑定协议 —— 宿主路由与客户端面板的共享契约
 *
 * 类型与路径的唯一事实源：宿主（setup/bind-routes.ts）与浏览器
 * （client/bind-page.ts）各自 import，杜绝两端协议漂移。
 * 本模块必须保持纯类型 + 纯常量/纯函数（零 node 依赖、零副作用）：
 * 客户端 tsdown 构建会将其内联进 bundle。
 *
 * 路径**按实例计算**：多机器人时每个实例有自己的路由，
 * 否则会抢同一条 `/qqbot/im-qqbot/bind`。
 */

/** 路由前缀 */
export const BIND_PATH_PREFIX = '/qqbot';

/** 默认实例命名空间（单实例时路径与旧版逐字一致） */
export const DEFAULT_BIND_NS = 'im-qqbot';

/** 状态查询（绑定页轮询） */
export function bindStatePath(ns: string): string {
  return `${BIND_PATH_PREFIX}/${ns}/bind`;
}

/** 刷新二维码（绑定页按钮） */
export function bindRefreshPath(ns: string): string {
  return `${bindStatePath(ns)}/refresh`;
}

/** 手动填写/编辑凭据（绑定页表单） */
export function bindManualPath(ns: string): string {
  return `${bindStatePath(ns)}/manual`;
}

/** 解绑：移除已保存凭据，回到绑定流程 */
export function bindUnbindPath(ns: string): string {
  return `${bindStatePath(ns)}/unbind`;
}

/** 配置读写（设置面板表单） */
export function bindConfigPath(ns: string): string {
  return `${BIND_PATH_PREFIX}/${ns}/config`;
}

/**
 * 旧常量名（等价于默认实例的路径）。
 *
 * 保留是为了让只关心默认实例的调用方与测试不必改；
 * 多实例调用方请改用上面的函数。
 */
export const BIND_STATE_PATH = bindStatePath(DEFAULT_BIND_NS);
export const BIND_REFRESH_PATH = bindRefreshPath(DEFAULT_BIND_NS);
export const BIND_MANUAL_PATH = bindManualPath(DEFAULT_BIND_NS);
export const BIND_UNBIND_PATH = bindUnbindPath(DEFAULT_BIND_NS);
export const BIND_CONFIG_PATH = bindConfigPath(DEFAULT_BIND_NS);

/** 线上协议（HTTP 路由序列化形态） */
export type BindStateWire =
  | { phase: 'starting' }
  | { phase: 'waiting'; url: string; qrSvg?: string; issuedAt: number }
  | { phase: 'saving' }
  | { phase: 'failed'; reason: string }
  | { phase: 'bound'; appId: string };

/** manual / unbind 操作的统一响应 */
export interface BindActionResponse {
  ok: boolean;
  message?: string;
  error?: string;
}
