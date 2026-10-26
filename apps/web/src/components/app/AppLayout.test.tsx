import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Route } from 'react-router';
import type { Role } from '@delivery/shared';
import { makeAuth, makeMe, renderPage } from '@/test/render';

vi.mock('@/features/viewer/ChatProvider', () => ({ ChatProvider: ({ children }: { children: React.ReactNode }) => children }));
const { AppLayout } = await import('./AppLayout');

const renderLayout = (role: Role, auth = makeAuth({ me: makeMe({ role, displayName: 'たなか' }) })) => {
  renderPage(<AppLayout />, { auth, path: '/watch' });
  return auth;
};

describe('AppLayout', () => {
  it('does not show operational audio controls to viewers', () => {
    renderLayout('viewer');
    const nav = screen.getAllByRole('link').map((link) => link.textContent);
    expect(nav).toEqual(['配信視聴', 'スライド', 'アーカイブ']);
    expect(screen.queryByText('管理')).not.toBeInTheDocument();
    expect(screen.getByText('視聴者')).toBeInTheDocument();
  });

  it('adds the sender page for staff roles', () => {
    renderLayout('camera');
    expect(screen.getByRole('link', { name: 'カメラ送信' })).toHaveAttribute('href', '/send/camera');
    expect(screen.queryByRole('link', { name: 'マイク送信' })).not.toBeInTheDocument();
  });

  it('shows venue speaker controls only to audio staff and administrators', () => {
    const { unmount } = renderPage(<AppLayout />, { auth: makeAuth({ me: makeMe({ role: 'audio', displayName: '音声担当' }) }), path: '/watch' });
    expect(screen.getByRole('link', { name: '会場スピーカー' })).toHaveAttribute('href', '/venue/speaker');
    unmount();

    renderLayout('presenter');
    expect(screen.queryByRole('link', { name: '会場スピーカー' })).not.toBeInTheDocument();
  });

  it('adds the admin menu for admins', () => {
    renderLayout('admin');
    expect(screen.getByText('管理')).toBeInTheDocument();
    for (const name of ['スイッチング', 'スライド管理', 'コメント管理', 'ユーザー管理', 'カメラ送信', 'マイク送信', '会場スピーカー', 'スライド共有']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });

  it('logs out', () => {
    const auth = renderLayout('viewer');
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
    expect(auth.logout).toHaveBeenCalled();
  });

  it('renders nothing without a profile', () => {
    const { container } = renderPage(<AppLayout />, { auth: makeAuth({ me: null }) });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the nested route', () => {
    renderPage(<></>, {
      path: '/watch', route: '/none',
      extraRoutes: <Route element={<AppLayout />}><Route path="/watch" element={<p>子ページ</p>} /></Route>,
    });
    expect(screen.getByText('子ページ')).toBeInTheDocument();
  });
});
