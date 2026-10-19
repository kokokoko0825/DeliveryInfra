import { z } from 'zod';
import { COMMENT_MAX, COMMENT_RATE_LIMIT_MS, SLIDE_MAX_BYTES } from '@delivery/shared';

export const PASSWORD_MIN = 12;
export const PasswordSchema = z.string()
  .min(PASSWORD_MIN, `${PASSWORD_MIN}文字以上で入力してください`)
  .regex(/[A-Z]/, '英大文字を含めてください')
  .regex(/[a-z]/, '英小文字を含めてください')
  .regex(/[0-9]/, '数字を含めてください');
export const EmailSchema = z.string().trim().email('メールアドレスの形式が正しくありません');

export type FileLike = { name: string; size: number; type: string };

/** スライド PDF のクライアント側検証。問題なければ null。 */
export function validateSlideFile(file: FileLike): string | null {
  if (!file.name.toLowerCase().endsWith('.pdf')) return '拡張子が .pdf のファイルを選択してください';
  if (file.type !== 'application/pdf') return 'PDF ファイル（application/pdf）を選択してください';
  if (file.size < 1) return '空のファイルはアップロードできません';
  if (file.size > SLIDE_MAX_BYTES) return 'ファイルサイズは 50MB 以下にしてください';
  return null;
}

export type CommentCheck = { ok: true; content: string } | { ok: false; reason: 'empty' | 'too_long' | 'rate_limited'; message: string };

/** コメント送信前の検証（1〜200文字、3秒に1回）。 */
export function checkComment(text: string, lastSentAt: number | null, now: number): CommentCheck {
  const content = text.trim();
  if (content.length === 0) return { ok: false, reason: 'empty', message: 'コメントを入力してください' };
  if (content.length > COMMENT_MAX) return { ok: false, reason: 'too_long', message: `${COMMENT_MAX}文字以内で入力してください` };
  if (lastSentAt !== null && now - lastSentAt < COMMENT_RATE_LIMIT_MS) {
    const seconds = Math.ceil((COMMENT_RATE_LIMIT_MS - (now - lastSentAt)) / 1000);
    return { ok: false, reason: 'rate_limited', message: `連投はできません。${seconds}秒後に送信できます` };
  }
  return { ok: true, content };
}

export type EmailList = { emails: string[]; invalid: string[] };

/** カンマ・改行・空白・セミコロン区切りのメールアドレスを重複除去して分類する。 */
export function parseEmailList(text: string): EmailList {
  return classifyEmails(text.split(/[\s,;]+/));
}

export function classifyEmails(values: readonly string[]): EmailList {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (EmailSchema.safeParse(value).success ? emails : invalid).push(value);
  }
  return { emails, invalid };
}

/** RFC 4180 相当の最小 CSV パーサー（ダブルクォートと "" エスケープに対応）。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((value) => value.trim() !== ''));
}

const EMAIL_HEADERS = ['email', 'e-mail', 'mail', 'メールアドレス', 'メール'];

/** CSV からメールアドレス列を取り出す。見出し行に email 列があればその列、なければ1列目。 */
export function parseEmailCsv(text: string): EmailList {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((value) => value.trim().toLowerCase());
  const column = header.findIndex((value) => EMAIL_HEADERS.includes(value));
  const body = column >= 0 ? rows.slice(1) : rows;
  return classifyEmails(body.map((r) => r[Math.max(column, 0)] ?? ''));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}
