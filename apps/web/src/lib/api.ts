import { ApiErrorResponseSchema } from '@delivery/shared';

const apiBase = import.meta.env.VITE_API_BASE_URL ?? '/api';
type FetchOptions<T> = Omit<RequestInit, 'body'> & { body?: unknown; token?: string; schema?: { parse: (value: unknown) => T } };

async function sha256(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function apiFetch<T = unknown>(path: string, options: FetchOptions<T> = {}): Promise<T> {
  const { body, token, schema, headers, ...request } = options;
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes((request.method ?? 'GET').toUpperCase());
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set('X-Auth-Token', token);
  if (serialized !== undefined) requestHeaders.set('Content-Type', 'application/json');
  if (mutating) {
    requestHeaders.set('x-amz-content-sha256', await sha256(serialized ?? ''));
  }
  const init: RequestInit = { ...request, headers: requestHeaders };
  if (serialized !== undefined) init.body = serialized;
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : undefined; }
  catch { throw new Error('API から不正な応答が返されました'); }
  if (!response.ok) {
    const parsed = ApiErrorResponseSchema.safeParse(data);
    if (parsed.success) throw new Error(`${parsed.data.error.code}: ${parsed.data.error.message}`);
    throw new Error(`API エラー (${response.status})`);
  }
  return schema ? schema.parse(data) : data as T;
}
