import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAuth, makeMe, mockApi, renderPage } from '@/test/render';

const stage = vi.hoisted(() => ({ useViewerStage: vi.fn() }));
vi.mock('@/lib/viewer-stage', () => stage);
const { default: WatchPage } = await import('./WatchPage');

const broadcast = (status: 'idle' | 'live' | 'ended') => ({ id: 'b1', title: '定例配信', status, startedAt: null, endedAt: null });

beforeEach(() => {
  stage.useViewerStage.mockReturnValue({ stream: null, state: 'idle', error: null });
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('WatchPage (U-01)', () => {
  it('shows the waiting screen before the broadcast and does not join', async () => {
    mockApi({ 'GET /api/broadcast': null });
    renderPage(<WatchPage />);
    expect(await screen.findByText('配信開始までお待ちください')).toBeInTheDocument();
    expect(stage.useViewerStage).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
  });

  it('shows the ended screen with a link to archives', async () => {
    mockApi({ 'GET /api/broadcast': broadcast('ended') });
    renderPage(<WatchPage />);
    expect(await screen.findByText('配信は終了しました')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'アーカイブを見る' })).toHaveAttribute('href', '/archives');
  });

  it('joins the stage while live and shows LIVE when connected', async () => {
    mockApi({ 'GET /api/broadcast': broadcast('live') });
    stage.useViewerStage.mockImplementation((active: boolean) => ({ stream: null, state: active ? 'connected' : 'idle', error: null }));
    renderPage(<WatchPage />);
    expect(await screen.findByText('LIVE')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '定例配信' })).toBeInTheDocument();
    expect(screen.getByLabelText('配信映像')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'タップして音声オン' })).toBeInTheDocument();
  });

  it('shows the reconnecting state', async () => {
    mockApi({ 'GET /api/broadcast': broadcast('live') });
    stage.useViewerStage.mockReturnValue({ stream: null, state: 'reconnecting', error: null });
    renderPage(<WatchPage />);
    expect(await screen.findByText('再接続中…')).toBeInTheDocument();
    stage.useViewerStage.mockReturnValue({ stream: null, state: 'connecting', error: null });
  });

  it('shows the viewer count and switcher link only to admins (F-VIEW-05 / F-AUTH-08)', async () => {
    mockApi({ 'GET /api/broadcast': broadcast('live'), 'GET /api/broadcast/stats': { viewerCount: 42 } });
    stage.useViewerStage.mockReturnValue({ stream: null, state: 'connecting', error: null });
    const { unmount } = renderPage(<WatchPage />, { auth: makeAuth({ me: makeMe({ role: 'admin' }) }) });
    expect(await screen.findByText('同時視聴者数 42 人')).toBeInTheDocument();
    expect(screen.getByText('接続中…')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'スイッチング画面へ' })).toHaveAttribute('href', '/admin/switcher');
    unmount();
    renderPage(<WatchPage />);
    await screen.findByText('接続中…');
    expect(screen.queryByText(/同時視聴者数/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'スイッチング画面へ' })).not.toBeInTheDocument();
  });

  it('does not show viewer count when not live', async () => {
    const fetchMock = mockApi({ 'GET /api/broadcast': broadcast('idle') });
    renderPage(<WatchPage />, { auth: makeAuth({ me: makeMe({ role: 'admin' }) }) });
    await screen.findByText('配信開始までお待ちください');
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain('/api/broadcast/stats');
  });
});

describe('VideoPlayer controls', () => {
  it('unmutes on tap, toggles mute, and requests fullscreen', async () => {
    mockApi({ 'GET /api/broadcast': broadcast('live') });
    const stream = { id: 's' } as unknown as MediaStream;
    stage.useViewerStage.mockReturnValue({ stream, state: 'connected', error: null });
    renderPage(<WatchPage />);
    const video = await screen.findByLabelText<HTMLVideoElement>('配信映像');
    expect(video.srcObject).toBe(stream);
    expect(video.muted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'タップして音声オン' }));
    expect(video.muted).toBe(false);
    expect(screen.queryByRole('button', { name: 'タップして音声オン' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ミュート' }));
    expect(video.muted).toBe(true);
    expect(screen.getByRole('button', { name: 'ミュート解除' })).toHaveAttribute('aria-pressed', 'true');
    const requestFullscreen = vi.fn(async () => undefined);
    (video.parentElement as HTMLElement).requestFullscreen = requestFullscreen;
    fireEvent.click(screen.getByRole('button', { name: '全画面表示' }));
    expect(requestFullscreen).toHaveBeenCalled();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => video.parentElement });
    act(() => { document.dispatchEvent(new Event('fullscreenchange')); });
    expect(screen.getByRole('button', { name: '全画面を終了' })).toBeInTheDocument();
    const exitFullscreen = vi.fn(async () => undefined);
    document.exitFullscreen = exitFullscreen;
    fireEvent.click(screen.getByRole('button', { name: '全画面を終了' }));
    expect(exitFullscreen).toHaveBeenCalled();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
  });

  it('falls back to iOS video fullscreen', async () => {
    mockApi({ 'GET /api/broadcast': broadcast('live') });
    stage.useViewerStage.mockReturnValue({ stream: null, state: 'connected', error: null });
    renderPage(<WatchPage />);
    const video = await screen.findByLabelText<HTMLVideoElement & { webkitEnterFullscreen?: () => void }>('配信映像');
    Object.defineProperty(video.parentElement, 'requestFullscreen', { configurable: true, value: undefined });
    video.webkitEnterFullscreen = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: '全画面表示' }));
    await waitFor(() => expect(video.webkitEnterFullscreen).toHaveBeenCalled());
  });
});
