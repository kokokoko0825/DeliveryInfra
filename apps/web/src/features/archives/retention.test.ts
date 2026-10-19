import { describe, expect, it } from 'vitest';
import { endOfJstDay, retainUntilFormSchema, toJstDate } from './retention';

describe('retention helpers (R1-22)', () => {
  it('converts between ISO datetimes and JST dates', () => {
    expect(toJstDate('2027-10-18T15:00:00.000Z')).toBe('2027-10-19');
    expect(toJstDate('2027-10-18T14:59:59.999Z')).toBe('2027-10-18');
    expect(endOfJstDay('2027-10-19')).toBe('2027-10-19T14:59:59.000Z');
  });
  it('accepts only dates after the current retention date', () => {
    const schema = retainUntilFormSchema('2027-10-19T14:59:59.000Z');
    expect(schema.safeParse({ date: '2027-10-20' }).success).toBe(true);
    expect(schema.safeParse({ date: '2027-10-19' }).error?.issues[0]?.message).toBe('2027/10/19 より後の日付を選択してください');
    expect(schema.safeParse({ date: '' }).error?.issues[0]?.message).toBe('日付を選択してください');
  });
});
