/**
 * 命令权限 — 管理员判定
 *
 * 为什么需要它：**平台不告诉机器人谁是它的创建者**。
 * QQ 机器人 API 没有 owner/创建者概念，只有 `GROUP_ADD_ROBOT` 事件带
 * `op_member_openid`（拉机器人进群的人），但那只在入群时有一次、且是 per-group，
 * 不能当作「主人」的可靠来源。
 *
 * 所以主人身份**必须显式配置**。本模块只管判定，不碰 IO。
 *
 * 两个刻意的设计：
 *
 * 1. **默认开启校验 + 空名单 = 谁也进不来**。
 *    安全默认：宁可先锁上再让主人配置，也不要默认敞开。
 *    拒绝文案里写明怎么配置，形成一条自解释的上手路径。
 *
 * 2. **`enabled: false` 时人人都是管理员**。
 *    这是明确的「关掉这个功能」，不是「配置错误」。
 */

/** 管理员配置 */
export interface AdminConfig {
  /**
   * 是否启用命令权限校验。
   *
   * 关闭时所有人都能执行高权限命令（等价于回到旧行为），
   * 只应在本地调试时关闭。
   */
  enabled: boolean;
  /**
   * 管理员 openid 白名单。
   *
   * 注意是 **openid**（形如 `EC162542C77F402DC4C07E3735E786A9`），
   * 不是 QQ 号——平台推给机器人的只有 openid，QQ 号在 API 里根本拿不到。
   * 用 `/whoami` 可以查看自己的 openid。
   */
  openids: string[];
}

/** 判定某发送者是否管理员 */
export function isAdmin(senderId: string | undefined, admin: AdminConfig): boolean {
  // 功能关闭 → 不限制
  if (!admin.enabled) return true;
  // 没有身份信息 → 不放行（宁可拒绝，也不要在身份不明时给权限）
  if (!senderId) return false;
  return admin.openids.includes(senderId);
}

/** 名单是否为空（用于给出「还没配置」这类更具体的提示） */
export function hasNoAdminConfigured(admin: AdminConfig): boolean {
  return admin.openids.length === 0;
}

/**
 * 拒绝文案。
 *
 * 分两种：**还没配置主人** vs **你不是主人**。
 * 前者要给出完整的配置指引（主人第一次用会撞上它），
 * 后者只要一句拒绝即可——不需要向普通群友解释配置细节。
 */
export function buildDenialMessage(admin: AdminConfig): string {
  if (hasNoAdminConfigured(admin)) {
    return [
      '⚠️ 还没配置主人，所以高权限命令暂时对所有人关闭。',
      '',
      '主人请这样做：',
      '1. 发送 `/whoami` 查看自己的 openid',
      '2. 把它填进配置的 `admin.openids`',
      '3. 重启 DSH 生效',
    ].join('\n');
  }
  return '⚠️ 只有主人能执行这个命令。';
}

/**
 * 渲染自己的身份信息（`/whoami` 用）。
 *
 * 这个命令**必须开放**：它是主人找到自己 openid 的唯一途径，
 * 在 `admin.openids` 还是空的时候就得能用。
 *
 * openid 是 bot 作用域内的用户标识（不是全局身份），发到群里风险很低；
 * 不给它就无法完成配置。
 */
export function buildIdentityMessage(params: {
  senderId: string;
  senderName?: string;
  admin: AdminConfig;
  /** 当前会话是群聊还是私聊 */
  isGroup: boolean;
}): string {
  const { senderId, senderName, admin, isGroup } = params;
  const lines: string[] = ['### 你的身份', ''];
  if (senderName) lines.push(`**昵称:** ${senderName}`);
  lines.push(`**openid:** \`${senderId}\``);
  lines.push(`**会话:** ${isGroup ? '群聊' : '私聊'}`);

  if (!admin.enabled) {
    lines.push('', '**权限:** 命令权限校验已关闭，所有人都能执行高权限命令。');
  } else if (isAdmin(senderId, admin)) {
    lines.push('', '**权限:** 主人（可执行全部命令）');
  } else {
    lines.push('', '**权限:** 普通群友（只能聊天与用基础命令）');
    if (hasNoAdminConfigured(admin)) {
      lines.push('', '把上面这串 openid 填进配置的 `admin.openids` 即可成为主人。');
    }
  }
  return lines.join('\n');
}
