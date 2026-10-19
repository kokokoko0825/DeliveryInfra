import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dateStamp, formatBytes, formatDateTime, formatDuration, formatTime } from './format';
import { moveItem } from './list';
import { backoffMs } from './retry';
import { saveBlob } from './download';
import { jaErrorMap } from './zod-ja';

describe('format', () => {
  it('formats bytes', () => {
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50.0 MB');
  });
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(59.9)).toBe('0:59');
    expect(formatDuration(61)).toBe('1:01');
    expect(formatDuration(3599)).toBe('59:59');
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3 * 3600 + 5 * 60 + 7)).toBe('3:05:07');
  });
  it('formats dates in Asia/Tokyo', () => {
    expect(formatTime('2026-10-19T00:05:00Z')).toBe('09:05');
    expect(formatDateTime('2026-10-19T00:05:00Z')).toContain('2026');
    expect(dateStamp(new Date('2026-10-19T12:00:00Z'))).toBe('20261019');
  });
});

describe('moveItem', () => {
  it('moves up and down', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });
  it('returns the same array when out of range', () => {
    const items = ['a', 'b'];
    expect(moveItem(items, 0, -1)).toBe(items);
    expect(moveItem(items, 1, 1)).toBe(items);
    expect(moveItem(items, -1, 1)).toBe(items);
    expect(moveItem(items, 2, -1)).toBe(items);
  });
});

describe('backoffMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(4)).toBe(16000);
    expect(backoffMs(5)).toBe(30000);
    expect(backoffMs(20)).toBe(30000);
  });
});

describe('saveBlob', () => {
  afterEach(() => vi.restoreAllMocks());
  it('downloads via a temporary object URL', () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const blob = new Blob(['x']);
    saveBlob(blob, 'a.csv');
    expect(create).toHaveBeenCalledWith(blob);
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('a.csv');
    expect(anchor.href).toBe('blob:x');
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });
});

describe('jaErrorMap', () => {
  const message = (schema: z.ZodTypeAny, value: unknown) => schema.safeParse(value, { errorMap: jaErrorMap }).error?.issues[0]?.message;
  it('translates string length errors', () => {
    expect(message(z.string().min(1), '')).toBe('入力してください');
    expect(message(z.string().min(3), 'a')).toBe('3文字以上で入力してください');
    expect(message(z.string().max(2), 'abc')).toBe('2文字以内で入力してください');
  });
  it('translates array and format errors', () => {
    expect(message(z.array(z.string()).min(1), [])).toBe('1件以上指定してください');
    expect(message(z.array(z.string()).max(1), ['a', 'b'])).toBe('1件以内にしてください');
    expect(message(z.string().email(), 'x')).toBe('メールアドレスの形式が正しくありません');
    expect(message(z.string().url(), 'x')).toBe('入力形式が正しくありません');
  });
  it('falls back to the default message', () => {
    expect(message(z.number(), 'x')).toBe('Expected number, received string');
    expect(message(z.number().min(2), 1)).toBe('Number must be greater than or equal to 2');
    expect(message(z.number().max(2), 3)).toBe('Number must be less than or equal to 2');
  });
});
