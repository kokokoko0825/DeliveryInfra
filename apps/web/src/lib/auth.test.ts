import { beforeEach, describe, expect, it, vi } from 'vitest';

const amplify = vi.hoisted(() => ({
  configure: vi.fn(), signIn: vi.fn(), confirmSignIn: vi.fn(), signInWithRedirect: vi.fn(), signOut: vi.fn(),
  resetPassword: vi.fn(), confirmResetPassword: vi.fn(), fetchAuthSession: vi.fn(),
}));
vi.mock('aws-amplify', () => ({ Amplify: { configure: amplify.configure } }));
vi.mock('aws-amplify/auth/enable-oauth-listener', () => ({}));
vi.mock('aws-amplify/auth', () => amplify);

const auth = await import('./auth');
const diagnostics = await import('./diagnostics');
const named = (name: string, message = '') => Object.assign(new Error(message), { name });

beforeEach(() => {
  vi.clearAllMocks();
  diagnostics.clearClientDiagnostics();
});

describe('configureAuth', () => {
  const base = { region: 'ap-northeast-1', userPoolId: 'pool', userPoolClientId: 'client' };
  it('configures Cognito without OAuth', () => {
    auth.configureAuth(base);
    expect(amplify.configure).toHaveBeenCalledWith({ Auth: { Cognito: { userPoolId: 'pool', userPoolClientId: 'client' } } });
  });
  it('adds Okta OAuth settings when present', () => {
    auth.configureAuth({ ...base, oauth: { domain: 'd', redirectSignIn: 'https://a/', redirectSignOut: 'https://a/login', oktaProviderName: 'Okta' } });
    expect(amplify.configure.mock.calls[0]?.[0].Auth.Cognito.loginWith.oauth).toEqual({
      domain: 'd', scopes: ['openid', 'email', 'profile', 'aws.cognito.signin.user.admin'],
      redirectSignIn: ['https://a/'], redirectSignOut: ['https://a/login'], responseType: 'code',
    });
  });
});

describe('sign-in flow', () => {
  it('maps Cognito steps', () => {
    expect(auth.toSignInResult('DONE')).toBe('DONE');
    expect(auth.toSignInResult('CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED')).toBe('NEW_PASSWORD_REQUIRED');
    expect(auth.toSignInResult('RESET_PASSWORD')).toBe('RESET_PASSWORD');
    expect(() => auth.toSignInResult('CONFIRM_SIGN_IN_WITH_TOTP_CODE')).toThrow('このログイン方式には対応していません');
  });
  it('signs in with email and completes a new password', async () => {
    amplify.signIn.mockResolvedValue({ nextStep: { signInStep: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' } });
    await expect(auth.loginWithEmail('a@example.com', 'pw')).resolves.toBe('NEW_PASSWORD_REQUIRED');
    expect(amplify.signIn).toHaveBeenCalledWith({ username: 'a@example.com', password: 'pw' });
    amplify.confirmSignIn.mockResolvedValue({ nextStep: { signInStep: 'DONE' } });
    await expect(auth.completeNewPassword('NewPassword123')).resolves.toBe('DONE');
    expect(amplify.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: 'NewPassword123' });
  });
  it('records expected credential failures as warnings without storing the submitted email', async () => {
    amplify.signIn.mockRejectedValue(named('NotAuthorizedException', 'Incorrect username or password.'));
    await expect(auth.loginWithEmail('private@example.test', 'secret')).rejects.toMatchObject({ name: 'NotAuthorizedException' });
    const serialized = JSON.stringify(diagnostics.listClientDiagnostics());
    expect(serialized).toContain('auth.login');
    expect(serialized).not.toContain('private@example.test');
    expect(serialized).not.toContain('secret');
  });
  it('classifies unconfirmed users and reset-required passwords as expected auth failures', async () => {
    for (const name of ['UserNotConfirmedException', 'PasswordResetRequiredException']) {
      amplify.signIn.mockRejectedValueOnce(named(name));
      await expect(auth.loginWithEmail('a@example.test', 'password')).rejects.toMatchObject({ name });
      expect(diagnostics.listClientDiagnostics().at(-1)).toMatchObject({ source: 'auth.login', context: { status: 400 } });
    }
  });
  it('delegates Okta, reset, and logout', async () => {
    await auth.loginWithOkta('Okta');
    expect(amplify.signInWithRedirect).toHaveBeenCalledWith({ provider: { custom: 'Okta' } });
    await auth.requestPasswordReset('a@example.com');
    expect(amplify.resetPassword).toHaveBeenCalledWith({ username: 'a@example.com' });
    await auth.confirmPasswordReset('a@example.com', '123456', 'pw');
    expect(amplify.confirmResetPassword).toHaveBeenCalledWith({ username: 'a@example.com', confirmationCode: '123456', newPassword: 'pw' });
    await auth.logout();
    expect(amplify.signOut).toHaveBeenCalled();
  });
});

describe('getAccessToken', () => {
  it('returns the access token and passes forceRefresh', async () => {
    amplify.fetchAuthSession.mockResolvedValue({ tokens: { accessToken: { toString: () => 'jwt' } } });
    await expect(auth.getAccessToken()).resolves.toBe('jwt');
    expect(amplify.fetchAuthSession).toHaveBeenCalledWith({ forceRefresh: false });
    await auth.getAccessToken(true);
    expect(amplify.fetchAuthSession).toHaveBeenLastCalledWith({ forceRefresh: true });
  });
  it('returns undefined when signed out and records refresh failures', async () => {
    amplify.fetchAuthSession.mockResolvedValue({});
    await expect(auth.getAccessToken()).resolves.toBeUndefined();
    amplify.fetchAuthSession.mockRejectedValue(new Error('disabled'));
    await expect(auth.getAccessToken()).resolves.toBeUndefined();
    expect(diagnostics.listClientDiagnostics().some((entry) => entry.source === 'auth.token' && entry.message === 'disabled')).toBe(true);
  });
});

describe('redirectErrorMessage (R3-08)', () => {
  it('explains Okta assignment and PostConfirmation failures, and falls back to a generic message', () => {
    const assigned = 'Okta でこのアプリの利用が許可されていません。管理者にアプリの割り当てを確認してください';
    const setup = 'アカウントの初期設定に失敗しました。時間をおいて再度お試しいただき、解決しない場合は管理者に連絡してください';
    const generic = 'Okta でログインできませんでした。時間をおいて再度お試しください';
    expect(auth.redirectErrorMessage(named('OAuthSignInException', 'access_denied'))).toBe(assigned);
    expect(auth.redirectErrorMessage(new Error('User is not assigned to the client application.'))).toBe(assigned);
    expect(auth.redirectErrorMessage('unauthorized_client')).toBe(assigned);
    expect(auth.redirectErrorMessage(new Error('PostConfirmation failed with error boom.'))).toBe(setup);
    expect(auth.redirectErrorMessage(new Error('PreSignUp failed'))).toBe(setup);
    expect(auth.redirectErrorMessage(named('OAuthSignInException', 'invalid_request'))).toBe(generic);
    expect(auth.redirectErrorMessage(undefined)).toBe(generic);
    expect(auth.redirectErrorMessage({ message: 'access_denied' })).toBe(generic);
  });
});

describe('authErrorMessage', () => {
  it('translates Cognito errors', () => {
    expect(auth.authErrorMessage(named('NotAuthorizedException', 'Incorrect username or password.'))).toBe('メールアドレスまたはパスワードが正しくありません');
    expect(auth.authErrorMessage(named('UserNotFoundException'))).toBe('メールアドレスまたはパスワードが正しくありません');
    // 仮パスワードの期限切れ（R3-13）と、初回パスワード設定の認証セッション切れ（R4-04）は専用の文言
    expect(auth.authErrorMessage(named('NotAuthorizedException', 'Temporary password has expired and must be reset by an administrator.'))).toBe('仮パスワードの有効期限が切れています。管理者に招待の再送を依頼してください');
    expect(auth.authErrorMessage(named('NotAuthorizedException', 'Invalid session for the user, session is expired.'))).toBe('時間が経過したため、もう一度ログインからやり直してください');
    expect(auth.isAuthSessionExpired(named('NotAuthorizedException', 'Invalid session for the user, session is expired.'))).toBe(true);
    expect(auth.isAuthSessionExpired(named('NotAuthorizedException', 'Incorrect username or password.'))).toBe(false);
    expect(auth.isAuthSessionExpired(named('CodeMismatchException', 'Invalid session'))).toBe(false);
    expect(auth.isAuthSessionExpired('session is expired')).toBe(false);
    expect(auth.authErrorMessage(named('NotAuthorizedException', 'Password attempts exceeded'))).toBe('ログイン試行回数の上限に達しました。しばらく待ってから再度お試しください');
    expect(auth.authErrorMessage(named('CodeMismatchException'))).toBe('確認コードが正しくありません');
    expect(auth.authErrorMessage(named('ExpiredCodeException'))).toBe('確認コードの有効期限が切れています。もう一度送信してください');
    expect(auth.authErrorMessage(named('InvalidPasswordException'))).toContain('ポリシー');
    expect(auth.authErrorMessage(named('LimitExceededException'))).toBe('操作回数の上限に達しました。しばらく待ってから再度お試しください');
    expect(auth.authErrorMessage(named('TooManyRequestsException'))).toBe('操作回数の上限に達しました。しばらく待ってから再度お試しください');
    expect(auth.authErrorMessage(named('UserAlreadyAuthenticatedException'))).toBe('すでにログインしています');
    expect(auth.authErrorMessage(named('Other', 'raw'))).toBe('raw');
    expect(auth.authErrorMessage('x')).toBe('ログイン処理に失敗しました');
  });
});
