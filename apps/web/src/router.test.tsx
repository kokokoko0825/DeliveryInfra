import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Role } from '@delivery/shared';
import { makeAuth, makeMe, renderPage } from '@/test/render';

const page = (name: string) => ({ default: () => <p>{name}</p> });
vi.mock('./features/viewer/WatchPage', () => page('視聴ページ'));
vi.mock('./features/sender/CameraSendPage', () => page('カメラ送信ページ'));
vi.mock('./features/sender/MicSendPage', () => page('マイク送信ページ'));
vi.mock('./features/sender/SlideSharePage', () => page('スライド共有ページ'));
vi.mock('./features/switcher/SwitcherPage', () => page('スイッチングページ'));
vi.mock('./features/admin/UsersAdminPage', () => page('ユーザー管理ページ'));
vi.mock('./features/viewer/ChatProvider', () => ({ ChatProvider: ({ children }: { children: React.ReactNode }) => children }));
const { App } = await import('./router');

const open = (path: string, role: Role | null, displayName: string | null = 'たなか') =>
  renderPage(<App />, { path, auth: role ? makeAuth({ me: makeMe({ role, displayName }) }) : makeAuth({ status: 'signedOut', me: null }) });

describe('App routes', () => {
  it.each([
    ['admin', '視聴ページ'], ['camera', 'カメラ送信ページ'], ['audio', 'マイク送信ページ'], ['presenter', 'スライド共有ページ'], ['viewer', '視聴ページ'],
  ] as const)('sends %s to the role home from / (F-AUTH-08)', async (role, text) => {
    open('/', role);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('requires login', async () => {
    open('/admin/users', null);
    expect(await screen.findByRole('button', { name: 'メールアドレスでログイン' })).toBeInTheDocument();
  });

  it('requires a display name before app pages', async () => {
    open('/watch', 'viewer', null);
    expect(await screen.findByRole('heading', { name: '表示名の設定' })).toBeInTheDocument();
  });

  it('shows a notice for pages outside the role', async () => {
    open('/admin/users', 'viewer');
    expect(await screen.findByRole('heading', { name: 'このページを表示する権限がありません' })).toBeInTheDocument();
    expect(screen.queryByText('ユーザー管理ページ')).not.toBeInTheDocument();
  });

  it('allows admins into admin pages', async () => {
    open('/admin/switcher', 'admin');
    expect(await screen.findByText('スイッチングページ')).toBeInTheDocument();
  });

  it('shows not found inside the layout', async () => {
    open('/nope', 'viewer');
    expect(await screen.findByRole('heading', { name: 'ページが見つかりません' })).toBeInTheDocument();
  });
});
