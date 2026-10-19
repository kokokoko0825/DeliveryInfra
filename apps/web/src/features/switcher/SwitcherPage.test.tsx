import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTrack, installMediaGlobals, stageMock, tokenResponse, type FakeSession } from '@/lib/ivs/testing';

const sessions = vi.hoisted(() => [] as FakeSession[]);
const api = vi.hoisted(() => ({
  requestStageTokens: vi.fn(), fetchBroadcast: vi.fn(), startBroadcast: vi.fn(), stopBroadcast: vi.fn(), fetchBroadcastStats: vi.fn(), fetchStatus: vi.fn(),
}));
const graph = vi.hoisted(() => ({
  track: { kind: 'audio' }, resume: vi.fn(), setChannelTrack: vi.fn(), setGain: vi.fn(), setMasterGain: vi.fn(),
  levels: vi.fn(() => ({ channels: new Map(), master: 0 })), close: vi.fn(),
}));
const clock = vi.hoisted(() => ({ tick: null as null | (() => void) }));
const renders = vi.hoisted(() => ({ comments: 0 }));
vi.mock('@/lib/ivs/stage', () => stageMock(sessions));
vi.mock('@/lib/ivs/mediaApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/ivs/mediaApi')>()), ...api }));
vi.mock('./media/audioGraph', () => ({ createAudioGraph: () => graph }));
vi.mock('./media/frameClock', () => ({ startFrameClock: (_fps: number, tick: () => void) => { clock.tick = tick; return () => { clock.tick = null; }; } }));
vi.mock('@/features/viewer/CommentPanel', () => ({
  useAdminModeration: () => ({ onDelete: vi.fn(), onSuspend: vi.fn() }),
  CommentPanel: ({ moderation }: { moderation?: unknown }) => {
    renders.comments += 1;
    return <section aria-label="コメント">{moderation ? 'moderation' : 'viewer'}</section>;
  },
}));

const { default: SwitcherPage } = await import('./SwitcherPage');
const { createStageSession } = await import('@/lib/ivs/stage');

const idle = { id: 'b0', title: '', status: 'idle', startedAt: null, endedAt: null };
const live = { id: 'b1', title: '定例会', status: 'live', startedAt: new Date(Date.now() - 65_000).toISOString(), endedAt: null };
const status = { stages: ['production', 'slide', 'broadcast'].map((name) => ({ name, exists: true, status: 'IDLE' })), chatRoom: { exists: true } };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><SwitcherPage /></QueryClientProvider>);
}
const sessionFor = (token: string) => sessions.find((session) => session.token === token);
async function startSwitcher() {
  fireEvent.click(screen.getByRole('button', { name: 'スイッチャーを起動' }));
  await waitFor(() => expect(sessions).toHaveLength(2));
}
const tile = (name: RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  sessions.length = 0;
  installMediaGlobals();
  Object.values(graph).forEach((value) => typeof value === 'function' && 'mockClear' in value && value.mockClear());
  graph.resume.mockResolvedValue(undefined);
  api.requestStageTokens.mockReset().mockResolvedValue(tokenResponse(['production', 'slide', 'broadcast']));
  api.fetchBroadcast.mockReset().mockResolvedValue(idle);
  api.startBroadcast.mockReset().mockResolvedValue(live);
  api.stopBroadcast.mockReset().mockResolvedValue({ ...live, status: 'ended', endedAt: new Date().toISOString() });
  api.fetchBroadcastStats.mockReset().mockResolvedValue({ viewerCount: 42 });
  api.fetchStatus.mockReset().mockResolvedValue(status);
  HTMLCanvasElement.prototype.captureStream = vi.fn(() => ({ getVideoTracks: () => [new FakeTrack('video')] })) as unknown as typeof HTMLCanvasElement.prototype.captureStream;
});

describe('SwitcherPage (A-01)', () => {
  it('shows the preflight check and the moderation comment panel', async () => {
    renderPage();
    expect(await screen.findByText('配信の準備ができています')).toBeInTheDocument();
    expect(screen.getByText('制作用ステージ')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'コメント' })).toHaveTextContent('moderation');
    expect(screen.getByRole('button', { name: '配信開始' })).toBeDisabled();
  });

  it('subscribes to production and slide stages with switcher tokens', async () => {
    renderPage();
    await startSwitcher();
    expect(api.requestStageTokens).toHaveBeenCalledWith('switcher');
    expect(sessionFor('tok-production')?.options).toMatchObject({ publish: false, subscribe: true });
    expect(sessionFor('tok-slide')?.options).toMatchObject({ publish: false, subscribe: true });
    expect(graph.resume).toHaveBeenCalled();
    expect(clock.tick).not.toBeNull();
    expect(await screen.findByText('制作用:')).toBeInTheDocument();
  });

  it('lists cameras in the multiview and switches with keys (1, Space)', async () => {
    renderPage();
    await startSwitcher();
    const production = sessionFor('tok-production')!;
    act(() => production.handlers.onStreamsAdded?.({ id: 'p2', kind: 'camera', deviceName: 'CAM2' }, [{ kind: 'video', track: new FakeTrack('video') as unknown as MediaStreamTrack }]));
    act(() => production.handlers.onStreamsAdded?.({ id: 'p1', kind: 'camera', deviceName: 'CAM1' }, [{ kind: 'video', track: new FakeTrack('video') as unknown as MediaStreamTrack }]));
    expect(tile(/^1: CAM1/)).toBeInTheDocument();
    expect(tile(/^2: CAM2/)).toBeInTheDocument();
    expect(tile(/^3: カメラ 3（未接続）/)).toBeDisabled();
    fireEvent.keyDown(window, { key: '1' });
    expect(tile(/^1: CAM1/)).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { key: ' ' });
    expect(tile(/^1: CAM1.*番組出力中/)).toBeInTheDocument();
    expect(tile(/^8: 待機画面/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('runs a timed transition with Enter and finishes on the frame clock', async () => {
    renderPage();
    await startSwitcher();
    fireEvent.keyDown(window, { key: '7' });
    expect(tile(/^7: スライド/)).toHaveAttribute('aria-pressed', 'true');
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByRole('button', { name: /トランジション/ })).toBeDisabled();
    now.mockReturnValue(1600);
    act(() => clock.tick?.());
    expect(tile(/^7: スライド.*番組出力中/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /トランジション/ })).toBeEnabled();
    now.mockRestore();
  });

  it('does not switch the program when Enter/Space opens the shortcut list (R3-05)', async () => {
    renderPage();
    await startSwitcher();
    fireEvent.keyDown(window, { key: '7' });
    const summary = screen.getByText('キーボードショートカット');
    fireEvent.keyDown(summary, { key: 'Enter' });
    fireEvent.keyDown(summary, { key: ' ' });
    expect(tile(/^7: スライド/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /番組出力中/ })).toHaveAccessibleName(/^8: 待機画面/);
  });

  it('keeps the preview chosen during a transition (R3-06)', async () => {
    renderPage();
    await startSwitcher();
    fireEvent.keyDown(window, { key: '7' });
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: '8' });
    now.mockReturnValue(1600);
    act(() => clock.tick?.());
    expect(tile(/^7: スライド.*番組出力中/)).toBeInTheDocument();
    expect(tile(/^8: 待機画面/)).toHaveAttribute('aria-pressed', 'true');
    now.mockRestore();
  });

  it('updates level meters without re-rendering the whole page (R3-10)', async () => {
    renderPage();
    await startSwitcher();
    graph.levels.mockReturnValue({ channels: new Map(), master: 50 });
    const masterIndicator = () => screen.getByRole('progressbar', { name: '全体 のレベル' }).querySelector<HTMLElement>('[data-slot="progress-indicator"]');
    await waitFor(() => expect(masterIndicator()?.style.transform).toBe('translateX(-50%)'));
    const before = renders.comments;
    const calls = graph.levels.mock.calls.length;
    await act(() => new Promise((resolve) => setTimeout(resolve, 650)));
    expect(graph.levels.mock.calls.length).toBeGreaterThan(calls + 2);
    expect(renders.comments).toBe(before);
    graph.levels.mockReturnValue({ channels: new Map(), master: 0 });
  });

  it('ignores shortcuts while typing in an input', async () => {
    renderPage();
    await startSwitcher();
    fireEvent.keyDown(screen.getByLabelText('配信タイトル'), { key: '7' });
    expect(tile(/^7: スライド/)).toHaveAttribute('aria-pressed', 'false');
  });

  it('routes mic audio to the mixer and mutes per channel', async () => {
    renderPage();
    await startSwitcher();
    const mic = new FakeTrack('audio') as unknown as MediaStreamTrack;
    act(() => sessionFor('tok-production')!.handlers.onStreamsAdded?.({ id: 'm1', kind: 'mic', deviceName: 'MIC1' }, [{ kind: 'audio', track: mic }]));
    expect(graph.setChannelTrack).toHaveBeenCalledWith('mic:MIC1', mic);
    expect(graph.setGain).toHaveBeenLastCalledWith('mic:MIC1', expect.closeTo(0.64));
    fireEvent.click(screen.getByRole('button', { name: 'MIC1 をミュート' }));
    expect(graph.setGain).toHaveBeenLastCalledWith('mic:MIC1', 0);
    fireEvent.click(screen.getByRole('button', { name: '全体 をミュート' }));
    expect(graph.setMasterGain).toHaveBeenLastCalledWith(0);
    act(() => sessionFor('tok-production')!.handlers.onParticipantLeft?.({ id: 'm1', kind: 'mic', deviceName: 'MIC1' }));
    expect(graph.setChannelTrack).toHaveBeenLastCalledWith('mic:MIC1', null);
  });

  it('starts the broadcast after confirmation: publishes the program then calls the API (F-SW-08, 09)', async () => {
    renderPage();
    await startSwitcher();
    fireEvent.change(screen.getByLabelText('配信タイトル'), { target: { value: '10月定例会' } });
    fireEvent.click(screen.getByRole('button', { name: '配信開始' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('「10月定例会」を視聴者に配信し');
    expect(api.startBroadcast).not.toHaveBeenCalled();
    api.fetchBroadcast.mockResolvedValue(live);
    fireEvent.click(within(dialog).getByRole('button', { name: '配信開始' }));
    await waitFor(() => expect(api.startBroadcast).toHaveBeenCalledWith('10月定例会'));
    const broadcast = sessionFor('tok-broadcast')!;
    expect(broadcast.options.publish).toBe(true);
    expect(broadcast.options.tracks.map((track) => track.track.kind)).toEqual(['video', 'audio']);
    expect(broadcast.options.tracks.map((track) => track.config)).toEqual([{ maxVideoBitrateKbps: 2500, maxFramerate: 30 }, { maxAudioBitrateKbps: 128, stereo: true }]);
    expect(await screen.findByText('LIVE')).toBeInTheDocument();
    expect(await screen.findByText('42人')).toBeInTheDocument();
    // 3ステージとも1回の応答のトークンを使う（R1-02）
    expect(api.requestStageTokens).toHaveBeenCalledTimes(1);
  });

  it('validates the broadcast title', async () => {
    renderPage();
    await startSwitcher();
    fireEvent.change(screen.getByLabelText('配信タイトル'), { target: { value: '   ' } });
    expect(screen.getByRole('alert')).toHaveTextContent('タイトルは1〜100文字で入力してください');
    expect(screen.getByRole('button', { name: '配信開始' })).toBeDisabled();
  });

  it('stops publishing when the start API fails', async () => {
    api.startBroadcast.mockRejectedValue(new Error('失敗'));
    renderPage();
    await startSwitcher();
    fireEvent.change(screen.getByLabelText('配信タイトル'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: '配信開始' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '配信開始' }));
    await waitFor(() => expect(sessionFor('tok-broadcast')?.leave).toHaveBeenCalled());
  });

  it('resumes publishing when opened during a live broadcast and stops after confirmation', async () => {
    // 経過時間はテスト開始時点から数える（ファイル読み込みからの時間に左右されないように）
    api.fetchBroadcast.mockResolvedValue({ ...live, startedAt: new Date(Date.now() - 65_000).toISOString() });
    renderPage();
    expect(await screen.findByText('LIVE')).toBeInTheDocument();
    expect(screen.getByText(/^0:01:0/)).toBeInTheDocument();
    await startSwitcher();
    await waitFor(() => expect(sessionFor('tok-broadcast')).toBeDefined());
    api.fetchBroadcast.mockResolvedValue({ ...live, status: 'ended' });
    fireEvent.click(screen.getByRole('button', { name: '配信終了' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '配信終了' }));
    await waitFor(() => expect(api.stopBroadcast).toHaveBeenCalled());
    await waitFor(() => expect(sessionFor('tok-broadcast')?.leave).toHaveBeenCalled());
    expect(sessions.filter((session) => session.token === 'tok-broadcast')).toHaveLength(1);
  });

  it('keeps retrying to resume the program when the first attempt fails (R3-04)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const create = vi.mocked(createStageSession);
    const original = create.getMockImplementation()!;
    let failed = false;
    create.mockImplementation((token, options, handlers) => {
      const session = original(token, options, handlers);
      // 最初の番組送信の join だけ失敗させる（一瞬の回線不調）
      if (token === 'tok-broadcast' && !failed) {
        failed = true;
        vi.mocked(session.join).mockRejectedValueOnce(new Error('join failed'));
      }
      return session;
    });
    api.fetchBroadcast.mockResolvedValue(live);
    renderPage();
    expect(await screen.findByText('LIVE')).toBeInTheDocument();
    await startSwitcher();
    await waitFor(() => expect(sessionFor('tok-broadcast')).toBeDefined());
    await act(() => vi.advanceTimersByTimeAsync(2000));
    const broadcasts = () => sessions.filter((session) => session.token === 'tok-broadcast');
    await waitFor(() => expect(broadcasts()).toHaveLength(2));
    expect(broadcasts()[1]?.join).toHaveBeenCalled();
    expect(screen.getByText('配信用:').parentElement).toHaveTextContent('接続済み');
    // 再開できた後は重ねて送信を始めない
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(broadcasts()).toHaveLength(2);
    create.mockImplementation(original);
    vi.useRealTimers();
  });

  it('enables PiP on the preview with corner and size choices', async () => {
    renderPage();
    await startSwitcher();
    fireEvent.keyDown(window, { key: '7' });
    fireEvent.click(screen.getByRole('switch', { name: /PiP/ }));
    expect(screen.getByRole('radio', { name: '右下' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '中' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: '左上' }));
    expect(screen.getByRole('radio', { name: '左上' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('switch', { name: /PiP/ }));
    expect(screen.queryByRole('radio', { name: '左上' })).not.toBeInTheDocument();
  });

  it('rejects a non-image standby file', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('静止画（PNG / JPEG）'), { target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] } });
    expect(await screen.findByText('画像ファイルを選んでください')).toBeInTheDocument();
  });

  it('reconnects a lost receive stage and clears its participants', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage();
    await startSwitcher();
    const production = sessionFor('tok-production')!;
    act(() => production.handlers.onStreamsAdded?.({ id: 'p1', kind: 'camera', deviceName: 'CAM1' }, [{ kind: 'video', track: new FakeTrack('video') as unknown as MediaStreamTrack }]));
    expect(tile(/^1: CAM1/)).toBeInTheDocument();
    act(() => production.handlers.onRecoverableLoss?.('errored'));
    expect(screen.getByText('再接続中')).toBeInTheDocument();
    expect(tile(/^1: カメラ 1/)).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(sessions.filter((session) => session.token === 'tok-production')).toHaveLength(2));
    // 取り直すのは再接続したときだけ（R1-02）
    expect(api.requestStageTokens).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
