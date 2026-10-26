import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { clearClientDiagnostics, listClientDiagnostics } from '@/lib/diagnostics';
import { FakeMediaStream, FakeTrack, installMediaGlobals, stageMock, tokenResponse, type FakeSession } from '@/lib/ivs/testing';

const sessions = vi.hoisted(() => [] as FakeSession[]);
const api = vi.hoisted(() => ({ requestStageTokens: vi.fn(), sendHeartbeat: vi.fn(), releaseDevice: vi.fn(), fetchDeviceNamesInUse: vi.fn() }));
const venueAudio = vi.hoisted(() => ({ prepare: vi.fn(), start: vi.fn() }));
vi.mock('@/lib/ivs/stage', () => stageMock(sessions));
vi.mock('@/lib/ivs/mediaApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/ivs/mediaApi')>()), ...api }));
vi.mock('@/features/venue/venueAudio', () => ({ prepareVenueMicAudio: venueAudio.prepare, startVenueMic: venueAudio.start }));

const { default: CameraSendPage } = await import('./CameraSendPage');
const { default: MicSendPage } = await import('./MicSendPage');
const { default: SlideSharePage } = await import('./SlideSharePage');

const getUserMedia = vi.fn();
const getDisplayMedia = vi.fn();

beforeEach(() => {
  clearClientDiagnostics();
  sessions.length = 0;
  installMediaGlobals();
  api.requestStageTokens.mockReset().mockImplementation((purpose: string) => Promise.resolve(tokenResponse([purpose === 'slide' ? 'slide' : 'production'], 'dev-1')));
  api.sendHeartbeat.mockReset().mockResolvedValue({ expiresAt: '2026-10-19T00:00:00.000Z' });
  api.releaseDevice.mockReset().mockResolvedValue(undefined);
  api.fetchDeviceNamesInUse.mockReset().mockResolvedValue({ inUse: [] });
  venueAudio.prepare.mockReset().mockReturnValue({ context: { close: vi.fn().mockResolvedValue(undefined) }, ready: Promise.resolve() });
  venueAudio.start.mockReset().mockResolvedValue({ close: vi.fn(), connected: Promise.resolve() });
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
  it('uses a low-latency clone of the same mic input for venue while IVS keeps the original track', async () => {
    const closeVenue = vi.fn();
    venueAudio.start.mockResolvedValueOnce({ close: closeVenue, connected: Promise.resolve() });
    render(<MicSendPage />);
    const venueToggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(venueToggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledTimes(1));
    const stream = (await getUserMedia.mock.results[0]?.value) as FakeMediaStream;
    const venueStream = venueAudio.start.mock.calls[0]?.[0] as FakeMediaStream;
    const sourceTrack = stream.getAudioTracks()[0] as FakeTrack;
    const venueTrack = venueStream.getAudioTracks()[0] as FakeTrack;
    expect(venueAudio.start).toHaveBeenCalledWith(venueStream, {}, expect.objectContaining({ context: expect.any(Object) }));
    expect(venueTrack).not.toBe(sourceTrack);
    expect(venueTrack.sourceId).toBe(sourceTrack.sourceId);
    expect(venueTrack.applyConstraints).toHaveBeenCalledWith({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });

    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('送信中'));
    expect(sessions[0]?.options.tracks[0]?.track).toBe(stream.getAudioTracks()[0]);
    expect(screen.getByText(/会場音声: 接続中（DataChannel PCM）/)).toBeInTheDocument();
    fireEvent.click(venueToggle);
    expect(closeVenue).toHaveBeenCalledOnce();
    expect(venueTrack.stop).toHaveBeenCalledOnce();
  });

  it('shares an in-flight microphone capture between venue and IVS start', async () => {
    let resolveCapture: (stream: FakeMediaStream) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise<FakeMediaStream>((resolve) => { resolveCapture = resolve; }));
    const source = new FakeTrack('audio');
    const captured = new FakeMediaStream([source]);
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('switch', { name: '会場スピーカーにも送信' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(getUserMedia).toHaveBeenCalledOnce();
    await act(async () => resolveCapture(captured));
    await screen.findByRole('button', { name: '送信停止' });
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledOnce());
    const venueStream = venueAudio.start.mock.calls[0]?.[0] as FakeMediaStream;
    expect(venueStream.getAudioTracks()[0]).not.toBe(source);
    expect((venueStream.getAudioTracks()[0] as FakeTrack).sourceId).toBe(source.sourceId);
    expect(sessions[0]?.options.tracks[0]?.track).toBe(source);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it('allows a new microphone capture attempt after permission denial', async () => {
    const source = new FakeTrack('audio');
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([source]));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('マイクの使用が許可されていません');
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('button', { name: '送信停止' });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(sessions[0]?.options.tracks[0]?.track).toBe(source);
  });

  it('resets the venue switch and reports errors when the direct route cannot start', async () => {
    const source = new FakeTrack('audio');
    const clone = source.clone();
    source.clone.mockReturnValueOnce(clone);
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([source]));
    venueAudio.start.mockRejectedValueOnce(new Error('STUN connection failed'));
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    expect(await screen.findByText(/会場音声: STUN connection failed/)).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    expect(clone.stop).toHaveBeenCalledOnce();
    expect(listClientDiagnostics()).toMatchObject([{ source: 'venue.mic-send.start', message: 'STUN connection failed' }]);
  });

  it('does not let a late venue startup failure reset a newer connection', async () => {
    const source = new FakeTrack('audio');
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([source]));
    let rejectOldStart: (error: Error) => void = () => undefined;
    const closeNew = vi.fn();
    venueAudio.start
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectOldStart = reject; }))
      .mockResolvedValueOnce({ close: closeNew, connected: Promise.resolve() });
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledTimes(1));
    const oldClone = source.clone.mock.results[0]?.value as FakeTrack;
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledTimes(2));
    const newClone = source.clone.mock.results[1]?.value as FakeTrack;
    await act(async () => rejectOldStart(new Error('late failure')));
    expect(toggle).toBeChecked();
    expect(screen.getByText(/会場音声: 接続中（DataChannel PCM）/)).toBeInTheDocument();
    expect(oldClone.stop).toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(closeNew).toHaveBeenCalledOnce();
    expect(newClone.stop).toHaveBeenCalledOnce();
  });

  it('shows a fallback when venue startup rejects with a non-Error value', async () => {
    venueAudio.start.mockRejectedValueOnce('unexpected failure');
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('switch', { name: '会場スピーカーにも送信' }));
    expect(await screen.findByText(/会場音声: 接続に失敗しました/)).toBeInTheDocument();
  });

  it('closes the prepared audio context when microphone permission is denied', async () => {
    const context = { close: vi.fn().mockResolvedValue(undefined) };
    venueAudio.prepare.mockReturnValueOnce({ context, ready: Promise.resolve() });
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('switch', { name: '会場スピーカーにも送信' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '会場スピーカーにも送信' })).not.toBeChecked());
    expect(screen.getByText(/会場音声: 停止/)).toBeInTheDocument();
    expect(context.close).toHaveBeenCalledOnce();
    expect(venueAudio.start).not.toHaveBeenCalled();
  });

  it('does not start venue audio when the switch is turned off while mic capture is pending', async () => {
    let resolveCapture: (stream: FakeMediaStream) => void = () => undefined;
    getUserMedia.mockImplementationOnce(() => new Promise<FakeMediaStream>((resolve) => { resolveCapture = resolve; }));
    const context = { close: vi.fn().mockResolvedValue(undefined) };
    venueAudio.prepare.mockReturnValueOnce({ context, ready: Promise.resolve() });
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    fireEvent.click(toggle);
    await act(async () => resolveCapture(new FakeMediaStream([new FakeTrack('audio')])));
    expect(context.close).toHaveBeenCalledOnce();
    expect(venueAudio.start).not.toHaveBeenCalled();
    expect(toggle).not.toBeChecked();
  });

  it('reports missing audio input without starting venue transport', async () => {
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([]));
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    expect(await screen.findByText(/会場音声: マイク入力がありません/)).toBeInTheDocument();
    expect(toggle).not.toBeChecked();
    expect(venueAudio.start).not.toHaveBeenCalled();
  });

  it('does not start venue transport when the browser rejects low-latency clone settings', async () => {
    const source = new FakeTrack('audio');
    const clone = source.clone();
    clone.applyConstraints.mockRejectedValueOnce(new Error('unsupported constraints'));
    source.clone.mockReturnValueOnce(clone);
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([source]));
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    expect(await screen.findByText(/会場音声: unsupported constraints/)).toBeInTheDocument();
    expect(clone.stop).toHaveBeenCalledOnce();
    expect(toggle).not.toBeChecked();
    expect(venueAudio.start).not.toHaveBeenCalled();
  });

  it('stops a low-latency clone that finishes setup after the switch is turned off', async () => {
    const source = new FakeTrack('audio');
    const clone = source.clone();
    let finishConstraints: () => void = () => undefined;
    clone.applyConstraints.mockImplementationOnce(async (constraints) => {
      await new Promise<void>((resolve) => { finishConstraints = resolve; });
      clone.appliedConstraints = constraints;
    });
    source.clone.mockReturnValueOnce(clone);
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([source]));
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    await waitFor(() => expect(clone.applyConstraints).toHaveBeenCalledOnce());
    fireEvent.click(toggle);
    await act(async () => finishConstraints());
    expect(clone.stop).toHaveBeenCalledOnce();
    expect(venueAudio.start).not.toHaveBeenCalled();
  });

  it('does not let an older connection cleanup stop tracking a newer venue clone', async () => {
    const source = new FakeTrack('audio');
    getUserMedia.mockResolvedValueOnce(new FakeMediaStream([source]));
    let finishOldStart: (session: { close: ReturnType<typeof vi.fn>; connected: Promise<void> }) => void = () => undefined;
    const closeOld = vi.fn();
    const closeNew = vi.fn();
    venueAudio.start
      .mockImplementationOnce(() => new Promise((resolve) => { finishOldStart = resolve; }))
      .mockResolvedValueOnce({ close: closeNew, connected: Promise.resolve() });
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledTimes(1));
    const oldClone = source.clone.mock.results[0]?.value as FakeTrack;
    fireEvent.click(toggle);
    expect(oldClone.stop).toHaveBeenCalledOnce();
    fireEvent.click(toggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledTimes(2));
    const newClone = source.clone.mock.results[1]?.value as FakeTrack;
    await act(async () => finishOldStart({ close: closeOld, connected: Promise.resolve() }));
    expect(closeOld).toHaveBeenCalledOnce();
    fireEvent.click(toggle);
    expect(closeNew).toHaveBeenCalledOnce();
    expect(newClone.stop).toHaveBeenCalledOnce();
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

  it('keeps the stopped status when a venue connection completes after the switch is turned off', async () => {
    let resolveConnected: () => void = () => undefined;
    const close = vi.fn();
    venueAudio.start.mockResolvedValueOnce({ close, connected: new Promise<void>((resolve) => { resolveConnected = resolve; }) });
    render(<MicSendPage />);
    const toggle = screen.getByRole('switch', { name: '会場スピーカーにも送信' });
    fireEvent.click(toggle);
    await waitFor(() => expect(venueAudio.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(close).not.toHaveBeenCalled());
    fireEvent.click(toggle);
    expect(close).toHaveBeenCalledOnce();
    await act(async () => resolveConnected());
    expect(screen.getByText(/会場音声: 停止/)).toBeInTheDocument();
  });

  it('sends audio as MIC1 and mutes on the sender side', async () => {
    render(<MicSendPage />);
    expect(screen.getByLabelText('入力レベル')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('送信中'));
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({ video: false, audio: { sampleRate: 48000, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(api.requestStageTokens).toHaveBeenCalledWith('mic', 'MIC1', false);
    expect(sessions[0]?.options.tracks[0]?.config).toEqual({ maxAudioBitrateKbps: 64 });
    fireEvent.click(screen.getByRole('switch', { name: 'ミュート' }));
    expect(sessions[0]?.setMuted).toHaveBeenLastCalledWith('audio', true);
    expect(screen.getByText('ミュート中')).toBeInTheDocument();
  });

  it('does not start IVS when microphone capture fails', async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await screen.findByRole('alert');
    expect(api.requestStageTokens).not.toHaveBeenCalled();
  });

  it('starts muted when muted before sending', async () => {
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('switch', { name: 'ミュート' }));
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await waitFor(() => expect(sessions[0]?.setMuted).toHaveBeenCalledWith('audio', true));
  });

  it('shows the 6th mic rejection (F-MIC-05)', async () => {
    api.requestStageTokens.mockRejectedValue(new ApiError(409, 'DEVICE_LIMIT', '上限'));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('マイクは最大5台まで接続できます');
  });

  it('asks to pick another name when someone else uses it, not a network error (R3-01)', async () => {
    api.requestStageTokens.mockRejectedValue(new ApiError(409, 'DEVICE_NAME_IN_USE', '使用中'));
    render(<MicSendPage />);
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('MIC1 は他の端末が使用中です。別の端末名を選んでください。');
    expect(alert).not.toHaveTextContent('回線');
    expect(screen.queryByRole('button', { name: 'この端末に切り替える' })).not.toBeInTheDocument();
  });

  it('keeps the first name when the in-use list cannot be fetched (R3-01)', async () => {
    api.fetchDeviceNamesInUse.mockRejectedValue(new Error('offline'));
    render(<MicSendPage />);
    await waitFor(() => expect(api.fetchDeviceNamesInUse).toHaveBeenCalledWith('mic'));
    expect(screen.getByRole('combobox', { name: '端末名' })).toHaveTextContent('MIC1');
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
