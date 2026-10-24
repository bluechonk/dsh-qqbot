/**
 * 作息（quiet hours）判定测试
 */
import { describe, expect, it } from 'vitest';
import { isQuietHours, isQuietNow, QUIET_HINT_LINE } from './quiet-hours.ts';

function at(hour: number, minute = 0): Date {
  return new Date(2026, 9, 24, hour, minute, 0, 0);
}

describe('isQuietHours', () => {
  it('同天区间内为安静时段', () => {
    expect(isQuietHours(at(22, 30), '22:00', '23:00')).toBe(true);
    expect(isQuietHours(at(23, 30), '22:00', '23:00')).toBe(false);
  });

  it('跨天区间：夜间算、白天不算', () => {
    expect(isQuietHours(at(23), '22:00', '07:00')).toBe(true);
    expect(isQuietHours(at(6, 59), '22:00', '07:00')).toBe(true);
    expect(isQuietHours(at(7), '22:00', '07:00')).toBe(false);
    expect(isQuietHours(at(12), '22:00', '07:00')).toBe(false);
  });

  it('边界：起点含、终点不含', () => {
    expect(isQuietHours(at(22), '22:00', '07:00')).toBe(true);
    expect(isQuietHours(at(7), '22:00', '07:00')).toBe(false);
  });

  it('起止相同 → 全天安静', () => {
    expect(isQuietHours(at(3), '22:00', '22:00')).toBe(true);
    expect(isQuietHours(at(15), '22:00', '22:00')).toBe(true);
  });

  it('非法配置一律视为非安静时段（不静默失效，也不误伤）', () => {
    expect(isQuietHours(at(23), '', '07:00')).toBe(false);
    expect(isQuietHours(at(23), '22:00', '7点')).toBe(false);
    expect(isQuietHours(at(23), '25:00', '07:00')).toBe(false);
    expect(isQuietHours(at(23), '22:60', '07:00')).toBe(false);
  });
});

describe('isQuietNow', () => {
  it('配置未启用时恒为 false', () => {
    expect(isQuietNow(false, '22:00', '07:00', at(23))).toBe(false);
  });
});

describe('QUIET_HINT_LINE', () => {
  it('提示行非空且以换行收尾（便于与其他旁白拼接）', () => {
    expect(QUIET_HINT_LINE).toContain('深夜模式');
    expect(QUIET_HINT_LINE.endsWith('\n')).toBe(true);
  });
});
