import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { FakeMediaStream, FakeTrack, installMediaGlobals, stageMock, tokenResponse, type FakeSession } from '@/lib/ivs/testing';

const sessions = vi.hoisted(() => [] as FakeSession[]);
const api = vi.hoisted(() => ({ requestStageTokens: vi.fn(), sendHeartbeat: vi.fn(), releaseDevice: vi.fn() }));
vi.mock('@/lib/ivs/stage', () => stageMock(sessions));
vi.mock('@/lib/ivs/mediaApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/ivs/mediaApi')>()), ...api }));

const { default: CameraSendPage } = await import('./CameraSendPage');
const { default: MicSendPage } = await import('./MicSendPage');
const { default: SlideSharePage } = await import('./SlideSharePage');

const getUserMedia = vi.fn();
const getDisplayMedia = vi.fn();

beforeEach(() => {
  sessions.length = 0;
  installMediaGlobals();
  api.requestStageTokens.mockReset().mockImplementation((purpose: string) => Promise.resolve(tokenResponse([purpose === 'slide' ? 'slide' : 'production'], 'dev-1')));
  api.sendHeartbeat.mockReset().mockResolvedValue({ expiresAt: '2026-10-19T00:00:00.000Z' });
  api.releaseDevice.mockReset().mockResolvedValue(undefined);
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
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('送信中'));
    expect(api.requestStageTokens).toHaveBeenCalledWith('camera', 'CAM1');
    expect(sessions[0]?.options.tracks).toHaveLength(1);
    expect(sessions[0]?.options.tracks[0]?.track.kind).toBe('video');
    expect(sessions[0]?.options.tracks[0]?.config).toEqual({ maxVideoBitrateKbps: 2000, maxFramerate: 30 });
  });

  it('switches to the front camera and replaces the published track while live', async () => {
    render(<CameraSendPage />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    const first = (await getUserMedia.mock.results[0]?.value) as FakeMediaStream;
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('送信中'));
    fireEvent.click(screen.getByRole('radio', { name: '前面' }));
    await waitFor(() => expect(sessions[0]?.setPublishTracks).toHaveBeenCalled());
    expect(first.tracks[0]?.stop).toHaveBeenCalled();
    expect(getUserMedia.mock.calls[1]?.[0]).toMatchObject({ video: { facingMode: { ideal: 'user' } } });
  });

  it('shows the 7th camera rejection message (F-CAM-06)', async () => {
    api.requestStageTokens.mockRejectedValue(new ApiError(409, 'DEVICE_LIMIT', '上限'));
    render(<CameraSendPage />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('カメラは最大6台まで接続できます');
    expect(screen.getByRole('status')).toHaveTextContent('エラー');
  });

  it('explains a denied camera permission', async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    render(<CameraSendPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('カメラの使用が許可されていません');
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
  it('sends audio as MIC1 and mutes on the sender side', async () => {
    render(<MicSendPage />);
    expect(screen.getByLabelText('入力レベル')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '送信開始' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('送信中'));
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({ video: false, audio: { sampleRate: 48000 } });
    expect(api.requestStageTokens).toHaveBeenCalledWith('mic', 'MIC1');
    expect(sessions[0]?.options.tracks[0]?.config).toEqual({ maxAudioBitrateKbps: 64 });
    fireEvent.click(screen.getByRole('switch', { name: 'ミュート' }));
    expect(sessions[0]?.setMuted).toHaveBeenLastCalledWith('audio', true);
    expect(screen.getByText('ミュート中')).toBeInTheDocument();
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
    expect(api.requestStageTokens).toHaveBeenCalledWith('slide', undefined);
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
