/**
 * 实例列表 —— 设置页「QQ 机器人」分区的多实例管理
 *
 * 单实例时它也照常工作（就一行），所以不需要按实例数切换 UI。
 * 列表来自 `/qqbot/im-qqbot/instances`（固定路径，由默认实例提供）。
 *
 * 增删启停都是**写 profile patch**：写回后宿主 HMR 重载，
 * 新实例起来 / 旧实例下去。所以操作成功后提示「将自动重载」。
 */
import { createElement, useCallback, useEffect, useState, type ReactNode } from 'react';

/** 实例管理路由（与 bind-protocol 同一前缀约定） */
const INSTANCE_LIST_PATH = '/qqbot/im-qqbot/instances';
const INSTANCE_ADD_PATH = `${INSTANCE_LIST_PATH}/add`;
const INSTANCE_REMOVE_PATH = `${INSTANCE_LIST_PATH}/remove`;
const INSTANCE_TOGGLE_PATH = `${INSTANCE_LIST_PATH}/toggle`;

/** 与 instance-registry.ts 的 InstanceInfo 对应 */
interface InstanceInfo {
  id: string;
  settingsNs: string;
  botName?: string;
  enabled: boolean;
  bound: boolean;
  appId: string;
}

/** 样式注入标记（幂等） */
const STYLE_ID = 'im-qqbot-instance-list-styles';

function useInstanceListStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.imqb3-list { display: flex; flex-direction: column; width: 100%; padding: 12px 0; }
.imqb3-row { display: flex; align-items: center; gap: 8px; min-height: 32px;
  padding: 6px 0; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.imqb3-row:first-child { border-top: 0; }
.imqb3-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-success-primary, #22c55e); }
.imqb3-dot--off { background: var(--dsw-alias-border-l3, #999); }
.imqb3-main { flex: 1; min-width: 0; }
.imqb3-name { font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imqb3-sub { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.imqb3-actions { display: flex; flex: 0 0 auto; gap: 6px; }
.imqb3-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l4, #d0d0d0);
  border-radius: var(--dsw-radius-md, 8px); padding: 3px 10px; font: inherit; font-size: 12px;
  line-height: 1.5; cursor: pointer; background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary); }
.imqb3-btn:disabled { opacity: 0.4; cursor: default; }
.imqb3-hint { margin: 0; padding: 8px 0; font-size: 12px; line-height: 1.5;
  color: var(--dsw-alias-label-tertiary); }
`;
    document.head.appendChild(style);
  }, []);
}

export function InstanceList(props: {
  /** 当前选中要编辑配置的实例 ns */
  selectedNs: string;
  /** 点击「设置」时切换目标实例 */
  onSelect: (settingsNs: string) => void;
}): ReactNode {
  const { selectedNs, onSelect } = props;
  useInstanceListStyles();
  const [items, setItems] = useState<InstanceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(INSTANCE_LIST_PATH, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { instances?: InstanceInfo[] };
      setItems(body.instances ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const add = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const suffix = Math.floor(Math.random() * 900 + 100);
      await fetch(INSTANCE_ADD_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ botName: `${suffix}` }),
      });
      await refresh();
    } catch {
      /* 列表会在下次挂载时重取 */
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  const toggle = useCallback(async (ns: string, enabled: boolean) => {
    await fetch(INSTANCE_TOGGLE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settingsNs: ns, enabled }),
    }).catch(() => {});
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (ns: string) => {
    await fetch(INSTANCE_REMOVE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settingsNs: ns }),
    }).catch(() => {});
    await refresh();
  }, [refresh]);

  return createElement('div', { className: 'imqb3-list' },
    items === null
      ? createElement('p', { className: 'imqb3-hint' }, error ? `实例列表加载失败：${error}` : '正在加载实例…')
      : [
          items.map((item) => createElement('div', { className: 'imqb3-row', key: item.id },
            createElement('span', {
              className: item.enabled ? 'imqb3-dot' : 'imqb3-dot imqb3-dot--off',
              title: item.enabled ? '运行中' : '已停用',
            }),
            createElement('div', { className: 'imqb3-main' },
              createElement('div', { className: 'imqb3-name' }, item.botName || item.id),
              createElement('p', { className: 'imqb3-sub' },
                item.bound ? `AppID ${item.appId} · ${item.enabled ? '运行中' : '已停用'}` : `未绑定 · ${item.id}`),
            ),
            createElement('div', { className: 'imqb3-actions' },
              createElement('button', {
                className: 'imqb3-btn',
                onClick: () => { onSelect(item.id); },
                style: item.id === selectedNs ? { borderColor: 'var(--dsw-alias-state-business-primary, #2563eb)' } : undefined,
              }, '设置'),
              createElement('button', {
                className: 'imqb3-btn',
                onClick: () => { void toggle(item.id, !item.enabled); },
              }, item.enabled ? '停用' : '启用'),
              item.id === 'im-qqbot'
                ? null
                : createElement('button', {
                    className: 'imqb3-btn',
                    onClick: () => { void remove(item.id); },
                  }, '删除'),
            ),
          )),
          createElement('button', { className: 'imqb3-btn', onClick: () => { void add(); }, disabled: busy }, '＋ 添加机器人'),
        ],
  );
}
