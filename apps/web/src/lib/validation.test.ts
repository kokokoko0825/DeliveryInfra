import { describe, expect, it } from 'vitest';
import { DisplayNameSchema, SLIDE_MAX_BYTES } from '@delivery/shared';
import { checkComment, chunk, classifyEmails, EmailSchema, parseCsv, parseEmailCsv, parseEmailList, PasswordSchema, validateSlideFile } from './validation';

const pdf = (overrides: Partial<{ name: string; size: number; type: string }> = {}) => ({ name: 'deck.pdf', size: 1024, type: 'application/pdf', ...overrides });

describe('validateSlideFile', () => {
  it('accepts a PDF at exactly 50MB and rejects 50MB + 1 byte', () => {
    expect(validateSlideFile(pdf({ size: SLIDE_MAX_BYTES }))).toBeNull();
    expect(validateSlideFile(pdf({ size: SLIDE_MAX_BYTES + 1 }))).toBe('ファイルサイズは 50MB 以下にしてください');
    expect(validateSlideFile(pdf({ size: SLIDE_MAX_BYTES - 1 }))).toBeNull();
  });
  it('rejects empty files but accepts 1 byte', () => {
    expect(validateSlideFile(pdf({ size: 0 }))).toBe('空のファイルはアップロードできません');
    expect(validateSlideFile(pdf({ size: 1 }))).toBeNull();
  });
  it('rejects extension / MIME mismatches', () => {
    expect(validateSlideFile(pdf({ name: 'deck.pptx' }))).toBe('拡張子が .pdf のファイルを選択してください');
    expect(validateSlideFile(pdf({ name: 'deck.pdf.exe', type: 'application/pdf' }))).toBe('拡張子が .pdf のファイルを選択してください');
    expect(validateSlideFile(pdf({ type: 'application/octet-stream' }))).toBe('PDF ファイル（application/pdf）を選択してください');
    expect(validateSlideFile(pdf({ type: '' }))).toBe('PDF ファイル（application/pdf）を選択してください');
  });
  it('accepts upper-case extensions', () => {
    expect(validateSlideFile(pdf({ name: 'DECK.PDF' }))).toBeNull();
  });
});

describe('checkComment', () => {
  it('accepts 1 and 200 characters, rejects 0 and 201', () => {
    expect(checkComment('a', null, 0)).toEqual({ ok: true, content: 'a' });
    expect(checkComment('a'.repeat(200), null, 0)).toEqual({ ok: true, content: 'a'.repeat(200) });
    expect(checkComment('a'.repeat(201), null, 0)).toEqual({ ok: false, reason: 'too_long', message: '200文字以内で入力してください' });
    expect(checkComment('', null, 0)).toEqual({ ok: false, reason: 'empty', message: 'コメントを入力してください' });
    expect(checkComment('   ', null, 0)).toMatchObject({ ok: false, reason: 'empty' });
  });
  it('trims surrounding whitespace before counting', () => {
    expect(checkComment(`  ${'a'.repeat(200)}  `, null, 0)).toEqual({ ok: true, content: 'a'.repeat(200) });
  });
  it('limits sending to once per 3 seconds', () => {
    expect(checkComment('hi', 1000, 3999)).toEqual({ ok: false, reason: 'rate_limited', message: '連投はできません。1秒後に送信できます' });
    expect(checkComment('hi', 1000, 1000)).toEqual({ ok: false, reason: 'rate_limited', message: '連投はできません。3秒後に送信できます' });
    expect(checkComment('hi', 1000, 2001)).toMatchObject({ message: '連投はできません。2秒後に送信できます' });
    expect(checkComment('hi', 1000, 4000)).toEqual({ ok: true, content: 'hi' });
  });
});

describe('DisplayNameSchema (shared) boundaries used by C-03', () => {
  it('accepts 1 and 20 characters, rejects 0 and 21', () => {
    expect(DisplayNameSchema.safeParse('').success).toBe(false);
    expect(DisplayNameSchema.safeParse('あ').success).toBe(true);
    expect(DisplayNameSchema.safeParse('あ'.repeat(20)).success).toBe(true);
    expect(DisplayNameSchema.safeParse('あ'.repeat(21)).success).toBe(false);
  });
});

describe('PasswordSchema', () => {
  it('requires 12+ characters with upper, lower and digit', () => {
    expect(PasswordSchema.safeParse('Abcdefghij12').success).toBe(true);
    expect(PasswordSchema.safeParse('Abcdefghi12').error?.issues[0]?.message).toBe('12文字以上で入力してください');
    expect(PasswordSchema.safeParse('abcdefghij12').error?.issues[0]?.message).toBe('英大文字を含めてください');
    expect(PasswordSchema.safeParse('ABCDEFGHIJ12').error?.issues[0]?.message).toBe('英小文字を含めてください');
    expect(PasswordSchema.safeParse('Abcdefghijkl').error?.issues[0]?.message).toBe('数字を含めてください');
  });
});

describe('email parsing', () => {
  it('validates email format', () => {
    expect(EmailSchema.safeParse('a@example.com').success).toBe(true);
    expect(EmailSchema.safeParse(' a@example.com ').data).toBe('a@example.com');
    expect(EmailSchema.safeParse('a@').error?.issues[0]?.message).toBe('メールアドレスの形式が正しくありません');
  });
  it('splits by newline, comma, semicolon and spaces, dedupes case-insensitively', () => {
    expect(parseEmailList('a@example.com, b@example.com\nA@example.com;c@example.com d@example.com\n\nbad')).toEqual({
      emails: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'],
      invalid: ['bad'],
    });
    expect(parseEmailList('')).toEqual({ emails: [], invalid: [] });
  });
  it('dedupes invalid entries too', () => {
    expect(classifyEmails(['x', 'x', ' '])).toEqual({ emails: [], invalid: ['x'] });
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF, BOM and blank lines', () => {
    expect(parseCsv('﻿name,email\r\n"Tanaka, K","a@example.com"\r\n\r\n"say ""hi""",b@example.com')).toEqual([
      ['name', 'email'], ['Tanaka, K', 'a@example.com'], ['say "hi"', 'b@example.com'],
    ]);
  });
  it('keeps the last row without a trailing newline and supports LF / CR only', () => {
    expect(parseCsv('a\nb')).toEqual([['a'], ['b']]);
    expect(parseCsv('a\rb\n')).toEqual([['a'], ['b']]);
    expect(parseCsv('a,')).toEqual([['a', '']]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv(' , \n')).toEqual([]);
  });
  it('keeps newlines inside quoted cells', () => {
    expect(parseCsv('"line1\nline2",x')).toEqual([['line1\nline2', 'x']]);
  });
});

describe('parseEmailCsv', () => {
  it('uses the email column when a header exists', () => {
    expect(parseEmailCsv('名前,メールアドレス\nたなか,a@example.com\nすずき,oops')).toEqual({ emails: ['a@example.com'], invalid: ['oops'] });
    expect(parseEmailCsv('Name,E-Mail\nx,b@example.com')).toEqual({ emails: ['b@example.com'], invalid: [] });
    expect(parseEmailCsv(' email \n c@example.com ')).toEqual({ emails: ['c@example.com'], invalid: [] });
  });
  it('uses the first column without a header', () => {
    expect(parseEmailCsv('a@example.com,たなか\nb@example.com')).toEqual({ emails: ['a@example.com', 'b@example.com'], invalid: [] });
  });
  it('treats missing cells as empty and handles empty files', () => {
    expect(parseEmailCsv('name,email\nonly-name')).toEqual({ emails: [], invalid: [] });
    expect(parseEmailCsv('')).toEqual({ emails: [], invalid: [] });
  });
});

describe('chunk', () => {
  it('splits into fixed-size batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
    expect(chunk([1, 2], 2)).toEqual([[1, 2]]);
  });
});
