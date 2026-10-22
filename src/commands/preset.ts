/**
 * Preset 命令：/preset — 只读展示当前 preset
 *
 * 本插件的会话**固定**跑在 qqchat（QQ 聊天模式）上：人格、说话风格、工具集
 * 全部由插件自带的 preset 定义决定，不支持切换到其他预设。
 *
 * 因此这个命令只做两件事：
 *   - 告诉用户当前固定用的是哪个 preset、它长什么样
 *   - 明确拒绝切换请求（而不是静默失败或偷偷切换）
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';
import { FIXED_PRESET_ID } from '../config.ts';

export function presetCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'preset',
    category: 'agent',
    description: '查看当前 agent preset（本插件固定使用 qqchat，不支持切换）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim();

      // 有参数：拒绝一切切换请求
      if (args) {
        if (args === FIXED_PRESET_ID) {
          return `当前已经是 ${FIXED_PRESET_ID}（QQ 聊天模式），无需切换。`;
        }
        return `本插件固定使用 ${FIXED_PRESET_ID}（QQ 聊天模式），不支持切换到其他 preset。`;
      }

      // 无参数：展示当前固定 preset
      const record = manager.getSessionRecord(scope, peerId);
      const currentId = record?.agentPreset ?? FIXED_PRESET_ID;

      const lines: string[] = ['### QQ 聊天模式', ''];
      lines.push(`**当前 preset:** ${currentId}`);
      lines.push('');
      lines.push('本插件的会话固定使用该 preset：');
      lines.push('- 零工具：不挂终端与文件读写，主人说什么都不会去动电脑');
      lines.push('- 人格与说话风格由插件内置定义');
      lines.push('- 不支持切换到其他 preset');

      await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}
