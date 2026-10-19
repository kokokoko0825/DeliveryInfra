import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route } from 'react-router';
import { apiError, bodyOf, callsTo, makeAuth, makeMe, mockApi, renderPage } from '@/test/render';
import { resetFileCookies } from '@/lib/files';

const hls = vi.hoisted(() => {
  const instances: { loadSource: ReturnType<typeof vi.fn>; attachMedia: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; startLoad: ReturnType<typeof vi.fn>; config: unknown }[] = [];
  const Hls = Object.assign(vi.fn(function (this: Record<string, unknown>, config: unknown) {
    Object.assign(this, { loadSource: vi.fn(), attachMedia: vi.fn(), destroy: vi.fn(), on: vi.fn(), startLoad: vi.fn(), config });
    instances.push(this as never);
  }), { isSupported: vi.fn(() => true), Events: { ERROR: 'hlsError', FRAG_LOADED: 'hlsFragLoaded' }, ErrorTypes: { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' } });
  return { Hls, instances };
});
vi.mock('hls.js', () => ({ default: hls.Hls }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const { default: ArchivesPage } = await import('./ArchivesPage');
const { default: ArchiveDetailPage } = await import('./ArchiveDetailPage');

const archive = (id: string, published = true) => ({ id, title: `録画${id}`, published, durationSeconds: 3725, playbackPath: `/files/archives/${id}/media/hls/multivariant.m3u8`, retainUntil: '2027-10-19T00:00:00.000Z' });
const admin = () => makeAuth({ me: makeMe({ role: 'admin' }) });
afterEach(() => { vi.unstubAllGlobals(); resetFileCookies(); hls.instances.length = 0; vi.clearAllMocks(); });

describe('ArchivesPage (U-04)', () => {
  it('lists archives with play links and no admin controls for viewers', async () => {
    mockApi({ 'GET /api/archives': [archive('a1')] });
    renderPage(<ArchivesPage />);
    expect(await screen.findByText('録画a1')).toBeInTheDocument();
    expect(screen.getByText('再生時間 1:02:05')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '再生' })).toHaveAttribute('href', '/archives/a1');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText('公開中')).not.toBeInTheDocument();
    expect(screen.queryByText(/保存期限/)).not.toBeInTheDocument();
  });

  it('shows empty and error states', async () => {
    mockApi({ 'GET /api/archives': [] });
    const { unmount } = renderPage(<ArchivesPage />);
    expect(await screen.findByText('視聴できるアーカイブはまだありません')).toBeInTheDocument();
    unmount();
    mockApi({ 'GET /api/archives': apiError(500, 'X', '取得失敗') });
    renderPage(<ArchivesPage />);
    expect(await screen.findByText('取得失敗')).toBeInTheDocument();
  });

  it('lets admins publish / unpublish', async () => {
    const fetchMock = mockApi({ 'GET /api/archives': [archive('a1', false)], 'PATCH /api/archives/a1': archive('a1', true) });
    renderPage(<ArchivesPage />, { auth: admin() });
    expect(await screen.findByText('非公開')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: '公開' }));
    await waitFor(() => expect(callsTo(fetchMock, 'PATCH /api/archives/a1')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, 'PATCH /api/archives/a1')[0])).toEqual({ published: true });
  });

  it('lets admins rename with validation', async () => {
    const fetchMock = mockApi({ 'GET /api/archives': [archive('a1')], 'PATCH /api/archives/a1': archive('a1') });
    renderPage(<ArchivesPage />, { auth: admin() });
    fireEvent.click(await screen.findByRole('button', { name: '録画a1 のタイトルを変更' }));
    const input = await screen.findByLabelText('タイトル');
    expect(input).toHaveValue('録画a1');
    fireEvent.change(input, { target: { value: 'あ'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText('100文字以内で入力してください')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '新タイトル' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(bodyOf(callsTo(fetchMock, 'PATCH /api/archives/a1')[0])).toEqual({ title: '新タイトル' }));
    await waitFor(() => expect(screen.queryByLabelText('タイトル')).not.toBeInTheDocument());
  });

  it('shows the retention date and lets admins extend it with a date input (R1-22)', async () => {
    const fetchMock = mockApi({ 'GET /api/archives': [archive('a1')], 'PATCH /api/archives/a1': archive('a1') });
    renderPage(<ArchivesPage />, { auth: admin() });
    expect(await screen.findByText('保存期限 2027/10/19')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '録画a1 の保存期限を延長' }));
    const input = await screen.findByLabelText('新しい保存期限');
    expect(input).toHaveAttribute('type', 'date');
    expect(input).toHaveValue('2027-10-19');
    fireEvent.click(screen.getByRole('button', { name: '延長' }));
    expect(await screen.findByText('2027/10/19 より後の日付を選択してください')).toBeInTheDocument();
    expect(callsTo(fetchMock, 'PATCH /api/archives/a1')).toHaveLength(0);
    fireEvent.change(input, { target: { value: '2028-03-31' } });
    fireEvent.click(screen.getByRole('button', { name: '延長' }));
    await waitFor(() => expect(bodyOf(callsTo(fetchMock, 'PATCH /api/archives/a1')[0])).toEqual({ retainUntil: '2028-03-31T14:59:59.000Z' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('保存期限を延長しました'));
    await waitFor(() => expect(screen.queryByLabelText('新しい保存期限')).not.toBeInTheDocument());
  });

  it('lets admins delete after confirmation and reports errors', async () => {
    const fetchMock = mockApi({ 'GET /api/archives': [archive('a1')], 'DELETE /api/archives/a1': { success: true } });
    renderPage(<ArchivesPage />, { auth: admin() });
    fireEvent.click(await screen.findByRole('button', { name: '録画a1 を削除' }));
    expect(callsTo(fetchMock, 'DELETE /api/archives/a1')).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('アーカイブを削除しました'));
    mockApi({ 'GET /api/archives': [archive('a1')], 'DELETE /api/archives/a1': apiError(500, 'X', '削除失敗') });
    fireEvent.click(await screen.findByRole('button', { name: '録画a1 を削除' }));
    fireEvent.click(await screen.findByRole('button', { name: '削除' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('削除失敗'));
  });
});

describe('ArchiveDetailPage (U-04)', () => {
  const openDetail = (id = 'a1') => renderPage(<></>, { path: `/archives/${id}`, route: '/none', extraRoutes: <Route path="/archives/:id" element={<ArchiveDetailPage />} /> });

  it('plays the API-provided playback path with hls.js and blocks download', async () => {
    const fetchMock = mockApi({ 'GET /api/archives': [archive('a1')], 'POST /api/archives/a1/cookies': {} });
    HTMLMediaElement.prototype.canPlayType = vi.fn((): CanPlayTypeResult => '');
    openDetail();
    const video = await screen.findByLabelText<HTMLVideoElement>('録画a1');
    // 当該アーカイブ専用の Cookie だけを取る（R1-08）
    expect(callsTo(fetchMock, 'POST /api/archives/a1/cookies')).toHaveLength(1);
    expect(callsTo(fetchMock, 'POST /api/files/cookies')).toHaveLength(0);
    expect(video).toHaveAttribute('controlslist', 'nodownload noremoteplayback');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    video.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    const instance = hls.instances[0]!;
    expect(instance.loadSource).toHaveBeenCalledWith('/files/archives/a1/media/hls/multivariant.m3u8');
    expect(instance.attachMedia).toHaveBeenCalledWith(video);
    const xhr = { withCredentials: false };
    (instance.config as { xhrSetup: (x: typeof xhr) => void }).xhrSetup(xhr);
    expect(xhr.withCredentials).toBe(true);
    const onError = instance.on.mock.calls[0]?.[1] as (e: unknown, d: { fatal: boolean }) => void;
    onError(null, { fatal: false });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    onError(null, { fatal: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('再生中にエラーが発生しました');
  });

  it('re-issues this archive\'s cookies and resumes when a segment returns 403 (R3-03)', async () => {
    const fetchMock = mockApi({ 'GET /api/archives': [archive('a1')], 'POST /api/archives/a1/cookies': {} });
    HTMLMediaElement.prototype.canPlayType = vi.fn((): CanPlayTypeResult => '');
    openDetail();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    expect(callsTo(fetchMock, 'POST /api/archives/a1/cookies')).toHaveLength(1);
    const instance = hls.instances[0]!;
    const onError = instance.on.mock.calls.find(([event]) => event === 'hlsError')?.[1] as (e: unknown, d: unknown) => void;
    // 発行から50分以内でも、403 なら取り直す
    onError(null, { fatal: true, type: 'networkError', response: { url: 'seg.ts', code: 403 } });
    await waitFor(() => expect(callsTo(fetchMock, 'POST /api/archives/a1/cookies')).toHaveLength(2));
    await waitFor(() => expect(instance.startLoad).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses native HLS on Safari', async () => {
    mockApi({ 'GET /api/archives': [archive('a1')], 'POST /api/archives/a1/cookies': {} });
    HTMLMediaElement.prototype.canPlayType = vi.fn((): CanPlayTypeResult => 'maybe');
    HTMLMediaElement.prototype.load = vi.fn();
    const { unmount } = openDetail();
    const video = await screen.findByLabelText<HTMLVideoElement>('録画a1');
    await waitFor(() => expect(video.getAttribute('src')).toBe('/files/archives/a1/media/hls/multivariant.m3u8'));
    expect(hls.instances).toHaveLength(0);
    unmount();
    expect(video.getAttribute('src')).toBeNull();
  });

  it('reports unsupported browsers, missing archives and cookie errors', async () => {
    mockApi({ 'GET /api/archives': [archive('a1')], 'POST /api/archives/a1/cookies': {} });
    HTMLMediaElement.prototype.canPlayType = vi.fn((): CanPlayTypeResult => '');
    hls.Hls.isSupported.mockReturnValueOnce(false);
    const first = openDetail();
    expect(await screen.findByRole('alert')).toHaveTextContent('このブラウザではアーカイブを再生できません');
    first.unmount();
    resetFileCookies();
    mockApi({ 'GET /api/archives': [archive('a1')], 'POST /api/archives/zz/cookies': apiError(403, 'F', '拒否') });
    const second = openDetail('zz');
    expect(await screen.findByText('アーカイブが見つかりません')).toBeInTheDocument();
    expect(await screen.findByText('再生の準備に失敗しました: 拒否')).toBeInTheDocument();
    second.unmount();
    mockApi({ 'GET /api/archives': apiError(500, 'X', '一覧失敗'), 'POST /api/archives/a1/cookies': {} });
    openDetail();
    expect(await screen.findByText('一覧失敗')).toBeInTheDocument();
  });

  it('destroys hls.js on unmount', async () => {
    mockApi({ 'GET /api/archives': [archive('a1')], 'POST /api/archives/a1/cookies': {} });
    HTMLMediaElement.prototype.canPlayType = vi.fn((): CanPlayTypeResult => '');
    const { unmount } = openDetail();
    await waitFor(() => expect(hls.instances).toHaveLength(1));
    unmount();
    expect(hls.instances[0]?.destroy).toHaveBeenCalled();
  });
});
