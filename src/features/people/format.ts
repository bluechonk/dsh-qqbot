/**
 * 群友档案 — 纯逻辑部分
 *
 * 两件事：
 *   1. 从消息正文里认出「这个人希望被怎么称呼」（自我介绍句式）
 *   2. 把档案渲染成一小段注入给模型的提示
 *
 * 全在这里做成纯函数，是为了零成本、可测试：
 * qqchat 预设是**零工具**的，模型没法主动调用「记住他」这类工具，
 * 所以档案的积累只能靠本地启发式，不能靠模型。
 */

import type { PersonMemory } from './memory.ts';

/** 单个群友的档案 */
export interface PersonProfile {
  /** 用户 openid */
  openid: string;
  /** 最近一次看到的昵称（来自消息信封） */
  name?: string;
  /** 别名/希望被怎么称呼（来自自我介绍句式） */
  aliases: string[];
  /** 互动次数（用于判断亲疏） */
  count: number;
  /** 首次见到的时间戳（ms） */
  firstSeen: number;
  /** 最近一次见到的时间戳（ms） */
  lastSeen: number;
  /** 长期记忆（可选，老档案没有这个字段照常工作） */
  memory?: PersonMemory;
}

/** 自我介绍句式 → 提取别名 */
const ALIAS_PATTERNS: readonly RegExp[] = [
  /(?:你可以|可以|就)?叫我\s*([^\s，。！？、,.!?]{1,12})/,
  /我是\s*([^\s，。！？、,.!?]{1,12})/,
  /我叫\s*([^\s，。！？、,.!?]{1,12})/,
  /喊我\s*([^\s，。！？、,.!?]{1,12})/,
];

/** 别名尾部的语气词/填充词，抽到就得剥掉（「叫我老王就行」→「老王」） */
const TRAILING_FILLER = /(就行|就好|好了|也可以|都行|吧|啊|呀|哦|啦|呢|嘛|哈)+$/;

/** 明显不是名字的常见词（避免把「我是说…」当成自我介绍） */
const NOT_A_NAME = new Set([
  '说', '想', '觉得', '不是', '真的', '那种', '一个', '你的', '他的',
  '新人', '小白', '学生', '程序员', '在', '刚', '来', '走', '好', '坏',
]);

/**
 * 以这些字开头的一律不当别名。
 *
 * 「我是说你搞错了」捕获到「说你搞错了」，靠整词白名单拦不住，
 * 必须看首字——这类句子在群里极常见。
 */
const BAD_PREFIX = /^[说想觉认看听问讲搞弄做干得是不没别还真太很好在刚又再就都也还]/;

/** 别名长度上限（中文名 2~4 字，英文名略长，给到 8） */
const MAX_ALIAS_LENGTH = 8;

/**
 * 从正文里提取「希望被怎么称呼」。
 *
 * 只在明显是自我介绍时才返回，宁缺毋滥：
 * 认错称呼比不认更尴尬（「我是说你搞错了」不该被记成别名「说你搞错了」）。
 */
export function extractAlias(text: string): string | undefined {
  const body = String(text ?? '').trim();
  if (!body || body.length > 200) return undefined;

  for (const pattern of ALIAS_PATTERNS) {
    const matched = pattern.exec(body);
    let candidate = matched?.[1]?.trim();
    if (!candidate) continue;

    // 剥语气词后再校验（「老王就行」→「老王」）
    candidate = candidate.replace(TRAILING_FILLER, '').trim();
    if (candidate.length < 1) continue;
    if (candidate.length > MAX_ALIAS_LENGTH) continue;
    if (NOT_A_NAME.has(candidate)) continue;
    if (BAD_PREFIX.test(candidate)) continue;
    // 纯标点/表情不算名字
    if (!/[一-龥a-zA-Z0-9]/.test(candidate)) continue;
    return candidate;
  }
  return undefined;
}

/** 渲染档案时要用的上下文（决定说多少） */
export interface ProfileRenderOptions {
  /** 群聊还是私聊（群聊里少透露一点，别像查户口） */
  isGroup: boolean;
  /** 最多带几个别名（默认 2，多了像背资料） */
  maxAliases?: number;
}

/**
 * 把档案渲染成一段注入提示。
 *
 * 返回空串表示「没什么可说的」（首次见面、信息太少），调用方据此跳过注入。
 * 刻意写得像旁白而不是表格——表格会让模型开始复述资料。
 */
export function buildProfileLine(
  profile: PersonProfile | undefined,
  options: ProfileRenderOptions,
): string {
  if (profile === undefined) return '';

  const maxAliases = options.maxAliases ?? 2;
  const aliases = profile.aliases.slice(-maxAliases).filter((a) => a !== profile.name);
  const callAs = aliases.length > 0 ? aliases[aliases.length - 1] : profile.name;

  const parts: string[] = [];
  if (callAs) parts.push(`他叫${callAs}`);
  if (profile.count >= 3) parts.push(`你们聊过 ${profile.count} 次`);

  // 私聊可以更亲近一点；群里别显摆「我记得你」
  if (!options.isGroup && profile.count >= 3) parts.push('算是熟人了');

  if (parts.length === 0) return '';
  return `【群友档案】${parts.join('，')}。\n`;
}
