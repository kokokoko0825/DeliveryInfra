import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, useLocation } from 'react-router';
import { makeAuth, makeMe, renderPage } from '@/test/render';

const auth = vi.hoisted(() => ({ loginWithEmail: vi.fn(), loginWithOkta: vi.fn(), authErrorMessage: vi.fn((e: unknown) => (e as Error).message) }));
vi.mock('@/lib/auth', () => auth);
const { default: LoginPage } = await import('./LoginPage');

function Where() {
  const location = useLocation();
  return <p>at:{location.pathname}:{JSON.stringify(location.state)}</p>;
}
const routes = <><Route path="/display-name" element={<Where />} /><Route path="/password" element={<Where />} /><Route path="/watch" element={<Where />} /><Route path="/send/camera" element={<Where />} /></>;
const oauth = { domain: 'd', redirectSignIn: 'https://a/', redirectSignOut: 'https://a/', oktaProviderName: 'Okta' };

const fill = (email: string, password: string) => {
  fireEvent.change(screen.getByLabelText('メールアドレス'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'メールアドレスでログイン' }));
};

beforeEach(() => vi.clearAllMocks());

describe('LoginPage (C-01)', () => {
  const signedOut = (overrides = {}) => makeAuth({ status: 'signedOut', me: null, ...overrides });

  it('validates email format and required password', async () => {
    renderPage(<LoginPage />, { auth: signedOut() });
    fill('not-an-email', '');
    expect(await screen.findByText('メールアドレスの形式が正しくありません')).toBeInTheDocument();
    expect(screen.getByText('パスワードを入力してください')).toBeInTheDocument();
    expect(auth.loginWithEmail).not.toHaveBeenCalled();
  });

  it('logs in and goes to the display name screen', async () => {
    auth.loginWithEmail.mockResolvedValue('DONE');
    const ctx = signedOut();
    renderPage(<LoginPage />, { auth: ctx, path: '/login', route: '/login', extraRoutes: routes });
    fill('a@example.com', 'Password1234');
    expect(await screen.findByText(/at:\/display-name/)).toBeInTheDocument();
    expect(auth.loginWithEmail).toHaveBeenCalledWith('a@example.com', 'Password1234');
    expect(ctx.refresh).toHaveBeenCalled();
  });

  it('shows an error when the profile cannot be loaded', async () => {
    auth.loginWithEmail.mockResolvedValue('DONE');
    renderPage(<LoginPage />, { auth: signedOut({ refresh: vi.fn(async () => null) }) });
    fill('a@example.com', 'Password1234');
    expect(await screen.findByRole('alert')).toHaveTextContent('ユーザー情報を取得できませんでした');
  });

  it('routes the first-login challenge and reset requirement to /password', async () => {
    auth.loginWithEmail.mockResolvedValueOnce('NEW_PASSWORD_REQUIRED');
    const { unmount } = renderPage(<LoginPage />, { auth: signedOut(), path: '/login', route: '/login', extraRoutes: routes });
    fill('a@example.com', 'Temp');
    expect(await screen.findByText('at:/password:{"mode":"new","email":"a@example.com"}')).toBeInTheDocument();
    unmount();
    auth.loginWithEmail.mockResolvedValueOnce('RESET_PASSWORD');
    renderPage(<LoginPage />, { auth: signedOut(), path: '/login', route: '/login', extraRoutes: routes });
    fill('b@example.com', 'x');
    expect(await screen.findByText('at:/password:{"mode":"reset","email":"b@example.com"}')).toBeInTheDocument();
  });

  it('shows translated Cognito errors', async () => {
    auth.loginWithEmail.mockRejectedValue(new Error('メールアドレスまたはパスワードが正しくありません'));
    renderPage(<LoginPage />, { auth: signedOut() });
    fill('a@example.com', 'wrong');
    expect(await screen.findByRole('alert')).toHaveTextContent('メールアドレスまたはパスワードが正しくありません');
  });

  it('starts Okta SSO when configured and disables it otherwise', async () => {
    auth.loginWithOkta.mockResolvedValue(undefined);
    const { unmount } = renderPage(<LoginPage />, { auth: signedOut({ config: { region: 'r', userPoolId: 'p', userPoolClientId: 'c', oauth } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Oktaでログイン' }));
    expect(auth.loginWithOkta).toHaveBeenCalledWith('Okta');
    unmount();
    renderPage(<LoginPage />, { auth: signedOut() });
    expect(screen.getByRole('button', { name: 'Oktaでログイン' })).toBeDisabled();
  });

  it('shows Okta errors', async () => {
    auth.loginWithOkta.mockRejectedValue(new Error('SSO 失敗'));
    renderPage(<LoginPage />, { auth: signedOut({ config: { region: 'r', userPoolId: 'p', userPoolClientId: 'c', oauth } }) });
    fireEvent.click(screen.getByRole('button', { name: 'Oktaでログイン' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('SSO 失敗');
  });

  it('redirects signed-in users by role (F-AUTH-08)', () => {
    const { unmount } = renderPage(<LoginPage />, { auth: makeAuth({ me: makeMe({ role: 'camera' }) }), path: '/login', route: '/login', extraRoutes: routes });
    expect(screen.getByText(/at:\/send\/camera/)).toBeInTheDocument();
    unmount();
    renderPage(<LoginPage />, { auth: makeAuth({ me: makeMe({ displayName: null }) }), path: '/login', route: '/login', extraRoutes: routes });
    expect(screen.getByText(/at:\/display-name/)).toBeInTheDocument();
  });

  it('shows a loader while auth is initialising', () => {
    renderPage(<LoginPage />, { auth: makeAuth({ status: 'loading', me: null }) });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('links to password reset', async () => {
    renderPage(<LoginPage />, { auth: signedOut(), path: '/login', route: '/login', extraRoutes: routes });
    fireEvent.click(screen.getByRole('link', { name: 'パスワードを忘れた場合' }));
    await waitFor(() => expect(screen.getByText('at:/password:{"mode":"reset"}')).toBeInTheDocument());
  });
});
