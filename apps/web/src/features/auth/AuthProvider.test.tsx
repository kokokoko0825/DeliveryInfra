import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, makeMe } from '@/test/render';
import { clearClientDiagnostics, listClientDiagnostics } from '@/lib/diagnostics';
import { useAuth } from './auth-context';

const mocks = vi.hoisted(() => ({
  configureAuth: vi.fn(), getAccessToken: vi.fn(), logout: vi.fn(), loadRuntimeConfig: vi.fn(),
  hubListeners: [] as ((data: { payload: { event: string; data?: unknown } }) => void)[],
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  redirectErrorMessage: (await importOriginal<typeof import('@/lib/auth')>()).redirectErrorMessage,
  configureAuth: mocks.configureAuth, getAccessToken: mocks.getAccessToken, logout: mocks.logout,
}));
vi.mock('@/lib/config', () => ({ loadRuntimeConfig: mocks.loadRuntimeConfig }));
vi.mock('aws-amplify/utils', () => ({
  Hub: { listen: (_channel: string, listener: (data: { payload: { event: string; data?: unknown } }) => void) => { mocks.hubListeners.push(listener); return () => undefined; } },
}));
const { AuthProvider } = await import('./AuthProvider');
const { apiFetch } = await import('@/lib/api');

const config = { region: 'ap-northeast-1', userPoolId: 'pool', userPoolClientId: 'client' };
function Probe() {
  const { status, me, error, loginError, logout, refresh } = useAuth();
  return (
    <div>
      <p>status:{status}</p><p>name:{me?.displayName ?? '-'}</p><p>error:{error ?? '-'}</p><p>loginError:{loginError ?? '-'}</p>
      <button onClick={() => { void logout(); }}>logout</button>
      <button onClick={() => { void refresh(); }}>refresh</button>
    </div>
  );
}
const renderProvider = () => render(<AuthProvider><Probe /></AuthProvider>);
const hub = (event: string, data?: unknown) => act(() => mocks.hubListeners.forEach((listener) => listener({ payload: { event, data } })));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hubListeners = [];
  mocks.loadRuntimeConfig.mockResolvedValue(config);
  mocks.getAccessToken.mockResolvedValue('jwt');
  mocks.logout.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('AuthProvider', () => {
  it('loads config, configures Amplify and fetches /me', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(makeMe({ displayName: 'たなか' }))));
    vi.stubGlobal('fetch', fetchMock);
    renderProvider();
    expect(screen.getByText('status:loading')).toBeInTheDocument();
    expect(await screen.findByText('status:signedIn')).toBeInTheDocument();
    expect(screen.getByText('name:たなか')).toBeInTheDocument();
    expect(mocks.configureAuth).toHaveBeenCalledWith(config);
    expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).get('X-Auth-Token')).toBe('jwt');
  });

  it('is signed out without a token', async () => {
    mocks.getAccessToken.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn());
    renderProvider();
    expect(await screen.findByText('status:signedOut')).toBeInTheDocument();
  });

  it('records token acquisition failures and leaves loading state', async () => {
    clearClientDiagnostics();
    mocks.getAccessToken.mockRejectedValue(new Error('token store unavailable'));
    renderProvider();
    expect(await screen.findByText('status:error')).toBeInTheDocument();
    expect(screen.getByText('error:token store unavailable')).toBeInTheDocument();
    expect(listClientDiagnostics()).toMatchObject([{ source: 'auth.token', message: 'token store unavailable' }]);
  });

  it('signs out on 401 and shows errors otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => apiError(401, 'UNAUTHORIZED', '期限切れ')));
    const { unmount } = renderProvider();
    expect(await screen.findByText('status:signedOut')).toBeInTheDocument();
    unmount();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => apiError(403, 'INVALID_ROLE', 'ロール設定が不正です')));
    renderProvider();
    expect(await screen.findByText('status:error')).toBeInTheDocument();
    expect(screen.getByText('error:ロール設定が不正です')).toBeInTheDocument();
  });

  it('reports config load failures', async () => {
    mocks.loadRuntimeConfig.mockRejectedValue(new Error('設定ファイルを読み込めませんでした'));
    renderProvider();
    expect(await screen.findByText('error:設定ファイルを読み込めませんでした')).toBeInTheDocument();
    expect(screen.getByText('status:error')).toBeInTheDocument();
  });

  it('logs out', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(makeMe()))));
    renderProvider();
    await screen.findByText('status:signedIn');
    act(() => screen.getByText('logout').click());
    expect(await screen.findByText('status:signedOut')).toBeInTheDocument();
    expect(mocks.logout).toHaveBeenCalled();
  });

  it('reacts to Hub events (Okta redirect, refresh failure)', async () => {
    mocks.getAccessToken.mockResolvedValueOnce(undefined);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(makeMe()))));
    renderProvider();
    await screen.findByText('status:signedOut');
    hub('signInWithRedirect');
    expect(await screen.findByText('status:signedIn')).toBeInTheDocument();
    hub('tokenRefresh_failure');
    expect(await screen.findByText('status:signedOut')).toBeInTheDocument();
    hub('signInWithRedirect');
    await screen.findByText('status:signedIn');
    hub('signedOut');
    expect(await screen.findByText('status:signedOut')).toBeInTheDocument();
    hub('other');
    expect(screen.getByText('status:signedOut')).toBeInTheDocument();
  });

  it('keeps the Okta sign-in failure reason and clears it on success (R3-08)', async () => {
    mocks.getAccessToken.mockResolvedValueOnce(undefined);
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(makeMe()))));
    renderProvider();
    await screen.findByText('status:signedOut');
    expect(screen.getByText('loginError:-')).toBeInTheDocument();
    hub('signInWithRedirect_failure', { error: Object.assign(new Error('access_denied: User is not assigned to the client application.'), { name: 'OAuthSignInException' }) });
    expect(screen.getByText('loginError:Okta でこのアプリの利用が許可されていません。管理者にアプリの割り当てを確認してください')).toBeInTheDocument();
    expect(screen.getByText('status:signedOut')).toBeInTheDocument();
    hub('signInWithRedirect');
    expect(await screen.findByText('status:signedIn')).toBeInTheDocument();
    expect(screen.getByText('loginError:-')).toBeInTheDocument();
    hub('signInWithRedirect_failure');
    expect(screen.getByText('loginError:Okta でログインできませんでした。時間をおいて再度お試しください')).toBeInTheDocument();
  });

  it('registers the token provider and the unauthorized handler for apiFetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(makeMe()))));
    renderProvider();
    await screen.findByText('status:signedIn');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => apiError(401, 'UNAUTHORIZED', 'x')));
    await expect(apiFetch('/slides')).rejects.toThrow();
    await waitFor(() => expect(screen.getByText('status:signedOut')).toBeInTheDocument());
  });
});
