/**
 * Preset 命令：/preset — 查看与切换 agent preset
 *
 * 默认跑 `qqchat`（QQ 聊天模式）：零工具 + 插件内置人格。
 * 支持切换，但**切换是安全相关操作**——切到 `standard` 之类会带来
 * 终端与文件读写等全套工具，所以本命令默认仅限管理员（见 types.ts 的 adminOnly）。
 *
 * 两个关键约束：
 *   1. preset 在会话**创建时**固定，`agents.resume()` 改不了它
 *      → 切换 = 持久化偏好 + 重建会话（历史通过事件快照保留）
 *   2. 「用户偏好」与「会话实际用的 preset」是两个概念，必须分开存
 *      → 混用会导致刚切换完就被一致性检测丢掉
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import { FIXED_PRESET_ID } from '../config.ts';

export function presetCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'preset',
    category: 'agent',
    description: '查看或切换 agent preset（默认 qqchat）',
    usage: [
      '/preset',
      '/preset <preset-id>',
      '',
      '不带参数：列出所有可用 preset，并标出当前用的那个。',
      '带参数：切换到指定 preset（会重建会话，上下文保留）。',
    ].join('\n'),
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim();
      const current = manager.getEffectivePreset(scope, peerId) ?? FIXED_PRESET_ID;

      // 带参数：切换
      if (args) {
        if (args === current) {
          return `当前已经是 ${current}，无需切换。`;
        }
        const result = await manager.setPresetOverride(scope, peerId, args);
        if (result.ok) {
          return [
            `已切换到 **${result.presetId}**。`,
            '',
            '会话已重建（上下文保留）。如果这个 preset 带工具，注意它不再受「零工具」约束。',
          ].join('\n');
        }
        const hint = result.message ? `\n\n${result.message}` : '';
        return `切换失败：${result.reason ?? 'unknown'}${hint}`;
      }

      // 无参数：展示当前 + 可用列表
      const available = await manager.listAvailablePresets();
      const lines: string[] = ['### Agent Preset', ''];
      lines.push(`**当前:** ${current}`);
      if (current === FIXED_PRESET_ID) {
        lines.push('');
        lines.push(`${FIXED_PRESET_ID} 是 QQ 聊天模式：零工具、人格由插件内置定义。`);
      }

      if (available.length === 0) {
        lines.push('', '（拿不到可用 preset 列表——宿主可能没提供 agentPresets 服务）');
      } else {
        lines.push('', '**可用 preset：**', '');
        for (const p of available) {
          const mark = p.id === current ? '**← 当前**' : '';
          const name = p.name ? `（${p.name}）` : '';
          const desc = p.description ? ` — ${p.description}` : '';
          lines.push(`- \`${p.id}\`${name}${desc} ${mark}`.trimEnd());
        }
        lines.push('', `发送 \`/preset <id>\` 切换。`);
      }

      await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}
