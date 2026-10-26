import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, errorMessage, setTokenProvider, setUnauthorizedHandler } from './api';
import { clearClientDiagnostics, listClientDiagnostics } from './diagnostics';

afterEach(() => {
  clearClientDiagnostics();
  vi.unstubAllGlobals();
  setTokenProvider(undefined);
  setUnauthorizedHandler(undefined);
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const headerOf = (fetchMock: ReturnType<typeof vi.fn>, index: number, name: string) =>
  new Headers((fetchMock.mock.calls[index]?.[1] as RequestInit).headers).get(name);

describe('apiFetch', () => {
  it('adds the auth token, hashes a JSON body, and validates the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ viewerCount: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await apiFetch('/broadcast/stats', { method: 'POST', token: 'token', body: { ok: true }, schema: { parse: (v) => v as { viewerCount: number } } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/broadcast/stats');
    expect(init.body).toBe('{"ok":true}');
    expect(headerOf(fetchMock, 0, 'X-Auth-Token')).toBe('token');
    expect(headerOf(fetchMock, 0, 'Content-Type')).toBe('application/json');
    // sha256('{"ok":true}')
    expect(headerOf(fetchMock, 0, 'x-amz-content-sha256')).toBe('4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93');
    expect(result).toEqual({ viewerCount: 2 });
  });
  it('hashes an empty body for mutating requests without body and skips it for GET', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/x', { method: 'delete' });
    await apiFetch('/x');
    expect(headerOf(fetchMock, 0, 'x-amz-content-sha256')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(headerOf(fetchMock, 0, 'Content-Type')).toBeNull();
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBeUndefined();
    expect(headerOf(fetchMock, 1, 'x-amz-content-sha256')).toBeNull();
    expect(headerOf(fetchMock, 1, 'X-Auth-Token')).toBeNull();
  });
  it('parses the shared API error shape into ApiError', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'DENIED', message: '拒否' }, requestId: 'req-1' }), { status: 403, headers: { 'x-request-id': 'req-1' } })));
    const error = await apiFetch('/private').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'DENIED', detail: '拒否', requestId: 'req-1', message: 'DENIED: 拒否' });
    expect(listClientDiagnostics()).toMatchObject([{ source: 'apiFetch', message: 'DENIED: 拒否', context: { endpoint: '/private', status: 403, code: 'DENIED', requestId: 'req-1' } }]);
  });
  it('falls back to a generic error for non-JSON or unknown errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oops', { status: 502 })));
    await expect(apiFetch('/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR', detail: 'API エラー (502)' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    await expect(apiFetch('/x')).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  });
  it('rejects invalid JSON and invalid payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{bad', { status: 200 })));
    await expect(apiFetch('/x')).rejects.toThrow('API から不正な応答が返されました');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"viewerCount":-1}', { status: 200 })));
    await expect(apiFetch('/stats', { schema: { parse: (v) => { if ((v as { viewerCount: number }).viewerCount < 0) throw new Error('invalid'); return v; } } })).rejects.toThrow('invalid');
  });
  it('returns undefined for empty bodies and blobs when requested', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));
    await expect(apiFetch('/x')).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('﻿a,b', { status: 200 })));
    const blob = await apiFetch<Blob>('/csv', { responseType: 'blob' });
    expect(blob.size).toBe(6); // BOM(3 bytes) + 'a,b'
  });
  it('uses the registered token provider', async () => {
    const provider = vi.fn(async () => 'provided');
    setTokenProvider(provider);
    const fetchMock = vi.fn().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/x');
    expect(provider).toHaveBeenCalledWith(false);
    expect(headerOf(fetchMock, 0, 'X-Auth-Token')).toBe('provided');
  });
  it('prefers an explicit token over the provider', async () => {
    const provider = vi.fn(async () => 'provided');
    setTokenProvider(provider);
    const fetchMock = vi.fn().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/x', { token: 'explicit' });
    expect(provider).not.toHaveBeenCalled();
    expect(headerOf(fetchMock, 0, 'X-Auth-Token')).toBe('explicit');
  });
  it('force-refreshes once on 401 TOKEN_REFRESH_REQUIRED and retries', async () => {
    const provider = vi.fn(async (force: boolean) => (force ? 'fresh' : 'stale'));
    setTokenProvider(provider);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'TOKEN_REFRESH_REQUIRED', message: '再取得' } }, 401))
      .mockResolvedValueOnce(json({ ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/me', { method: 'PUT', body: { a: 1 } })).resolves.toEqual({ ok: 1 });
    expect(provider.mock.calls).toEqual([[false], [true]]);
    expect(headerOf(fetchMock, 1, 'X-Auth-Token')).toBe('fresh');
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).body).toBe('{"a":1}');
  });
  it('signals unauthorized when the retry still fails', async () => {
    const onUnauthorized = vi.fn();
    setTokenProvider(async () => 't');
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(json({ error: { code: 'TOKEN_REFRESH_REQUIRED', message: 'x' } }, 401))
      .mockResolvedValueOnce(json({ error: { code: 'UNAUTHORIZED', message: '期限切れ' } }, 401)));
    await expect(apiFetch('/me')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
  it('does not retry other 401s nor signal for non-401 errors', async () => {
    const onUnauthorized = vi.fn();
    setTokenProvider(async () => 't');
    setUnauthorizedHandler(onUnauthorized);
    const fetchMock = vi.fn().mockResolvedValue(json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/me')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { code: 'TOKEN_REFRESH_REQUIRED', message: 'x' } }, 403)));
    await expect(apiFetch('/me')).rejects.toMatchObject({ status: 403 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
  it('does not retry or signal when an explicit token is used', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const fetchMock = vi.fn().mockResolvedValue(json({ error: { code: 'TOKEN_REFRESH_REQUIRED', message: 'x' } }, 401));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/me', { token: 't' })).rejects.toMatchObject({ code: 'TOKEN_REFRESH_REQUIRED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('errorMessage', () => {
  it('maps errors to user-facing messages', () => {
    expect(errorMessage(new ApiError(400, 'NG_WORD', 'NGワードを含みます'))).toBe('NGワードを含みます');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('x')).toBe('予期しないエラーが発生しました');
  });
});
