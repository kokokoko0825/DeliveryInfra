import { Amplify } from 'aws-amplify';
import { confirmResetPassword, confirmSignIn, fetchAuthSession, resetPassword, signIn, signInWithRedirect, signOut } from 'aws-amplify/auth';
import 'aws-amplify/auth/enable-oauth-listener';
import type { RuntimeConfig } from './config';

export type SignInResult = 'DONE' | 'NEW_PASSWORD_REQUIRED' | 'RESET_PASSWORD';

export function configureAuth(config: RuntimeConfig) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.userPoolId,
        userPoolClientId: config.userPoolClientId,
        ...(config.oauth ? {
          loginWith: {
            oauth: {
              domain: config.oauth.domain,
              scopes: ['openid', 'email', 'profile', 'aws.cognito.signin.user.admin'],
              redirectSignIn: [config.oauth.redirectSignIn],
              redirectSignOut: [config.oauth.redirectSignOut],
              responseType: 'code' as const,
            },
          },
        } : {}),
      },
    },
  });
}

export function toSignInResult(step: string): SignInResult {
  if (step === 'DONE') return 'DONE';
  if (step === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') return 'NEW_PASSWORD_REQUIRED';
  if (step === 'RESET_PASSWORD') return 'RESET_PASSWORD';
  throw new Error('このログイン方式には対応していません');
}

export async function loginWithEmail(email: string, password: string): Promise<SignInResult> {
  const { nextStep } = await signIn({ username: email, password });
  return toSignInResult(nextStep.signInStep);
}

export async function completeNewPassword(newPassword: string): Promise<SignInResult> {
  const { nextStep } = await confirmSignIn({ challengeResponse: newPassword });
  return toSignInResult(nextStep.signInStep);
}

export const loginWithOkta = (providerName: string) => signInWithRedirect({ provider: { custom: providerName } });
export const requestPasswordReset = async (email: string) => { await resetPassword({ username: email }); };
export const confirmPasswordReset = (email: string, confirmationCode: string, newPassword: string) =>
  confirmResetPassword({ username: email, confirmationCode, newPassword });
export const logout = () => signOut();

/** 期限切れなら Amplify がリフレッシュトークンで自動更新する。forceRefresh で強制更新。 */
export async function getAccessToken(forceRefresh = false): Promise<string | undefined> {
  try {
    const session = await fetchAuthSession({ forceRefresh });
    return session.tokens?.accessToken.toString();
  } catch {
    return undefined;
  }
}

/** Amplify(Cognito) のエラーを日本語にする。 */
export function authErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (/attempts exceeded/i.test(message)) return 'ログイン試行回数の上限に達しました。しばらく待ってから再度お試しください';
  switch (name) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return 'メールアドレスまたはパスワードが正しくありません';
    case 'CodeMismatchException':
      return '確認コードが正しくありません';
    case 'ExpiredCodeException':
      return '確認コードの有効期限が切れています。もう一度送信してください';
    case 'InvalidPasswordException':
      return 'パスワードがポリシーを満たしていません（12文字以上、英大文字・小文字・数字を含む）';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
      return '操作回数の上限に達しました。しばらく待ってから再度お試しください';
    case 'UserAlreadyAuthenticatedException':
      return 'すでにログインしています';
    default:
      return message || 'ログイン処理に失敗しました';
  }
}
