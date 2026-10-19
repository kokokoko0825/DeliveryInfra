import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, useLocation } from 'react-router';
import { makeAuth, renderPage } from '@/test/render';
import { NewPasswordSchema, ResetConfirmSchema } from './password-schemas';

const auth = vi.hoisted(() => ({
  completeNewPassword: vi.fn(), requestPasswordReset: vi.fn(), confirmPasswordReset: vi.fn(),
  authErrorMessage: vi.fn((e: unknown) => (e as Error).message),
  isAuthSessionExpired: vi.fn(() => false),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/auth', () => auth);
vi.mock('sonner', () => ({ toast }));
const { default: PasswordPage } = await import('./PasswordPage');

function Where() { return <p>at:{useLocation().pathname}</p>; }
const routes = <><Route path="/login" element={<Where />} /><Route path="/display-name" element={<Where />} /></>;
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const open = (state?: unknown, ctx = makeAuth({ status: 'signedOut', me: null })) => {
  renderPage(<PasswordPage />, { auth: ctx, path: { pathname: '/password', state }, route: '/password', extraRoutes: routes });
  return ctx;
};
const GOOD = 'Abcdefghij12';

beforeEach(() => vi.clearAllMocks());

describe('password schemas', () => {
  it('requires matching passwords and a 6 digit code', () => {
    expect(NewPasswordSchema.safeParse({ newPassword: GOOD, confirmPassword: GOOD }).success).toBe(true);
    expect(NewPasswordSchema.safeParse({ newPassword: GOOD, confirmPassword: 'Abcdefghij13' }).error?.issues[0]).toMatchObject({ message: 'パスワードが一致しません', path: ['confirmPassword'] });
    expect(ResetConfirmSchema.safeParse({ code: ' 123456 ', newPassword: GOOD, confirmPassword: GOOD }).success).toBe(true);
    expect(ResetConfirmSchema.safeParse({ code: '12345', newPassword: GOOD, confirmPassword: GOOD }).error?.issues[0]?.message).toBe('6桁の確認コードを入力してください');
    expect(ResetConfirmSchema.safeParse({ code: '1234567', newPassword: GOOD, confirmPassword: GOOD }).success).toBe(false);
    expect(ResetConfirmSchema.safeParse({ code: 'abcdef', newPassword: GOOD, confirmPassword: GOOD }).success).toBe(false);
  });
});

describe('PasswordPage (C-02) first login', () => {
  it('validates the policy and confirmation', async () => {
    open({ mode: 'new' });
    expect(screen.getByRole('heading', { name: '初回パスワード設定' })).toBeInTheDocument();
    type('新しいパスワード', 'short');
    type('新しいパスワード（確認）', 'other');
    fireEvent.click(screen.getByRole('button', { name: 'パスワードを設定' }));
    expect(await screen.findByText('12文字以上で入力してください')).toBeInTheDocument();
    type('新しいパスワード', GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'パスワードを設定' }));
    expect(await screen.findByText('パスワードが一致しません')).toBeInTheDocument();
    expect(auth.completeNewPassword).not.toHaveBeenCalled();
  });

  it('sets the new password and continues to the display name screen', async () => {
    auth.completeNewPassword.mockResolvedValue('DONE');
    const ctx = open({ mode: 'new' });
    type('新しいパスワード', GOOD);
    type('新しいパスワード（確認）', GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'パスワードを設定' }));
    expect(await screen.findByText('at:/display-name')).toBeInTheDocument();
    expect(auth.completeNewPassword).toHaveBeenCalledWith(GOOD);
    expect(ctx.refresh).toHaveBeenCalled();
  });

  it('reports unexpected steps, missing profiles and errors', async () => {
    auth.completeNewPassword.mockResolvedValueOnce('RESET_PASSWORD');
    open({ mode: 'new' }, makeAuth({ status: 'signedOut', me: null, refresh: vi.fn(async () => null) }));
    type('新しいパスワード', GOOD);
    type('新しいパスワード（確認）', GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'パスワードを設定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('パスワードを設定できませんでした');
    auth.completeNewPassword.mockResolvedValueOnce('DONE');
    fireEvent.click(screen.getByRole('button', { name: 'パスワードを設定' }));
    expect(await screen.findByText('ユーザー情報を取得できませんでした。再度ログインしてください')).toBeInTheDocument();
    auth.completeNewPassword.mockRejectedValueOnce(new Error('ポリシー違反'));
    fireEvent.click(screen.getByRole('button', { name: 'パスワードを設定' }));
    expect(await screen.findByText('ポリシー違反')).toBeInTheDocument();
  });
});

describe('PasswordPage (C-02) session expiry', () => {
  it('switches to a button that restarts from the login screen when the auth session expired (R4-04)', async () => {
    auth.completeNewPassword.mockRejectedValueOnce(new Error('時間が経過したため、もう一度ログインからやり直してください'));
    auth.isAuthSessionExpired.mockReturnValueOnce(true);
    open({ mode: 'new' });
    type('新しいパスワード', GOOD);
    type('新しいパスワード（確認）', GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'パスワードを設定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('時間が経過したため、もう一度ログインからやり直してください');
    expect(screen.queryByRole('button', { name: 'パスワードを設定' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'ログインからやり直す' }));
    expect(await screen.findByText('at:/login')).toBeInTheDocument();
  });
});

describe('PasswordPage (C-02) reset', () => {
  it('defaults to reset mode with the email prefilled', () => {
    open({ mode: 'reset', email: 'a@example.com' });
    expect(screen.getByRole('heading', { name: 'パスワード再設定' })).toBeInTheDocument();
    expect(screen.getByLabelText('メールアドレス')).toHaveValue('a@example.com');
  });

  it('validates the email before sending a code', async () => {
    open();
    type('メールアドレス', 'bad');
    fireEvent.click(screen.getByRole('button', { name: '確認コードを送信' }));
    expect(await screen.findByText('メールアドレスの形式が正しくありません')).toBeInTheDocument();
    expect(auth.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('sends a code, confirms the reset and returns to login', async () => {
    auth.requestPasswordReset.mockResolvedValue(undefined);
    auth.confirmPasswordReset.mockResolvedValue(undefined);
    open();
    type('メールアドレス', 'a@example.com');
    fireEvent.click(screen.getByRole('button', { name: '確認コードを送信' }));
    expect(await screen.findByText('a@example.com に確認コードを送信しました。')).toBeInTheDocument();
    type('確認コード', '12');
    type('新しいパスワード', GOOD);
    type('新しいパスワード（確認）', GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'パスワードを再設定' }));
    expect(await screen.findByText('6桁の確認コードを入力してください')).toBeInTheDocument();
    type('確認コード', '123456');
    fireEvent.click(screen.getByRole('button', { name: 'パスワードを再設定' }));
    expect(await screen.findByText('at:/login')).toBeInTheDocument();
    expect(auth.confirmPasswordReset).toHaveBeenCalledWith('a@example.com', '123456', GOOD);
    expect(toast.success).toHaveBeenCalled();
  });

  it('shows errors from Cognito', async () => {
    auth.requestPasswordReset.mockRejectedValueOnce(new Error('回数上限'));
    open({ email: 'a@example.com' });
    fireEvent.click(screen.getByRole('button', { name: '確認コードを送信' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('回数上限');
    auth.requestPasswordReset.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: '確認コードを送信' }));
    await screen.findByLabelText('確認コード');
    auth.confirmPasswordReset.mockRejectedValueOnce(new Error('確認コードが正しくありません'));
    type('確認コード', '123456');
    type('新しいパスワード', GOOD);
    type('新しいパスワード（確認）', GOOD);
    fireEvent.click(screen.getByRole('button', { name: 'パスワードを再設定' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('確認コードが正しくありません');
  });
});
