import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig, resetRuntimeConfigCache } from './config';
import { ensureFileCookies, resetFileCookies, slideFileUrl, COOKIE_REFRESH_MS } from './files';

const config = { region: 'ap-northeast-1', userPoolId: 'pool', userPoolClientId: 'client' };
afterEach(() => { vi.unstubAllGlobals(); resetRuntimeConfigCache(); resetFileCookies(); });

describe('loadRuntimeConfig', () => {
  it('loads /config.json once and caches it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(config)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadRuntimeConfig()).resolves.toEqual(config);
    await loadRuntimeConfig();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/config.json', { cache: 'no-store' });
  });
  it('accepts optional Okta settings and rejects invalid ones', async () => {
    const oauth = { domain: 'auth.example.com', redirectSignIn: 'https://x.cloudfront.net/', redirectSignOut: 'https://x.cloudfront.net/login', oktaProviderName: 'Okta' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...config, oauth }))));
    await expect(loadRuntimeConfig()).resolves.toEqual({ ...config, oauth });
    resetRuntimeConfigCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...config, oauth: { ...oauth, redirectSignIn: 'nope' } }))));
    await expect(loadRuntimeConfig()).rejects.toThrow();
  });
  it('clears the cache on failure so it can retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(config)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadRuntimeConfig()).rejects.toThrow('設定ファイルを読み込めませんでした');
    await expect(loadRuntimeConfig()).resolves.toEqual(config);
  });
});

describe('ensureFileCookies', () => {
  it('requests cookies once and refreshes after 50 minutes', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('{"success":true}'));
    vi.stubGlobal('fetch', fetchMock);
    let now = 1_000;
    const clock = () => now;
    await Promise.all([ensureFileCookies(clock), ensureFileCookies(clock)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/files/cookies');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit)).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    now += COOKIE_REFRESH_MS - 1;
    await ensureFileCookies(clock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 1;
    await ensureFileCookies(clock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(COOKIE_REFRESH_MS).toBe(3_000_000);
  });
  it('retries after a failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":{"code":"X","message":"失敗"}}', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(ensureFileCookies()).rejects.toThrow('X: 失敗');
    await expect(ensureFileCookies()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('builds slide URLs', () => {
    expect(slideFileUrl('a b')).toBe('/files/slides/a%20b.pdf');
  });
});
