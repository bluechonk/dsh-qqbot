/**
 * 斜杠命令注册中心
 *
 * 每个命令拆分为独立文件，此处仅编排。工厂函数注入依赖，统一导出命令列表。
 *
 * 命令按 category 分两类：
 *   - agent：底层 dsh agent 通用能力（new/compact/model/stop）
 *   - qqbot：插件自身特有（whoami/ping/version/status/help）
 *
 * **权限在这里统一接线**：每个命令的 `adminOnly` 被翻译成 SDK 的 `authorized`。
 * 集中接线而不是各命令自己写，是为了避免漏标——漏标的后果是
 * 「某个命令意外对所有人开放」，集中接线只需要看一处。
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { newCommand, compactCommand } from './session.ts';
import { modelCommand } from './model.ts';
import { presetCommand } from './preset.ts';
import { statusCommand } from './status.ts';
import { helpCommand } from './help.ts';
import { pingCommand, versionCommand, stopCommand, whoamiCommand } from './misc.ts';
import { buildDenialMessage, isAdmin } from '../features/admin/index.ts';

/** 命令是否仅限管理员：默认是（见 CategorizedCommand.adminOnly 的说明） */
function isAdminOnly(cmd: CategorizedCommand): boolean {
  return cmd.adminOnly !== false;
}

/**
 * 构建标准命令列表
 */
export function buildCommandList(deps: CommandDeps): CategorizedCommand[] {
  const commands: CategorizedCommand[] = [
    // 通用能力（底层 agent）
    newCommand(deps),
    compactCommand(deps),
    modelCommand(deps),
    presetCommand(deps),
    stopCommand(deps),
    // QQBot 特有
    whoamiCommand(deps),
    pingCommand(),
    versionCommand(deps),
    statusCommand(deps),
  ];

  // help 需要访问完整列表（含自身），通过闭包惰性引用
  commands.push(helpCommand(deps, () => commands));

  return commands.map((cmd) => withAdminGuard(cmd, deps));
}

/**
 * 给命令接上管理员校验。
 *
 * 用 SDK 的 `authorized` 而不是中间件级的 `allowFrom`：
 * 后者会让命令**静默退化成普通聊天**，主人看到的是「命令没反应」；
 * 前者会明确回一句拒绝文案，能直接告诉主人该怎么配置。
 */
function withAdminGuard(cmd: CategorizedCommand, deps: CommandDeps): CategorizedCommand {
  if (!isAdminOnly(cmd)) return cmd;

  const previous = cmd.authorized;
  return {
    ...cmd,
    authorized: (ctx) => {
      // 命令自带的校验优先（当前没有命令用它，留作扩展点）
      if (previous) {
        const own = previous(ctx);
        if (own !== true) return own;
      }
      if (isAdmin(ctx.message.senderId, deps.config.admin)) return true;
      return buildDenialMessage(deps.config.admin);
    },
  };
}
