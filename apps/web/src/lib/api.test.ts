import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('apiFetch', () => {
  it('adds the auth token, hashes a JSON body, and validates the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ viewerCount: 2 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await apiFetch('/broadcast/stats', { method: 'POST', token: 'token', body: { ok: true }, schema: { parse: (v) => v as { viewerCount: number } } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/broadcast/stats');
    expect(new Headers(init.headers).get('X-Auth-Token')).toBe('token');
    expect(new Headers(init.headers).get('x-amz-content-sha256')).toMatch(/^[a-f0-9]{64}$/);
    expect(result).toEqual({ viewerCount: 2 });
  });
  it('parses the shared API error shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'DENIED', message: '拒否' } }), { status: 403 })));
    await expect(apiFetch('/private')).rejects.toThrow('DENIED: 拒否');
  });
  it('rejects invalid successful payloads through the supplied schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"viewerCount":-1}', { status: 200 })));
    await expect(apiFetch('/stats', { schema: { parse: (v) => { if ((v as { viewerCount: number }).viewerCount < 0) throw new Error('invalid'); return v; } } })).rejects.toThrow('invalid');
  });
});
