import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Route } from 'react-router';
import { makeAuth, makeMe, renderPage } from '@/test/render';
import { resolveGuard } from './guard';
import { RequireAuth } from './RequireAuth';

describe('resolveGuard', () => {
  const me = makeMe();
  it('waits while loading and reports errors', () => {
    expect(resolveGuard({ status: 'loading', me: null })).toEqual({ kind: 'loading' });
    expect(resolveGuard({ status: 'error', me: null })).toEqual({ kind: 'error' });
  });
  it('sends signed-out users to /login', () => {
    expect(resolveGuard({ status: 'signedOut', me: null })).toEqual({ kind: 'redirect', to: '/login' });
    expect(resolveGuard({ status: 'signedOut', me })).toEqual({ kind: 'redirect', to: '/login' });
    expect(resolveGuard({ status: 'signedIn', me: null })).toEqual({ kind: 'redirect', to: '/login' });
  });
  it('requires a display name unless disabled', () => {
    const noName = makeMe({ displayName: null });
    expect(resolveGuard({ status: 'signedIn', me: noName })).toEqual({ kind: 'redirect', to: '/display-name' });
    expect(resolveGuard({ status: 'signedIn', me: noName, requireDisplayName: false })).toEqual({ kind: 'allow' });
    expect(resolveGuard({ status: 'signedIn', me: makeMe({ displayName: '' }) })).toEqual({ kind: 'redirect', to: '/display-name' });
  });
  it('checks role permissions per feature', () => {
    expect(resolveGuard({ status: 'signedIn', me, feature: 'watch' })).toEqual({ kind: 'allow' });
    expect(resolveGuard({ status: 'signedIn', me, feature: 'userManage' })).toEqual({ kind: 'forbidden', home: '/watch' });
    expect(resolveGuard({ status: 'signedIn', me: makeMe({ role: 'camera' }), feature: 'micSend' })).toEqual({ kind: 'forbidden', home: '/send/camera' });
    expect(resolveGuard({ status: 'signedIn', me: makeMe({ role: 'admin' }), feature: 'userManage' })).toEqual({ kind: 'allow' });
    expect(resolveGuard({ status: 'signedIn', me })).toEqual({ kind: 'allow' });
  });
});

describe('RequireAuth', () => {
  const routes = (
    <>
      <Route path="/login" element={<p>ログイン画面</p>} />
      <Route path="/display-name" element={<p>表示名画面</p>} />
    </>
  );
  it('renders children when allowed', () => {
    renderPage(<RequireAuth feature="watch"><p>視聴画面</p></RequireAuth>, { path: '/watch', route: '/watch', extraRoutes: routes });
    expect(screen.getByText('視聴画面')).toBeInTheDocument();
  });
  it('redirects unauthenticated users to /login', () => {
    renderPage(<RequireAuth><p>保護</p></RequireAuth>, { auth: makeAuth({ status: 'signedOut', me: null }), path: '/watch', route: '/watch', extraRoutes: routes });
    expect(screen.getByText('ログイン画面')).toBeInTheDocument();
  });
  it('redirects users without a display name', () => {
    renderPage(<RequireAuth><p>保護</p></RequireAuth>, { auth: makeAuth({ me: makeMe({ displayName: null }) }), path: '/watch', route: '/watch', extraRoutes: routes });
    expect(screen.getByText('表示名画面')).toBeInTheDocument();
  });
  it('shows a notice for disallowed roles', () => {
    renderPage(<RequireAuth feature="userManage"><p>管理</p></RequireAuth>, { path: '/admin/users', route: '/admin/users' });
    expect(screen.getByRole('heading', { name: 'このページを表示する権限がありません' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ホームへ戻る' })).toHaveAttribute('href', '/watch');
    expect(screen.queryByText('管理')).not.toBeInTheDocument();
  });
  it('shows loading and error states', () => {
    const { unmount } = renderPage(<RequireAuth><p>x</p></RequireAuth>, { auth: makeAuth({ status: 'loading', me: null }) });
    expect(screen.getByRole('status')).toHaveTextContent('読み込み中');
    unmount();
    renderPage(<RequireAuth><p>x</p></RequireAuth>, { auth: makeAuth({ status: 'error', me: null, error: '設定ファイルを読み込めませんでした' }) });
    expect(screen.getByText('設定ファイルを読み込めませんでした')).toBeInTheDocument();
  });
});
