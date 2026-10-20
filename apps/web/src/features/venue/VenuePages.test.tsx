import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VenueMicPage from './VenueMicPage';
import VenueSpeakerPage from './VenueSpeakerPage';
import type { VenueSession, VenueSessionMetrics } from './venueAudio';

const mocks = vi.hoisted(() => ({
  startMic: vi.fn(), startSpeaker: vi.fn(), createRun: vi.fn(), appendRecord: vi.fn(), endRun: vi.fn(),
  listRuns: vi.fn(), exportRun: vi.fn(), saveBlob: vi.fn(), close: vi.fn(), createRecorder: vi.fn(),
}));

vi.mock('./venueAudio', () => ({ startVenueMic: mocks.startMic, startVenueSpeaker: mocks.startSpeaker }));
vi.mock('./venueRunLog', () => ({
  createVenueRun: mocks.createRun, appendVenueRunRecord: mocks.appendRecord,
  endVenueRun: mocks.endRun, listVenueRuns: mocks.listRuns, exportVenueRun: mocks.exportRun,
}));
vi.mock('@/lib/download', () => ({ saveBlob: mocks.saveBlob }));
vi.mock('@/lib/ivs/wakeLock', () => ({ holdWakeLock: () => undefined }));
vi.mock('./venueAcousticRecorder', () => ({ createVenueAcousticRecorder: mocks.createRecorder }));

const snapshot: VenueSessionMetrics = {
  role: 'mic', slot: 2, transport: 'pcm', activePeers: 1, connectedPeers: 1,
  sentPackets: 12, sentBytes: 11520, backpressureDrops: 1, receivedPackets: 4, receivedBytes: 3840,
  sequenceGaps: 2, duplicates: 3, invalidPackets: 4, rttMs: 21.5,
  peers: [{ peerId: 'peer-1', side: 'speaker', slot: 1, micSlot: 2, speakerSlot: 1, active: true, state: 'connected', connected: true, sentPackets: 5, sentBytes: 4800, backpressureDrops: 1, receivedPackets: 2, receivedBytes: 1920, sequenceGaps: 1, duplicates: 2, invalidPackets: 3, rttMs: 22 }],
  workletStreams: [{ micId: 'MIC2', queuedMs: 10, underflows: 5, overflows: 6, dropped: 7, peak: 0.8 }],
};

function fakeSession(role: 'mic' | 'speaker', slot: number, transport: 'pcm' | 'audio-track' = 'pcm'): VenueSession {
  const metrics = { ...snapshot, role, slot, transport };
  return { close: mocks.close, connected: Promise.resolve(), getRtt: () => 21.5, getMetrics: () => metrics };
}

function setupMedia() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  return { stream, track, getUserMedia: navigator.mediaDevices.getUserMedia };
}

describe('venue PoC pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createRun.mockResolvedValue(undefined);
    mocks.appendRecord.mockResolvedValue(true);
    mocks.endRun.mockResolvedValue(undefined);
    mocks.listRuns.mockResolvedValue([]);
    mocks.exportRun.mockResolvedValue({ csv: '\uFEFFcsv', manifestJson: '{"summary":{}}' });
    mocks.createRecorder.mockReturnValue({ start: vi.fn(), stop: vi.fn().mockResolvedValue({ blob: new Blob(['evidence']), mimeType: 'audio/webm;codecs=opus', extension: 'webm', byteCount: 8 }), cleanup: vi.fn() });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('selects a mic slot, keeps capture processing disabled, and saves a mapped one-second health sample', async () => {
    const { stream, getUserMedia } = setupMedia();
    mocks.startMic.mockResolvedValue(fakeSession('mic', 2, 'audio-track'));
    vi.useFakeTimers();
    render(<VenueMicPage />);
    fireEvent.change(screen.getByRole('combobox', { name: 'マイクスロット' }), { target: { value: '2' } });
    fireEvent.change(screen.getByRole('combobox', { name: '音声方式' }), { target: { value: 'audio-track' } });
    fireEvent.click(screen.getByRole('button', { name: '接続開始' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(getUserMedia).toHaveBeenCalledWith({ video: false, audio: { sampleRate: 48000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    expect(mocks.startMic).toHaveBeenCalledWith(stream, { transport: 'audio-track', slot: 2 });
    expect(mocks.createRun).toHaveBeenCalledWith(expect.objectContaining({ peers: ['config.transport=audio-track'] }));
    expect(screen.getByText('自分のスロット: MIC2')).toBeInTheDocument();
    expect(screen.getByText(/SPK1: 接続済み/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const health = mocks.appendRecord.mock.calls.map((call) => call[1]).find((item) => item.type === 'health');
    expect(health).toMatchObject({ atUtc: expect.stringMatching(/Z$/), elapsedMs: expect.any(Number), values: {
      activePeers: 1, connectedPeers: 1, sentPackets: 12, diagnosticRttMs: 21.5, transportPcm: 0, transportAudioTrack: 1,
      'peer.peer-1.connected': 1, 'peer.peer-1.sequenceGaps': 1,
      'worklet.MIC2.queuedMs': 10, 'worklet.MIC2.underflows': 5,
    } });
  });

  it('exports current and historical run data without deleting it, and reports export failures', async () => {
    const { stream } = setupMedia();
    mocks.startMic.mockResolvedValue(fakeSession('mic', 1));
    mocks.listRuns.mockResolvedValue([{ schemaVersion: 1, id: 'previous', startedAtUtc: '2026-10-20T00:00:00Z', userAgent: '', peers: [] }]);
    render(<VenueMicPage />);
    await waitFor(() => expect(screen.getByText(/previous/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '接続開始' }));
    await waitFor(() => expect(mocks.startMic).toHaveBeenCalledWith(stream, { transport: 'pcm' }));
    expect(await screen.findByText(/現在のラン:/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'CSV' })[0]!);
    await waitFor(() => expect(mocks.saveBlob).toHaveBeenCalled());
    expect(mocks.endRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'JSON manifest' })[1]!);
    await waitFor(() => expect(mocks.saveBlob).toHaveBeenCalledTimes(2));
    mocks.exportRun.mockRejectedValueOnce(new Error('corrupt run'));
    fireEvent.click(screen.getAllByRole('button', { name: 'JSON manifest' })[1]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('corrupt run');
  });

  it('selects a speaker slot, displays diagnostic RTT and reports IndexedDB start errors', async () => {
    mocks.startSpeaker.mockResolvedValue(fakeSession('speaker', 3));
    const { rerender } = render(<VenueSpeakerPage />);
    fireEvent.change(screen.getByRole('combobox', { name: 'スピーカースロット' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '受信開始' }));
    await waitFor(() => expect(mocks.startSpeaker).toHaveBeenCalledWith(expect.any(Function), { transport: 'pcm', slot: 3 }));
    expect(await screen.findByText('自分のスロット: SPK3')).toBeInTheDocument();
    expect(screen.getByText(/診断 RTT: 21.5 ms/)).toBeInTheDocument();
    expect(screen.getAllByText(/片道音声遅延ではありません/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    await waitFor(() => expect(mocks.endRun).toHaveBeenCalled());
    mocks.createRun.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    rerender(<VenueSpeakerPage />);
    fireEvent.click(screen.getByRole('button', { name: '受信開始' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('IndexedDB unavailable');
  });

  it('uses Auto by default and explains iOS microphone permission failures', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    render(<VenueMicPage />);
    expect(screen.getByRole('combobox', { name: 'マイクスロット' })).toHaveValue('auto');
    fireEvent.click(screen.getByRole('button', { name: '接続開始' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('設定アプリでブラウザのマイク権限を許可');
    expect(mocks.startMic).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.endRun).toHaveBeenCalled());
  });

  it('records explicit local acoustic evidence and names the download with the run ID', async () => {
    setupMedia();
    mocks.startMic.mockResolvedValue(fakeSession('mic', 1));
    render(<VenueMicPage />);
    fireEvent.click(screen.getByRole('button', { name: '接続開始' }));
    expect(await screen.findByRole('region', { name: '音響証拠録音' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '音響証拠を録音' }));
    expect(mocks.createRecorder).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '録音停止して保存' }));
    await waitFor(() => expect(mocks.saveBlob).toHaveBeenCalled());
    const createdRun = mocks.createRun.mock.calls[0]?.[0];
    expect(mocks.saveBlob.mock.calls[0]?.[1]).toBe(`venue-run-${createdRun.id}-acoustic.webm`);
    expect(screen.getByText(/校正された遅延測定ではありません/)).toBeInTheDocument();
  });
});
