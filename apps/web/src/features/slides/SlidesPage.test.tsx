import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, callsTo, mockApi, renderPage } from '@/test/render';
import { resetFileCookies } from '@/lib/files';
import { queryKeys } from '@/lib/query-keys';
import SlidesPage from './SlidesPage';

const slide = (id: string, order: number) => ({ id, title: `資料${id}`, fileName: `${id}.pdf`, size: 2048, order });
afterEach(() => { vi.unstubAllGlobals(); resetFileCookies(); });

describe('SlidesPage (U-02)', () => {
  it('gets signed cookies, lists slides, and offers view / download', async () => {
    const fetchMock = mockApi({ 'GET /api/slides': [slide('a', 0), slide('b', 1)], 'POST /api/files/cookies': { success: true } });
    renderPage(<SlidesPage />);
    expect(await screen.findByText('資料a')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST /api/files/cookies')).toHaveLength(1);
    expect(screen.getByText('a.pdf・2.0 KB')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '資料a をダウンロード' })).toHaveAttribute('href', '/files/slides/a.pdf');
    expect(screen.getByRole('link', { name: '資料a をダウンロード' })).toHaveAttribute('download', 'a.pdf');
    fireEvent.click(screen.getByRole('button', { name: '資料b を閲覧' }));
    const frame = await screen.findByTitle('資料b');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', '/files/slides/b.pdf');
    expect(screen.getByRole('link', { name: '新しいタブで開く' })).toHaveAttribute('target', '_blank');
    // 長いスライド名が 44px の閉じるボタンに隠れないよう、見出しに右余白がある（R5-04）
    const title = screen.getByRole('heading', { name: '資料b' });
    expect(title).toHaveClass('break-words');
    expect(title.closest('[data-slot="dialog-header"]')).toHaveClass('pr-12');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTitle('資料b')).not.toBeInTheDocument());
  });

  it('shows an empty state', async () => {
    mockApi({ 'GET /api/slides': [], 'POST /api/files/cookies': {} });
    renderPage(<SlidesPage />);
    expect(await screen.findByText('公開中のスライドはまだありません')).toBeInTheDocument();
  });

  it('shows errors for the list and the cookies', async () => {
    mockApi({ 'GET /api/slides': apiError(500, 'X', '一覧の取得に失敗'), 'POST /api/files/cookies': apiError(500, 'Y', 'Cookie 失敗') });
    renderPage(<SlidesPage />);
    expect(await screen.findByText('一覧の取得に失敗')).toBeInTheDocument();
    expect(await screen.findByText('資料の閲覧準備に失敗しました: Cookie 失敗')).toBeInTheDocument();
  });

  it('refetches when slides-updated invalidates the query (F-SLD-05)', async () => {
    let slides = [slide('a', 0)];
    mockApi({ 'GET /api/slides': () => slides, 'POST /api/files/cookies': {} });
    const { queryClient } = renderPage(<SlidesPage />);
    await screen.findByText('資料a');
    slides = [];
    await queryClient.invalidateQueries({ queryKey: queryKeys.slides });
    expect(await screen.findByText('公開中のスライドはまだありません')).toBeInTheDocument();
  });
});
