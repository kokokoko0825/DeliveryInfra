import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './api';

/** 署名付き Cookie の有効期限は 1 時間。余裕を持って 50 分で再取得する。 */
export const COOKIE_REFRESH_MS = 50 * 60 * 1000;
let issuedAt: number | null = null;
let pending: Promise<void> | null = null;

/** /files/* を読むための CloudFront 署名付き Cookie を必要なら取得する。 */
export function ensureFileCookies(now: () => number = Date.now): Promise<void> {
  if (issuedAt !== null && now() - issuedAt < COOKIE_REFRESH_MS) return Promise.resolve();
  pending ??= apiFetch('/files/cookies', { method: 'POST', credentials: 'same-origin' })
    .then(() => { issuedAt = now(); })
    .finally(() => { pending = null; });
  return pending;
}

export const resetFileCookies = () => { issuedAt = null; pending = null; };
export const slideFileUrl = (slideId: string) => `/files/slides/${encodeURIComponent(slideId)}.pdf`;

/** 画面表示中は署名付き Cookie を維持する（期限前に再取得）。 */
export const useFileCookies = () =>
  useQuery({ queryKey: ['files', 'cookies'], queryFn: () => ensureFileCookies().then(() => true), refetchInterval: COOKIE_REFRESH_MS });
