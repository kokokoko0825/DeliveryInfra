import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiError, bodyOf, callsTo, makeAuth, makeChat, makeMe, mockApi, renderPage } from '@/test/render';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const download = vi.hoisted(() => ({ saveBlob: vi.fn() }));
vi.mock('@/lib/download', () => download);
const { default: CommentsAdminPage } = await import('./CommentsAdminPage');

const user = (userId: string, commentSuspended: boolean) => ({ userId, email: `${userId}@example.com`, loginMethod: 'email', role: 'viewer', enabled: true, commentSuspended, lastLoginAt: null });
const admin = makeAuth({ me: makeMe({ role: 'admin' }) });
const base = { 'GET /api/users': [user('u1', true), user('u2', false)], 'GET /api/ng-words': ['ばか'] };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('CommentsAdminPage (A-04)', () => {
  it('reuses the comment panel with moderation controls', async () => {
    mockApi(base);
    renderPage(<CommentsAdminPage />, { auth: admin, chat: makeChat({ comments: [{ messageId: 'm1', userId: 'u2', displayName: 'すずき', comment: 'こんにちは', sentAt: '2026-10-19T01:00:00.000Z', deleted: false }] }) });
    expect(screen.getByRole('button', { name: 'すずき さんのコメントを削除' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'すずき さんのコメント送信を停止' })).toBeInTheDocument();
  });

  it('lists suspended users and lifts the suspension', async () => {
    const fetchMock = mockApi({ ...base, 'PUT /api/users/u1/comment-suspension': { success: true } });
    renderPage(<CommentsAdminPage />, { auth: admin });
    const list = await screen.findByRole('list', { name: 'コメント停止中のユーザー' });
    await within(list).findByText('u1@example.com');
    expect(within(list).queryByText('u2@example.com')).not.toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: '解除' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('コメント送信の停止を解除しました'));
    expect(bodyOf(callsTo(fetchMock, 'PUT /api/users/u1/comment-suspension')[0])).toEqual({ suspended: false });
  });

  it('shows when nobody is suspended and reports errors', async () => {
    mockApi({ ...base, 'GET /api/users': [user('u2', false)] });
    const { unmount } = renderPage(<CommentsAdminPage />, { auth: admin });
    expect(await screen.findByText('停止中のユーザーはいません')).toBeInTheDocument();
    unmount();
    mockApi({ ...base, 'PUT /api/users/u1/comment-suspension': apiError(500, 'X', '解除失敗') });
    renderPage(<CommentsAdminPage />, { auth: admin });
    fireEvent.click(await screen.findByRole('button', { name: '解除' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('解除失敗'));
  });

  it('adds and removes NG words with validation', async () => {
    const fetchMock = mockApi({ ...base, 'POST /api/ng-words': { word: 'あほ' }, 'DELETE /api/ng-words/%E3%81%B0%E3%81%8B': { success: true } });
    renderPage(<CommentsAdminPage />, { auth: admin });
    await screen.findByText('ばか');
    const input = screen.getByLabelText('追加する単語');
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    expect(await screen.findByText('NGワードは1〜100文字で入力してください')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'あ'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    expect(screen.getByText('NGワードは1〜100文字で入力してください')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: ' ばか ' } });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    expect(await screen.findByText('すでに登録されています')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: ' あほ ' } });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    await waitFor(() => expect(bodyOf(callsTo(fetchMock, 'POST /api/ng-words')[0])).toEqual({ word: 'あほ' }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByText('すでに登録されています')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ばか を削除' }));
    await waitFor(() => expect(callsTo(fetchMock, 'DELETE /api/ng-words/%E3%81%B0%E3%81%8B')).toHaveLength(1));
  });

  it('shows NG word API errors', async () => {
    mockApi({ ...base, 'POST /api/ng-words': apiError(400, 'V', '追加失敗'), 'DELETE /api/ng-words/%E3%81%B0%E3%81%8B': apiError(500, 'X', '削除失敗'), 'GET /api/ng-words': ['ばか'] });
    renderPage(<CommentsAdminPage />, { auth: admin });
    await screen.findByText('ばか');
    fireEvent.change(screen.getByLabelText('追加する単語'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    expect(await screen.findByText('追加失敗')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ばか を削除' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('削除失敗'));
  });

  it('exports the comment log as CSV keeping the BOM', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-10-19T03:00:00Z') });
    mockApi({ ...base, 'GET /api/comments/export': new Response('﻿日時,表示名\n', { status: 200, headers: { 'Content-Type': 'text/csv' } }) });
    renderPage(<CommentsAdminPage />, { auth: admin });
    fireEvent.click(screen.getByRole('button', { name: 'CSV を出力' }));
    await waitFor(() => expect(download.saveBlob).toHaveBeenCalled());
    const [blob, name] = download.saveBlob.mock.calls[0] as [Blob, string];
    expect(name).toBe('comments-20261019.csv');
    expect(blob.size).toBe(3 + new TextEncoder().encode('日時,表示名\n').length);
    vi.useRealTimers();
  });

  it('reports export errors', async () => {
    mockApi({ ...base, 'GET /api/comments/export': apiError(500, 'X', '出力失敗') });
    renderPage(<CommentsAdminPage />, { auth: admin });
    fireEvent.click(screen.getByRole('button', { name: 'CSV を出力' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('出力失敗'));
  });

  it('shows list errors', async () => {
    mockApi({ 'GET /api/users': apiError(500, 'X', 'ユーザー取得失敗'), 'GET /api/ng-words': apiError(500, 'Y', 'NG取得失敗') });
    renderPage(<CommentsAdminPage />, { auth: admin });
    expect(await screen.findByText('ユーザー取得失敗')).toBeInTheDocument();
    expect(await screen.findByText('NG取得失敗')).toBeInTheDocument();
  });
});
