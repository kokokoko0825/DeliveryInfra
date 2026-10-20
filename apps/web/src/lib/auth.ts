import { Amplify } from 'aws-amplify';
import { confirmResetPassword, confirmSignIn, confirmSignUp, fetchAuthSession, resetPassword, signIn, signInWithRedirect, signOut, signUp } from 'aws-amplify/auth';
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

export async function registerWithEmail(email: string, password: string): Promise<void> {
  await signUp({ username: email, password, options: { userAttributes: { email } } });
}

export async function confirmEmailRegistration(email: string, confirmationCode: string): Promise<void> {
  await confirmSignUp({ username: email, confirmationCode });
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

/**
 * Okta（Hosted UI のリダイレクト）ログイン失敗の理由を日本語にする（R3-08）。
 * 例: Okta でアプリが割り当てられていない → access_denied、PostConfirmation の失敗 → "PostConfirmation failed ..."。
 */
export function redirectErrorMessage(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : typeof error === 'string' ? error : '';
  if (/access_denied|not assigned|unauthorized/i.test(text)) return 'Okta でこのアプリの利用が許可されていません。管理者にアプリの割り当てを確認してください';
  if (/PostConfirmation|PreSignUp|PreAuthentication|PostAuthentication/i.test(text)) return 'アカウントの初期設定に失敗しました。時間をおいて再度お試しいただき、解決しない場合は管理者に連絡してください';
  return 'Okta でログインできませんでした。時間をおいて再度お試しください';
}

/**
 * 初回パスワード設定の認証セッション（3分）切れ。Cognito は NotAuthorizedException（Invalid session for the user, session is expired.）を返す（R4-04）。
 */
export const isAuthSessionExpired = (error: unknown): boolean =>
  error instanceof Error && error.name === 'NotAuthorizedException' && /session is expired|Invalid session/i.test(error.message);

/** Amplify(Cognito) のエラーを日本語にする。 */
export function authErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (/attempts exceeded/i.test(message)) return 'ログイン試行回数の上限に達しました。しばらく待ってから再度お試しください';
  // 仮パスワードの期限（7日）切れ。確認コードでの再設定もできないので、管理者の再送に誘導する（R3-13）
  if (name === 'NotAuthorizedException' && /temporary password has expired/i.test(message)) return '仮パスワードの有効期限が切れています。管理者に招待の再送を依頼してください';
  if (isAuthSessionExpired(error)) return '時間が経過したため、もう一度ログインからやり直してください';
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
