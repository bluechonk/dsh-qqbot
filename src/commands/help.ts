/**
 * /bot-help（别名 /help）— 查看所有指令，按「通用能力 / QQ 机器人特有」分组展示
 *
 * 通用能力：对应底层 dsh agent 能力（new/compact/model/stop），无前缀
 * QQBot 特有：插件自身封装（whoami/bot-ping/bot-version/bot-status/bot-help），带 bot- 前缀
 *
 * 按权限**过滤**：非管理员看不到管理员专用命令。
 * 不这样做的话，普通群友会照着一份自己用不了的清单去试，然后收到一串拒绝。
 *
 * 为什么带 `/help` 这个别名：SDK 的 `autoHelp` 被关掉了（否则它会再注册一个
 * 无前缀的 `/help`，和本命令重复），于是「最顺手的名字」也一起没了——
 * 实测主人第一反应就是发 `/help`，结果被当成聊天。别名只多一个匹配名，
 * 不产生第二个命令，重复问题不存在。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { sendMarkdownChunked, PLUGIN_VERSION } from '../shared/index.ts';
import { isAdmin } from '../features/admin/index.ts';

/** /bot-help（别名 /help）— 分组查看所有指令（按调用者权限过滤） */
export function helpCommand(
  { config }: CommandDeps,
  allCommands: () => CategorizedCommand[],
): CategorizedCommand {
  return {
    name: ['bot-help', 'help'],
    category: 'qqbot',
    adminOnly: false,
    description: '查看所有指令',
    handler: async (cmdCtx) => {
      const viewerIsAdmin = isAdmin(cmdCtx.message.senderId, config.admin);
      const agentCmds: CategorizedCommand[] = [];
      const qqbotCmds: CategorizedCommand[] = [];
      for (const cmd of allCommands()) {
        if (cmd.hidden) continue;
        // 非管理员看不到管理员专用命令
        if (cmd.adminOnly !== false && !viewerIsAdmin) continue;
        (cmd.category === 'agent' ? agentCmds : qqbotCmds).push(cmd);
      }

      const render = (cmds: CategorizedCommand[]): string[] => {
        const out: string[] = [];
        for (const cmd of cmds) {
          const names = Array.isArray(cmd.name) ? cmd.name : [cmd.name];
          // 别名也列出来：它们同样是可用命令，藏起来等于「有命令但没人知道」
          const label = names.map((n) => `/${n}`).join(' ');
          out.push(`<qqbot-cmd-input text="/${names[0]}" show="${label}"/> ${cmd.description ?? ''}`);
        }
        return out;
      };

      const lines: string[] = ['### 🤖 QQ 机器人指令', ''];

      if (agentCmds.length > 0) {
        lines.push('**通用能力**', '', ...render(agentCmds), '');
      }
      if (qqbotCmds.length > 0) {
        lines.push('**插件内置指令**', '', ...render(qqbotCmds), '');
      }

      if (!viewerIsAdmin) {
        lines.push('> 部分指令仅限主人使用。发送 `/whoami` 查看自己的权限。', '');
      }

      lines.push('', `> dsh-qqbot v${PLUGIN_VERSION}`);
      await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}
