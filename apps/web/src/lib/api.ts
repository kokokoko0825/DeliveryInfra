import { ApiErrorResponseSchema } from '@delivery/shared';

const apiBase = import.meta.env.VITE_API_BASE_URL ?? '/api';
type FetchOptions<T> = Omit<RequestInit, 'body'> & {
  body?: unknown;
  token?: string;
  schema?: { parse: (value: unknown) => T };
  responseType?: 'json' | 'blob';
};
type TokenProvider = (forceRefresh: boolean) => Promise<string | undefined>;

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ApiError';
  }
}

let tokenProvider: TokenProvider | undefined;
let unauthorizedHandler: (() => void) | undefined;

/** 認証済みリクエストのトークン取得方法を登録する（AuthProvider が設定）。 */
export const setTokenProvider = (provider: TokenProvider | undefined) => { tokenProvider = provider; };
/** トークン再取得後も 401 の場合に呼ばれる（ログイン画面へ戻す）。 */
export const setUnauthorizedHandler = (handler: (() => void) | undefined) => { unauthorizedHandler = handler; };

/** エラーを利用者向けの日本語メッセージにする。 */
export const errorMessage = (error: unknown): string => {
  if (error instanceof ApiError) return error.detail;
  return error instanceof Error ? error.message : '予期しないエラーが発生しました';
};

async function sha256(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function send(path: string, request: RequestInit, headers: HeadersInit | undefined, serialized: string | undefined, token: string | undefined) {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes((request.method ?? 'GET').toUpperCase());
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set('X-Auth-Token', token);
  if (serialized !== undefined) requestHeaders.set('Content-Type', 'application/json');
  if (mutating) requestHeaders.set('x-amz-content-sha256', await sha256(serialized ?? ''));
  const init: RequestInit = { ...request, headers: requestHeaders };
  if (serialized !== undefined) init.body = serialized;
  return fetch(`${apiBase}${path}`, init);
}

async function toApiError(response: Response): Promise<ApiError> {
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  const parsed = ApiErrorResponseSchema.safeParse(data);
  if (parsed.success) return new ApiError(response.status, parsed.data.error.code, parsed.data.error.message);
  return new ApiError(response.status, 'HTTP_ERROR', `API エラー (${response.status})`);
}

export async function apiFetch<T = unknown>(path: string, options: FetchOptions<T> = {}): Promise<T> {
  const { body, token, schema, headers, responseType = 'json', ...request } = options;
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const provided = token === undefined && tokenProvider !== undefined;
  let response = await send(path, request, headers, serialized, provided ? await tokenProvider?.(false) : token);
  if (!response.ok) {
    let error = await toApiError(response);
    if (provided && error.status === 401 && error.code === 'TOKEN_REFRESH_REQUIRED') {
      response = await send(path, request, headers, serialized, await tokenProvider?.(true));
      if (!response.ok) error = await toApiError(response);
    }
    if (!response.ok) {
      if (provided && error.status === 401) unauthorizedHandler?.();
      throw error;
    }
  }
  if (responseType === 'blob') return await response.blob() as T;
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; }
  catch { throw new Error('API から不正な応答が返されました'); }
  return schema ? schema.parse(data) : data as T;
}
