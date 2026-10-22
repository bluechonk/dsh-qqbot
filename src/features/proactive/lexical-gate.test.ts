import { describe, expect, it } from 'vitest';
import { evaluateLexical, stripMentions } from './lexical-gate.ts';

const OPTS = { minLength: 6, minScore: 0.55 };

describe('stripMentions', () => {
  it('剥掉 QQ 原生 mention 标记', () => {
    expect(stripMentions('<@!1234567890> 在吗')).toBe('在吗');
  });

  it('剥掉 openid 形式的 mention', () => {
    expect(stripMentions('<@49C7A1D43E0018DF6F5E9DAB9C823E28> 大家好')).toBe('大家好');
  });

  it('剥掉 @某人 形式', () => {
    expect(stripMentions('@bluechonk 今天怎么样')).toBe('今天怎么样');
  });

  it('没有 mention 时原样返回（压缩空白）', () => {
    expect(stripMentions('  今天   天气不错 ')).toBe('今天 天气不错');
  });
});

describe('evaluateLexical', () => {
  it('空消息不值得', () => {
    const v = evaluateLexical({ text: '', mentioned: false, mentionedOthers: false }, OPTS);
    expect(v?.worth).toBe(false);
    expect(v?.reason).toBe('empty');
  });

  it('过短的文本不值得', () => {
    const v = evaluateLexical({ text: '嗯', mentioned: false, mentionedOthers: false }, OPTS);
    expect(v?.worth).toBe(false);
    expect(v?.reason).toContain('too-short');
  });

  it('纯表情/符号不值得', () => {
    const v = evaluateLexical({ text: '！！！？？？', mentioned: false, mentionedOthers: false }, OPTS);
    expect(v?.worth).toBe(false);
    expect(v?.reason).toBe('symbols-only');
  });

  it('疑问句值得接话', () => {
    const v = evaluateLexical({ text: '有人知道这个怎么配吗', mentioned: false, mentionedOthers: false }, OPTS);
    expect(v?.worth).toBe(true);
    expect(v?.reason).toContain('question');
  });

  it('求助词值得接话', () => {
    const v = evaluateLexical({ text: '谁能帮我看一下这个报错', mentioned: false, mentionedOthers: false }, OPTS);
    expect(v?.worth).toBe(true);
    expect(v?.reason).toContain('help');
  });

  it('提到本鲸值得接话', () => {
    const v = evaluateLexical({ text: '大肥鱼你还在吗', mentioned: false, mentionedOthers: false }, OPTS);
    expect(v?.worth).toBe(true);
    expect(v?.reason).toContain('self-name');
  });

  it('灌水噪声不值得', () => {
    const v = evaluateLexical({ text: '哈哈哈哈哈笑死我了', mentioned: false, mentionedOthers: false }, OPTS);
    expect(v?.worth).toBe(false);
    expect(v?.reason).toContain('noise');
  });

  it('@了别人要扣分（该轮对话的方向是别人）', () => {
    const plain = evaluateLexical({ text: '这个报错怎么解决啊', mentioned: false, mentionedOthers: false }, OPTS);
    const others = evaluateLexical({ text: '这个报错怎么解决啊', mentioned: false, mentionedOthers: true }, OPTS);
    expect(plain!.score).toBeGreaterThan(others!.score);
    expect(others!.reason).toContain('mention-others');
  });

  it('「没被 @」本身不扣分（那正是该主动接话的常态）', () => {
    const notMentioned = evaluateLexical({ text: '这个报错怎么解决啊', mentioned: false, mentionedOthers: false }, OPTS);
    const mentioned = evaluateLexical({ text: '这个报错怎么解决啊', mentioned: true, mentionedOthers: false }, OPTS);
    expect(notMentioned!.score).toBe(mentioned!.score);
  });

  it('分数恒在 0~1 之间', () => {
    const high = evaluateLexical({ text: '有没有人知道这个怎么弄求助', mentioned: false, mentionedOthers: false }, OPTS);
    const low = evaluateLexical({ text: '哈哈哈哈哈草', mentioned: false, mentionedOthers: false }, OPTS);
    expect(high!.score).toBeLessThanOrEqual(1);
    expect(low!.score).toBeGreaterThanOrEqual(0);
  });
});
