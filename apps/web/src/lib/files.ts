import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';

/** 署名付き Cookie の有効期限は 1 時間。余裕を持って 50 分で再取得する。 */
export const COOKIE_REFRESH_MS = 50 * 60 * 1000;
/** Cookie はパスごとに別（スライド全体 / アーカイブ1件ごと。Review-1 R1-08）なので、発行 API ごとに管理する。 */
const issuedAt = new Map<string, number>();
const pending = new Map<string, Promise<void>>();

export const SLIDE_COOKIES_PATH = '/files/cookies';
export const archiveCookiesPath = (archiveId: string) => `/archives/${encodeURIComponent(archiveId)}/cookies`;

/** CloudFront 署名付き Cookie を必要なら取得する。path は発行 API（/api からの相対）。 */
export function ensureFileCookies(path: string, now: () => number = Date.now): Promise<void> {
  const issued = issuedAt.get(path);
  if (issued !== undefined && now() - issued < COOKIE_REFRESH_MS) return Promise.resolve();
  let request = pending.get(path);
  if (!request) {
    request = apiFetch(path, { method: 'POST', credentials: 'same-origin' })
      .then(() => { issuedAt.set(path, now()); })
      .finally(() => { pending.delete(path); });
    pending.set(path, request);
  }
  return request;
}

export const resetFileCookies = () => { issuedAt.clear(); pending.clear(); };
export const slideFileUrl = (slideId: string) => `/files/slides/${encodeURIComponent(slideId)}.pdf`;

/** 画面表示中は署名付き Cookie を維持する（期限前に再取得）。 */
export const useFileCookies = (path: string) =>
  useQuery({ queryKey: ['files', 'cookies', path], queryFn: () => ensureFileCookies(path).then(() => true), refetchInterval: COOKIE_REFRESH_MS });
