import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment } from '@delivery/shared';
import { apiError, callsTo, bodyOf, makeAuth, makeChat, makeMe, mockApi, renderPage } from '@/test/render';
import { CommentPanel, useAdminModeration } from './CommentPanel';
import { sendBlockReason } from './send-block';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const comment = (id: string, overrides: Partial<Comment> = {}): Comment => ({
  messageId: id, userId: `user-${id}`, displayName: `名前${id}`, comment: `本文${id}`, sentAt: '2026-10-19T01:00:00.000Z', deleted: false, ...overrides,
});
const input = () => screen.getByLabelText('コメント');
const submit = () => fireEvent.click(screen.getByRole('button', { name: '送信' }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('sendBlockReason', () => {
  it('blocks suspended users and unconnected rooms', () => {
    expect(sendBlockReason(true, 'connected', ['SEND_MESSAGE'])).toBe('suspended');
    expect(sendBlockReason(false, 'connecting', ['SEND_MESSAGE'])).toBe('connecting');
    expect(sendBlockReason(false, 'disconnected', [])).toBe('connecting');
    expect(sendBlockReason(false, 'connected', [])).toBe('suspended');
    expect(sendBlockReason(false, 'connected', ['SEND_MESSAGE'])).toBeNull();
  });
});

describe('CommentPanel', () => {
  it('lists comments as plain text (no HTML injection)', () => {
    renderPage(<CommentPanel />, { chat: makeChat({ comments: [comment('1', { comment: '<img src=x onerror=alert(1)>' })] }) });
    const log = screen.getByRole('log');
    expect(within(log).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(log.querySelector('img')).toBeNull();
    expect(within(log).getByText('名前1')).toBeInTheDocument();
    expect(within(log).getByText('10:00')).toBeInTheDocument();
  });

  it('shows an empty state', () => {
    renderPage(<CommentPanel />);
    expect(screen.getByText('まだコメントはありません')).toBeInTheDocument();
  });

  it('sends 200 characters with the display name and clears the input', async () => {
    const chat = makeChat();
    renderPage(<CommentPanel />, { chat, auth: makeAuth({ me: makeMe({ displayName: 'たなか' }) }) });
    fireEvent.change(input(), { target: { value: 'あ'.repeat(200) } });
    expect(screen.getByText('200 / 200 文字・3秒に1回まで')).toBeInTheDocument();
    submit();
    await waitFor(() => expect(chat.send).toHaveBeenCalledWith('あ'.repeat(200), 'たなか'));
    await waitFor(() => expect(input()).toHaveValue(''));
  });

  it('rejects 201 characters and empty input on the client', async () => {
    const chat = makeChat();
    renderPage(<CommentPanel />, { chat });
    fireEvent.change(input(), { target: { value: 'あ'.repeat(201) } });
    expect(screen.getByText('201 / 200 文字・3秒に1回まで')).toHaveClass('text-destructive');
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('200文字以内で入力してください');
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(input(), { target: { value: '  ' } });
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('コメントを入力してください');
    expect(chat.send).not.toHaveBeenCalled();
  });

  it('enforces the 3 second client-side rate limit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const chat = makeChat();
    renderPage(<CommentPanel />, { chat });
    fireEvent.change(input(), { target: { value: '1' } });
    submit();
    await waitFor(() => expect(chat.send).toHaveBeenCalledTimes(1));
    fireEvent.change(input(), { target: { value: '2' } });
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(/連投はできません/);
    expect(chat.send).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(3000); });
    submit();
    await waitFor(() => expect(chat.send).toHaveBeenCalledTimes(2));
  });

  it('keeps the input and shows the error when sending fails', async () => {
    const chat = makeChat({ send: vi.fn().mockRejectedValue(new Error('NGワードを含むか、送信できない内容です')) });
    renderPage(<CommentPanel />, { chat });
    fireEvent.change(input(), { target: { value: 'だめ' } });
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('NGワードを含むか、送信できない内容です');
    expect(input()).toHaveValue('だめ');
  });

  it('disables sending for suspended users with the reason', () => {
    renderPage(<CommentPanel />, { auth: makeAuth({ me: makeMe({ commentSuspended: true }) }) });
    expect(input()).toBeDisabled();
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('管理者によりコメント送信が停止されています');
  });

  it('disables sending while connecting', () => {
    const chat = makeChat({ connection: 'connecting' });
    renderPage(<CommentPanel />, { chat });
    expect(input()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('コメントサーバーに接続しています');
    fireEvent.submit(input().closest('form')!);
    expect(chat.send).not.toHaveBeenCalled();
  });

  it('hides moderation controls by default and shows them when provided', async () => {
    const { unmount } = renderPage(<CommentPanel />, { chat: makeChat({ comments: [comment('1')] }) });
    expect(screen.queryByRole('button', { name: /を削除/ })).not.toBeInTheDocument();
    unmount();
    const moderation = { onDelete: vi.fn(), onSuspend: vi.fn() };
    renderPage(<CommentPanel moderation={moderation} />, { chat: makeChat({ comments: [comment('1')] }) });
    fireEvent.click(screen.getByRole('button', { name: '名前1 さんのコメントを削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    expect(moderation.onDelete).toHaveBeenCalledWith(comment('1'));
    fireEvent.click(screen.getByRole('button', { name: '名前1 さんのコメント送信を停止' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));
    expect(moderation.onSuspend).toHaveBeenCalledWith(comment('1'));
  });
});

describe('useAdminModeration', () => {
  function AdminPanel() { return <CommentPanel moderation={useAdminModeration()} />; }

  it('deletes via the API and removes the comment immediately', async () => {
    const fetchMock = mockApi({ 'DELETE /api/comments/m%2F1': { success: true } });
    const chat = makeChat({ comments: [comment('m/1')] });
    renderPage(<AdminPanel />, { chat });
    fireEvent.click(screen.getByRole('button', { name: '名前m/1 さんのコメントを削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    await waitFor(() => expect(chat.remove).toHaveBeenCalledWith('m/1'));
    expect(callsTo(fetchMock, 'DELETE /api/comments/m%2F1')).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith('コメントを削除しました');
  });

  it('suspends the user', async () => {
    const fetchMock = mockApi({ 'PUT /api/users/user-1/comment-suspension': { success: true } });
    renderPage(<AdminPanel />, { chat: makeChat({ comments: [comment('1')] }) });
    fireEvent.click(screen.getByRole('button', { name: '名前1 さんのコメント送信を停止' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('名前1 さんのコメント送信を停止しました'));
    expect(bodyOf(callsTo(fetchMock, 'PUT /api/users/user-1/comment-suspension')[0])).toEqual({ suspended: true });
  });

  it('shows API errors', async () => {
    mockApi({
      'DELETE /api/comments/1': apiError(403, 'FORBIDDEN', '権限がありません'),
      'PUT /api/users/user-1/comment-suspension': apiError(404, 'NOT_FOUND', '対象が見つかりません'),
    });
    const chat = makeChat({ comments: [comment('1')] });
    renderPage(<AdminPanel />, { chat });
    fireEvent.click(screen.getByRole('button', { name: '名前1 さんのコメントを削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('権限がありません'));
    expect(chat.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '名前1 さんのコメント送信を停止' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('対象が見つかりません'));
  });
});
