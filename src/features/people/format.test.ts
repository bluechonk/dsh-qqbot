/**
 * 群友档案 — 纯逻辑测试
 *
 * 这套逻辑零 token、零依赖，全靠启发式，所以「宁缺毋滥」是核心：
 * 认错称呼比不认更尴尬。
 */
import { describe, expect, it } from 'vitest';
import { buildProfileLine, extractAlias, type PersonProfile } from './format.ts';

describe('extractAlias', () => {
  it('认出「叫我X」', () => {
    expect(extractAlias('叫我老王就行')).toBe('老王');
    expect(extractAlias('你可以叫我鲸鱼')).toBe('鲸鱼');
  });

  it('认出「我是X」/「我叫X」/「喊我X」', () => {
    expect(extractAlias('我是小明')).toBe('小明');
    expect(extractAlias('我叫阿伟')).toBe('阿伟');
    expect(extractAlias('喊我老张')).toBe('老张');
  });

  it('「我是说…」这类不算自我介绍', () => {
    expect(extractAlias('我是说你搞错了')).toBeUndefined();
    expect(extractAlias('我是真的服了')).toBeUndefined();
  });

  it('普通聊天不误抽', () => {
    expect(extractAlias('今天天气不错')).toBeUndefined();
    expect(extractAlias('')).toBeUndefined();
  });

  it('超长正文不抽（多半不是自我介绍）', () => {
    expect(extractAlias(`叫我${'很长的名字'.repeat(40)}`)).toBeUndefined();
  });

  it('纯标点/表情不当别名', () => {
    expect(extractAlias('叫我！！！')).toBeUndefined();
  });
});

function profile(overrides: Partial<PersonProfile> = {}): PersonProfile {
  return {
    openid: 'u1',
    name: 'bluechonk',
    aliases: [],
    count: 1,
    firstSeen: 0,
    lastSeen: 0,
    ...overrides,
  };
}

describe('buildProfileLine', () => {
  it('没有档案时不注入', () => {
    expect(buildProfileLine(undefined, { isGroup: true })).toBe('');
  });

  it('只有一个昵称时也会提到', () => {
    expect(buildProfileLine(profile(), { isGroup: true })).toContain('bluechonk');
  });

  it('优先用别名而不是昵称', () => {
    const line = buildProfileLine(profile({ aliases: ['老王'] }), { isGroup: true });
    expect(line).toContain('老王');
  });

  it('别名最多带到 maxAliases 个，取最近的', () => {
    const line = buildProfileLine(
      profile({ aliases: ['a', 'b', 'c', 'd'] }),
      { isGroup: true, maxAliases: 1 },
    );
    expect(line).toContain('d');
    expect(line).not.toContain('a');
  });

  it('互动次数够多才提「聊过几次」', () => {
    expect(buildProfileLine(profile({ count: 2 }), { isGroup: true })).not.toContain('聊过');
    expect(buildProfileLine(profile({ count: 5 }), { isGroup: true })).toContain('5 次');
  });

  it('私聊里熟人才显得更亲近，群里不显摆', () => {
    const familiar = profile({ count: 5 });
    expect(buildProfileLine(familiar, { isGroup: false })).toContain('熟人');
    expect(buildProfileLine(familiar, { isGroup: true })).not.toContain('熟人');
  });

  it('信息不足时不硬凑（空别名且无昵称）', () => {
    expect(buildProfileLine(profile({ name: undefined }), { isGroup: true })).toBe('');
  });
});
