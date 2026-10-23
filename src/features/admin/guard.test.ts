/**
 * 命令权限判定测试
 *
 * 这块是安全边界，两个方向都要钉住：
 *   - 该放行的放行（主人不被自己的权限挡住）
 *   - 该拦的拦住（普通群友、身份不明者）
 *
 * 尤其「身份不明者」——宁可拒绝，也不要在拿不到 senderId 时给权限。
 */
import { describe, expect, it } from 'vitest';
import {
  buildDenialMessage,
  buildIdentityMessage,
  hasNoAdminConfigured,
  isAdmin,
  type AdminConfig,
} from './guard.ts';

const OWNER = 'EC162542C77F402DC4C07E3735E786A9';
const STRANGER = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';

const enabled = (openids: string[]): AdminConfig => ({ enabled: true, openids });
const disabled: AdminConfig = { enabled: false, openids: [] };

describe('isAdmin', () => {
  it('功能关闭时人人都是管理员（明确的「关掉这个功能」）', () => {
    expect(isAdmin(STRANGER, disabled)).toBe(true);
    expect(isAdmin(undefined, disabled)).toBe(true);
  });

  it('名单为空时谁也进不来（安全默认）', () => {
    expect(isAdmin(OWNER, enabled([]))).toBe(false);
  });

  it('名单内的人放行', () => {
    expect(isAdmin(OWNER, enabled([OWNER]))).toBe(true);
  });

  it('名单外的人拦住', () => {
    expect(isAdmin(STRANGER, enabled([OWNER]))).toBe(false);
  });

  it('身份不明时拒绝——拿不到 senderId 就不给权限', () => {
    expect(isAdmin(undefined, enabled([OWNER]))).toBe(false);
    expect(isAdmin('', enabled([OWNER]))).toBe(false);
  });

  it('大小写敏感（openid 是大写十六进制，不做模糊匹配）', () => {
    expect(isAdmin(OWNER.toLowerCase(), enabled([OWNER]))).toBe(false);
  });

  it('不做前后缀匹配（防止拿相似 id 混进来）', () => {
    expect(isAdmin(`${OWNER}X`, enabled([OWNER]))).toBe(false);
    expect(isAdmin(OWNER.slice(0, -1), enabled([OWNER]))).toBe(false);
  });

  it('支持多个管理员', () => {
    const two = enabled([OWNER, STRANGER]);
    expect(isAdmin(OWNER, two)).toBe(true);
    expect(isAdmin(STRANGER, two)).toBe(true);
  });
});

describe('hasNoAdminConfigured', () => {
  it('空名单为真', () => {
    expect(hasNoAdminConfigured(enabled([]))).toBe(true);
  });
  it('有名单为假', () => {
    expect(hasNoAdminConfigured(enabled([OWNER]))).toBe(false);
  });
});

describe('buildDenialMessage', () => {
  it('还没配置主人时给出完整配置指引', () => {
    const msg = buildDenialMessage(enabled([]));
    expect(msg).toContain('/whoami');
    expect(msg).toContain('admin.openids');
  });

  it('已配置但不是主人时只给一句拒绝（不泄露配置细节）', () => {
    const msg = buildDenialMessage(enabled([OWNER]));
    expect(msg).toContain('只有主人');
    expect(msg).not.toContain('admin.openids');
  });
});

describe('buildIdentityMessage', () => {
  const base = { senderId: OWNER, senderName: 'bluechonk', isGroup: true };

  it('总是带上 openid（主人靠它完成配置）', () => {
    expect(buildIdentityMessage({ ...base, admin: enabled([]) })).toContain(OWNER);
  });

  it('名单为空时提示怎么成为主人', () => {
    const msg = buildIdentityMessage({ ...base, admin: enabled([]) });
    expect(msg).toContain('admin.openids');
  });

  it('是主人时标明权限', () => {
    const msg = buildIdentityMessage({ ...base, admin: enabled([OWNER]) });
    expect(msg).toContain('主人');
  });

  it('不是主人时标明普通群友，且不再重复配置指引', () => {
    const msg = buildIdentityMessage({ ...base, admin: enabled([STRANGER]) });
    expect(msg).toContain('普通群友');
    expect(msg).not.toContain('admin.openids');
  });

  it('功能关闭时明确说明', () => {
    const msg = buildIdentityMessage({ ...base, admin: disabled });
    expect(msg).toContain('已关闭');
  });

  it('私聊会标明会话类型', () => {
    expect(buildIdentityMessage({ ...base, admin: enabled([]), isGroup: false }))
      .toContain('私聊');
  });
});
