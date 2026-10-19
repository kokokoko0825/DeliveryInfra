import { beforeEach, describe, expect, it, vi } from 'vitest';

const amplify = vi.hoisted(() => ({
  configure: vi.fn(), signIn: vi.fn(), confirmSignIn: vi.fn(), signInWithRedirect: vi.fn(), signOut: vi.fn(),
  resetPassword: vi.fn(), confirmResetPassword: vi.fn(), fetchAuthSession: vi.fn(),
}));
vi.mock('aws-amplify', () => ({ Amplify: { configure: amplify.configure } }));
vi.mock('aws-amplify/auth/enable-oauth-listener', () => ({}));
vi.mock('aws-amplify/auth', () => amplify);

const auth = await import('./auth');
const named = (name: string, message = '') => Object.assign(new Error(message), { name });

beforeEach(() => vi.clearAllMocks());

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
  it('returns undefined when signed out or refresh fails', async () => {
    amplify.fetchAuthSession.mockResolvedValue({});
    await expect(auth.getAccessToken()).resolves.toBeUndefined();
    amplify.fetchAuthSession.mockRejectedValue(new Error('disabled'));
    await expect(auth.getAccessToken()).resolves.toBeUndefined();
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
