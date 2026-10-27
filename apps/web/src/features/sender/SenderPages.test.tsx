import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { clearClientDiagnostics, listClientDiagnostics } from '@/lib/diagnostics';
import { FakeMediaStream, FakeTrack, installMediaGlobals, stageMock, tokenResponse, type FakeSession } from '@/lib/ivs/testing';

const sessions = vi.hoisted(() => [] as FakeSession[]);
const api = vi.hoisted(() => ({ requestStageTokens: vi.fn(), sendHeartbeat: vi.fn(), releaseDevice: vi.fn(), fetchDeviceNamesInUse: vi.fn() }));
const venueAudio = vi.hoisted(() => ({ start: vi.fn() }));
const micGraph = vi.hoisted(() => ({ prepare: vi.fn(), create: vi.fn() }));
const runLog = vi.hoisted(() => ({ create: vi.fn(), append: vi.fn(), end: vi.fn() }));
vi.mock('@/lib/ivs/stage', () => stageMock(sessions));
vi.mock('@/lib/ivs/mediaApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/ivs/mediaApi')>()), ...api }));
vi.mock('@/features/venue/venueAudio', () => ({ startVenueMic: venueAudio.start }));
vi.mock('@/features/venue/VenueMicPage', () => ({ VenueRunControls: () => null, metricsValues: () => ({ connectedPeers: 0 }) }));
vi.mock('@/features/venue/venueRunLog', () => ({ createVenueRun: runLog.create, appendVenueRunRecord: runLog.append, endVenueRun: runLog.end }));
vi.mock('./micAudioGraph', () => ({ prepareMicAudio: micGraph.prepare, createMicAudioGraph: micGraph.create }));

const { default: CameraSendPage } = await import('./CameraSendPage');
const { default: MicSendPage } = await import('./MicSendPage');
const { default: SlideSharePage } = await import('./SlideSharePage');

const getUserMedia = vi.fn();
const getDisplayMedia = vi.fn();

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  clearClientDiagnostics();
  sessions.length = 0;
  installMediaGlobals();
  api.requestStageTokens.mockReset().mockImplementation((purpose: string) => Promise.resolve(tokenResponse([purpose === 'slide' ? 'slide' : 'production'], 'dev-1')));
  api.sendHeartbeat.mockReset().mockResolvedValue({ expiresAt: '2026-10-19T00:00:00.000Z' });
  api.releaseDevice.mockReset().mockResolvedValue(undefined);
  api.fetchDeviceNamesInUse.mockReset().mockResolvedValue({ inUse: [] });
  venueAudio.start.mockReset().mockResolvedValue({ close: vi.fn(), connected: Promise.resolve(), getMetrics: () => ({ slot: 1 }) });
  runLog.create.mockReset().mockResolvedValue(undefined);
  runLog.append.mockReset().mockResolvedValue(true);
  runLog.end.mockReset().mockResolvedValue(undefined);
  micGraph.prepare.mockReset().mockImplementation((existing?: { context: object }) => ({ context: existing?.context ?? { state: 'running', resume: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) }, ready: Promise.resolve() }));
  micGraph.create.mockReset().mockImplementation((rawTrack: FakeTrack, prepared: { context: object; ready: Promise<void> }) => Promise.resolve({
    context: prepared.context, ready: prepared.ready, source: { id: 'shared-input' },
    streamTrack: new FakeTrack('audio', 'processed-stream'), dspMode: 'processed', level: () => 0,
    bypassDsp: vi.fn(), close: vi.fn(), rawTrack,
  }));
  getUserMedia.mockReset().mockImplementation((constraints: MediaStreamConstraints) =>
    Promise.resolve(new FakeMediaStream([new FakeTrack(constraints.video ? 'video' : 'audio')])));
  getDisplayMedia.mockReset().mockImplementation(() => Promise.resolve(new FakeMediaStream([new FakeTrack('video'), new FakeTrack('audio')])));
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia, getDisplayMedia }, configurable: true });
  vi.stubGlobal('AudioContext', undefined);
});

describe('CameraSendPage (S-01)', () => {
  it('opens the back camera for preview without audio and sends as CAM1', async () => {
    render(<CameraSendPage />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({ audio: false, video: { facingMode: { ideal: 'environment' } } });
    expect(screen.getByRole('status')).toHaveTextContent('未接続');
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    expect(api.requestStageTokens).toHaveBeenCalledWith('camera', 'CAM1', false);
    expect(sessions[0]?.options.tracks).toHaveLength(1);
    expect(sessions[0]?.options.tracks[0]?.track.kind).toBe('video');
    expect(sessions[0]?.options.tracks[0]?.config).toEqual({ maxVideoBitrateKbps: 2000, maxFramerate: 30 });
  });

  it('selects the front camera before publishing and sends that track', async () => {
    render(<CameraSendPage />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    const first = (await getUserMedia.mock.results[0]?.value) as FakeMediaStream;
    fireEvent.click(screen.getByRole('radio', { name: '前面' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(first.tracks[0]?.stop).toHaveBeenCalled();
    expect(getUserMedia.mock.calls[1]?.[0]).toMatchObject({ video: { facingMode: { ideal: 'user' } } });
    const front = (await getUserMedia.mock.results[1]?.value) as FakeMediaStream;
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    expect(sessions[0]?.options.tracks[0]?.track).toBe(front.tracks[0]);
  });

  it('shows the 7th camera rejection message (F-CAM-06)', async () => {
    api.requestStageTokens.mockRejectedValue(new ApiError(409, 'DEVICE_LIMIT', '上限'));
    render(<CameraSendPage />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('カメラは最大6台まで接続できます');
    expect(screen.getByRole('status')).toHaveTextContent('エラー');
  });

  it('stops a camera stream that arrives after a newer switch (R3-09)', async () => {
    const pending: ((stream: FakeMediaStream) => void)[] = [];
    getUserMedia.mockReset().mockImplementation(() => new Promise<FakeMediaStream>((resolve) => pending.push(resolve)));
    render(<CameraSendPage />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('radio', { name: '前面' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    const stale = new FakeMediaStream([new FakeTrack('video')]);
    const fresh = new FakeMediaStream([new FakeTrack('video')]);
    // 後から出した要求が先に返り、古い要求が後から返る
    await act(async () => pending[1]?.(fresh));
    await act(async () => pending[0]?.(stale));
    expect(stale.tracks[0]?.stop).toHaveBeenCalled();
    expect(fresh.tracks[0]?.stop).not.toHaveBeenCalled();
    expect((screen.getByLabelText('カメラのプレビュー') as HTMLVideoElement).srcObject).toBe(fresh);
  });

  it('stops a camera stream that arrives after leaving the page (R3-09)', async () => {
    let resolve: (stream: FakeMediaStream) => void = () => undefined;
    getUserMedia.mockReset().mockImplementation(() => new Promise<FakeMediaStream>((done) => { resolve = done; }));
    const { unmount } = render(<CameraSendPage />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    unmount();
    const late = new FakeMediaStream([new FakeTrack('video')]);
    await act(async () => resolve(late));
    expect(late.tracks[0]?.stop).toHaveBeenCalled();
  });

  it('preselects a free device name (R3-01)', async () => {
    api.fetchDeviceNamesInUse.mockResolvedValue({ inUse: ['CAM1', 'CAM2'] });
    render(<CameraSendPage />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: '端末名' })).toHaveTextContent('CAM3'));
    expect(api.fetchDeviceNamesInUse).toHaveBeenCalledWith('camera');
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await waitFor(() => expect(api.requestStageTokens).toHaveBeenCalledWith('camera', 'CAM3', false));
  });

  it('offers to take over the own device using the same name (R3-02)', async () => {
    api.requestStageTokens.mockRejectedValueOnce(new ApiError(409, 'DEVICE_NAME_IN_USE_SELF', '使用中'));
    render(<CameraSendPage />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('CAM1 はあなたの別の端末で送信中です');
    fireEvent.click(screen.getByRole('button', { name: 'この端末に切り替える' }));
    await screen.findByRole('button', { name: '送信停止' });
    expect(api.requestStageTokens).toHaveBeenLastCalledWith('camera', 'CAM1', true);
  });

  it('explains a denied camera permission', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    render(<CameraSendPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('カメラの使用が許可されていません');
    expect(listClientDiagnostics()).toMatchObject([{ source: 'media.camera.capture', name: 'NotAllowedError' }]);
  });

  it('stops sending and releases the slot', async () => {
    render(<CameraSendPage />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    fireEvent.click(await screen.findByRole('button', { name: '送信停止' }));
    expect(sessions[0]?.leave).toHaveBeenCalled();
    expect(api.releaseDevice).toHaveBeenCalledWith('dev-1');
    expect(screen.getByRole('status')).toHaveTextContent('未接続');
  });
});

describe('MicSendPage (S-02)', () => {
  it('captures once, sends the raw input to venue and the processed track to IVS', async () => {
    window.history.replaceState(null, '', '/send/mic?trialId=room_42');
    const closeVenue = vi.fn();
    venueAudio.start.mockResolvedValueOnce({ close: closeVenue, connected: Promise.resolve(), getMetrics: () => ({ slot: 1 }) });
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledOnce());
    const media = (await getUserMedia.mock.results[0]?.value) as FakeMediaStream;
    const raw = media.getAudioTracks()[0] as FakeTrack;
    const venueStream = venueAudio.start.mock.calls[0]?.[0] as FakeMediaStream;
    const venuePrepared = venueAudio.start.mock.calls[0]?.[2];
    expect(venueStream.getAudioTracks()[0]).toBe(raw);
    expect(venuePrepared).toMatchObject({ source: { id: 'shared-input' }, ownsContext: false });
    expect(raw.clone).not.toHaveBeenCalled();
    expect(runLog.create).toHaveBeenCalledWith(expect.objectContaining({ peers: expect.arrayContaining(['config.transport=pcm', 'config.route=web-audio', 'config.dsp=processed', 'config.trialId=room_42']) }));
    await waitFor(() => expect(runLog.append.mock.calls.some(([, item]) => item.type === 'health')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    expect(sessions[0]?.options.tracks[0]?.track).toBe((await micGraph.create.mock.results[0]?.value).streamTrack);
    expect(getUserMedia).toHaveBeenCalledOnce();
    fireEvent.click(toggle);
    expect(closeVenue).toHaveBeenCalledOnce();
    await waitFor(() => expect(runLog.end).toHaveBeenCalledOnce());
    expect(raw.stop).not.toHaveBeenCalled();
    expect(sessions[0]?.leave).not.toHaveBeenCalled();
  });

  it('shares a pending microphone capture between venue and IVS', async () => {
    let finish: (media: FakeMediaStream) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise<FakeMediaStream>((resolve) => { finish = resolve; }));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('switch', { name: '会場スピーカーにも送信' }));
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(getUserMedia).toHaveBeenCalledOnce();
    await act(async () => finish(new FakeMediaStream([new FakeTrack('audio')])));
    await screen.findByRole('button', { name: '送信停止' });
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledOnce());
    expect(micGraph.create).toHaveBeenCalledOnce();
  });

  it('requests AEC, NS and AGC off without blocking unreported settings', async () => {
    const source = new FakeTrack('audio');
    source.getSettings.mockReturnValueOnce({ deviceId: source.sourceId } as ReturnType<typeof source.getSettings>);
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([source]));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    expect(screen.getByText(/マイクの音声処理設定を確認できません/)).toBeInTheDocument();
    expect(sessions[0]?.options.tracks[0]?.config).toEqual({ maxAudioBitrateKbps: 64 });
  });

  it('continues when browser capture settings cannot be read', async () => {
    const source = new FakeTrack('audio');
    source.getSettings.mockImplementationOnce(() => { throw new Error('settings unavailable'); });
    const getSupportedConstraints = vi.fn(() => { throw new Error('constraint query unavailable'); });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia, getSupportedConstraints }, configurable: true });
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([source]));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    expect(screen.getByText(/マイクの音声処理設定を確認できません/)).toBeInTheDocument();
    expect(listClientDiagnostics().some((item) => item.source === 'media.microphone.get-settings' && item.message === 'settings unavailable')).toBe(true);
    expect(listClientDiagnostics().some((item) => item.source === 'media.microphone.get-supported-constraints' && item.message === 'constraint query unavailable')).toBe(true);
  });

  it('does not continue after the physical track ends during graph construction', async () => {
    let finishGraph: (value: Awaited<ReturnType<typeof micGraph.create>>) => void = () => undefined;
    const close = vi.fn();
    micGraph.create.mockImplementationOnce(() => new Promise((resolve) => { finishGraph = resolve; }));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    const source = ((await getUserMedia.mock.results[0]?.value) as FakeMediaStream).getAudioTracks()[0] as FakeTrack;
    act(() => source.end());
    await act(async () => finishGraph({ close } as unknown as Awaited<ReturnType<typeof micGraph.create>>));
    expect(close).toHaveBeenCalledOnce();
    expect(api.requestStageTokens).not.toHaveBeenCalled();
    expect(source.stop).toHaveBeenCalledOnce();
  });

  it('stops a capture that resolves after leaving the page', async () => {
    let finishCapture: (media: FakeMediaStream) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = resolve; }));
    const { unmount } = render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    unmount();
    const late = new FakeMediaStream([new FakeTrack('audio')]);
    await act(async () => finishCapture(late));
    expect(late.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(micGraph.create).not.toHaveBeenCalled();
  });

  it('closes a graph that finishes after leaving the page', async () => {
    let finishGraph: (value: Awaited<ReturnType<typeof micGraph.create>>) => void = () => undefined;
    micGraph.create.mockImplementationOnce(() => new Promise((resolve) => { finishGraph = resolve; }));
    const { unmount } = render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await waitFor(() => expect(micGraph.create).toHaveBeenCalledOnce());
    unmount();
    const close = vi.fn();
    const media = (await getUserMedia.mock.results[0]?.value) as FakeMediaStream;
    await act(async () => finishGraph({ close } as unknown as Awaited<ReturnType<typeof micGraph.create>>));
    expect(close).toHaveBeenCalledOnce();
    expect(media.tracks[0]?.stop).toHaveBeenCalledTimes(2);
  });

  it('does not construct audio graph for a microphone track that already ended', async () => {
    const source = new FakeTrack('audio');
    source.readyState = 'ended';
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([source]));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByText('マイク入力が切断されました')).toBeInTheDocument();
    expect(micGraph.create).not.toHaveBeenCalled();
    expect(api.requestStageTokens).not.toHaveBeenCalled();
  });

  it('handles a pending microphone permission rejection after page unmount', async () => {
    let deny: (reason: Error) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise((_, reject) => { deny = reject; }));
    const { unmount } = render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    unmount();
    await act(async () => deny(new DOMException('permission denied', 'NotAllowedError')));
    expect(api.requestStageTokens).not.toHaveBeenCalled();
    expect(micGraph.create).not.toHaveBeenCalled();
  });

  it('reports confirmed disabled capture processing in the venue run', async () => {
    const source = new FakeTrack('audio');
    source.getSettings.mockReturnValueOnce({
      deviceId: source.sourceId, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    });
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([source]));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('switch', { name: '会場スピーカーにも送信' }));
    await waitFor(() => expect(runLog.create).toHaveBeenCalled());
    expect(screen.getByText(/マイクの音声処理をオフで取得しました/)).toBeInTheDocument();
    expect(runLog.create).toHaveBeenCalledWith(expect.objectContaining({ peers: expect.arrayContaining([
      'config.capture.echoCancellation=false', 'config.capture.noiseSuppression=false', 'config.capture.autoGainControl=false',
    ]) }));
  });

  it('keeps venue transport running when the local run log cannot be created', async () => {
    runLog.create.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('switch', { name: '会場スピーカーにも送信' }));
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledOnce());
    expect(await screen.findByText(/会場音声: 接続中（DataChannel PCM）/)).toBeInTheDocument();
    expect(screen.getByText(/会場の計測ログを保存できませんでした/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '会場スピーカーにも送信' })).toBeChecked();
    expect(runLog.append).not.toHaveBeenCalled();
  });

  it('stops a failed capture and can retry graph setup', async () => {
    micGraph.create.mockRejectedValueOnce(new Error('Web Audio graph failed'));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByText('Web Audio graph failed')).toBeInTheDocument();
    const failedMedia = (await getUserMedia.mock.results[0]?.value) as FakeMediaStream;
    expect(failedMedia.getAudioTracks()[0]?.stop).toHaveBeenCalledOnce();
    expect(api.requestStageTokens).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('does not start IVS while the existing audio context cannot resume', async () => {
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: 'マイクを確認' }));
    await waitFor(() => expect(micGraph.create).toHaveBeenCalledOnce());
    micGraph.prepare.mockImplementationOnce((existing: { context: object }) => ({ context: existing.context, ready: Promise.reject(new Error('resume denied')) }));
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByText(/音声処理を再開できません/)).toBeInTheDocument();
    expect(api.requestStageTokens).not.toHaveBeenCalled();
  });

  it('mutes both branches with the common input track', async () => {
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    const raw = ((await getUserMedia.mock.results[0]?.value) as FakeMediaStream).getAudioTracks()[0] as FakeTrack & { enabled: boolean };
    fireEvent.click(screen.getByRole('switch', { name: 'ミュート（配信・会場の両方）' }));
    expect(raw.enabled).toBe(false);
    expect(sessions[0]?.setMuted).toHaveBeenLastCalledWith('audio', true);
    fireEvent.click(screen.getByRole('switch', { name: 'ミュート（配信・会場の両方）' }));
    expect(raw.enabled).toBe(true);
    expect(sessions[0]?.setMuted).toHaveBeenLastCalledWith('audio', false);
  });

  it('stops both destinations when the physical microphone ends', async () => {
    const closeVenue = vi.fn();
    venueAudio.start.mockResolvedValueOnce({ close: closeVenue, connected: Promise.resolve(), getMetrics: () => ({ slot: 1 }) });
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('switch', { name: '会場スピーカーにも送信' }));
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    const media = (await getUserMedia.mock.results[0]?.value) as FakeMediaStream;
    act(() => (media.getAudioTracks()[0] as FakeTrack).end());
    expect(closeVenue).toHaveBeenCalledOnce();
    expect(sessions[0]?.leave).toHaveBeenCalledOnce();
    expect(screen.getByText(/マイク入力が切断されました。端末を確認して/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '会場スピーカーにも送信' })).not.toBeChecked();
    expect(listClientDiagnostics().some((item) => item.source === 'media.microphone.track-ended')).toBe(true);
    await waitFor(() => expect(runLog.end).toHaveBeenCalledOnce());
  });

  it('remains usable after React StrictMode replays the mount cleanup', async () => {
    render(<StrictMode><MicSendPage /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(api.requestStageTokens).toHaveBeenCalledWith('mic', 'MIC1', false);
  });

  it('starts already muted when the switch was set before capture', async () => {
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('switch', { name: 'ミュート（配信・会場の両方）' }));
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    const raw = ((await getUserMedia.mock.results[0]?.value) as FakeMediaStream).getAudioTracks()[0] as FakeTrack & { enabled: boolean };
    expect(raw.enabled).toBe(false);
    expect(sessions[0]?.setMuted).toHaveBeenCalledWith('audio', true);
  });

  it('allows another attempt after a denied capture', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([new FakeTrack('audio')]));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('マイクの使用が許可されていません');
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('reports a venue connection failure while keeping IVS live', async () => {
    const performanceNow = vi.spyOn(performance, 'now').mockReturnValue(100);
    venueAudio.start.mockRejectedValueOnce(new Error('STUN connection failed'));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    fireEvent.click(screen.getByRole('switch', { name: '会場スピーカーにも送信' }));
    expect(await screen.findByText(/会場音声: STUN connection failed/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '会場スピーカーにも送信' })).not.toBeChecked();
    expect(sessions[0]?.leave).not.toHaveBeenCalled();
    await waitFor(() => expect(runLog.end).toHaveBeenCalledOnce());
    const records = runLog.append.mock.calls.map(([, item]) => item as { type: string; event?: string; code?: string; message?: string; detail?: string; elapsedMs?: number });
    expect(records.find((item) => item.type === 'error')).toMatchObject({ code: 'connection', message: 'STUN connection failed', elapsedMs: 0 });
    expect(records.find((item) => item.type === 'transport' && item.event === 'stop')).toMatchObject({ detail: 'connection-error' });
    expect(listClientDiagnostics().some((item) => item.source === 'venue.mic-send.start' && item.message === 'STUN connection failed')).toBe(true);
    performanceNow.mockRestore();
  });

  it('does not start venue when it is switched off during capture', async () => {
    let finish: (media: FakeMediaStream) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise<FakeMediaStream>((resolve) => { finish = resolve; }));
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await act(async () => finish(new FakeMediaStream([new FakeTrack('audio')])));
    expect(venueAudio.start).not.toHaveBeenCalled();
    expect(toggle).not.toBeChecked();
  });

  it('closes a venue session that resolves after the switch was turned off', async () => {
    let resolveStart: (session: { close: ReturnType<typeof vi.fn>; connected: Promise<void> }) => void = () => undefined;
    venueAudio.start.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledOnce());
    fireEvent.click(toggle);
    const close = vi.fn();
    await act(async () => resolveStart({ close, connected: Promise.resolve() }));
    expect(close).toHaveBeenCalledOnce();
    expect(toggle).not.toBeChecked();
  });

  it('ignores a stale venue connection failure after a newer session starts', async () => {
    let rejectOld: (reason: Error) => void = () => undefined;
    venueAudio.start
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
      .mockResolvedValueOnce({ close: vi.fn(), connected: Promise.resolve(), getMetrics: () => ({ slot: 1 }) });
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledOnce());
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledTimes(2));
    await act(async () => rejectOld(new Error('old route failed')));
    expect(toggle).toBeChecked();
    expect(screen.getByText(/会場音声: 接続中（DataChannel PCM）/)).toBeInTheDocument();
    expect(listClientDiagnostics().some((item) => item.message === 'old route failed')).toBe(false);
  });

  it('does not report an intentional venue stop as a connection error', async () => {
    let rejectConnected: (reason: Error) => void = () => undefined;
    const connected = new Promise<void>((_, reject) => { rejectConnected = reject; });
    venueAudio.start.mockResolvedValueOnce({
      close: () => rejectConnected(new DOMException('closed', 'AbortError')),
      connected, getMetrics: () => ({ slot: 1 }),
    });
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledOnce());
    fireEvent.click(toggle);
    await act(async () => { await Promise.resolve(); });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/会場音声: 停止/)).toBeInTheDocument();
    expect(listClientDiagnostics().some((item) => item.source === 'venue.mic-send.start')).toBe(false);
  });

  it('ends the venue run when its participant lease is lost', async () => {
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledOnce());
    const options = venueAudio.start.mock.calls[0]?.[1] as { onLeaseLost: () => void };
    act(() => options.onLeaseLost());
    act(() => options.onLeaseLost());
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/会場接続が終了しました。再度開始してください/)).toBeInTheDocument();
    await waitFor(() => expect(runLog.end).toHaveBeenCalledOnce());
    const records = runLog.append.mock.calls.map(([, item]) => item as { type: string; event?: string; code?: string; detail?: string; message?: string });
    expect(records.find((item) => item.type === 'error')).toMatchObject({ code: 'lease-lost', message: '会場接続の参加登録が失効しました' });
    expect(records.filter((item) => item.type === 'error')).toHaveLength(1);
    expect(records.find((item) => item.type === 'transport' && item.event === 'stop')).toMatchObject({ detail: 'lease-lost' });
    expect(listClientDiagnostics().filter((item) => item.source === 'venue.mic-send.lease-lost')).toHaveLength(1);
    expect(listClientDiagnostics().some((item) => item.source === 'venue.mic-send.lease-lost' && item.message === '会場接続の参加登録が失効しました')).toBe(true);
  });

  it('does not start IVS when capture has no audio track', async () => {
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([]));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByText('マイク入力がありません')).toBeInTheDocument();
    expect(api.requestStageTokens).not.toHaveBeenCalled();
  });

  it('shows the 6th mic rejection (F-MIC-05)', async () => {
    api.requestStageTokens.mockRejectedValue(new ApiError(409, 'DEVICE_LIMIT', '上限'));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('マイクは最大5台まで接続できます');
  });

  it('asks for another name when another device uses it', async () => {
    api.requestStageTokens.mockRejectedValue(new ApiError(409, 'DEVICE_NAME_IN_USE', '使用中'));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('MIC1 は他の端末が使用中です');
  });
});

describe('SlideSharePage (S-03)', () => {
  it('shares 720p with system audio, sets contentHint=text and publishes to the slide stage', async () => {
    render(<SlideSharePage />);
    expect(screen.getByRole('tab', { name: 'PowerPoint' })).toBeInTheDocument();
    expect(screen.getByText('「システム音声を共有」をオンにして共有')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '共有開始' }));
    await waitFor(() => expect(screen.getAllByRole('status')[0]).toHaveTextContent('送信中'));
    expect(getDisplayMedia.mock.calls[0]?.[0]).toMatchObject({ audio: expect.any(Object), systemAudio: 'include', video: { width: { max: 1280 }, height: { max: 720 } } });
    const stream = (await getDisplayMedia.mock.results[0]?.value) as FakeMediaStream;
    expect(stream.getVideoTracks()[0]?.contentHint).toBe('text');
    expect(api.requestStageTokens).toHaveBeenCalledWith('slide', undefined, false);
    expect(sessions[0]?.token).toBe('tok-slide');
    expect(sessions[0]?.options.tracks.map((track) => track.config)).toEqual([{ maxVideoBitrateKbps: 2500, maxFramerate: 30 }, { maxAudioBitrateKbps: 128, stereo: true }]);
  });

  it('asks to re-share when the shared track ends (F-SHR-08)', async () => {
    render(<SlideSharePage />);
    fireEvent.click(screen.getByRole('button', { name: '共有開始' }));
    await waitFor(() => expect(sessions).toHaveLength(1));
    const stream = (await getDisplayMedia.mock.results[0]?.value) as FakeMediaStream;
    act(() => stream.getVideoTracks()[0]?.end());
    expect(screen.getByText(/画面共有が停止しました/)).toBeInTheDocument();
    expect(sessions[0]?.setPublishTracks).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByRole('button', { name: 'もう一度共有する' }));
    await waitFor(() => expect(sessions[0]?.setPublishTracks).toHaveBeenCalledTimes(2));
    expect(sessions[0]?.setPublishTracks.mock.lastCall?.[0]).toHaveLength(2);
    expect(stream.tracks[1]?.stop).toHaveBeenCalled();
    expect(screen.queryByText(/画面共有が停止しました/)).not.toBeInTheDocument();
  });

  it('does nothing when the user cancels the share picker', async () => {
    getDisplayMedia.mockRejectedValue(Object.assign(new Error('cancel'), { name: 'NotAllowedError' }));
    render(<SlideSharePage />);
    fireEvent.click(screen.getByRole('button', { name: '共有開始' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('スライド共有の使用が許可されていません');
    expect(api.requestStageTokens).not.toHaveBeenCalled();
  });

  it('stops sharing and the captured tracks', async () => {
    render(<SlideSharePage />);
    fireEvent.click(screen.getByRole('button', { name: '共有開始' }));
    fireEvent.click(await screen.findByRole('button', { name: '共有停止' }));
    const stream = (await getDisplayMedia.mock.results[0]?.value) as FakeMediaStream;
    expect(stream.tracks.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
    expect(api.releaseDevice).toHaveBeenCalledWith('dev-1');
  });
});
