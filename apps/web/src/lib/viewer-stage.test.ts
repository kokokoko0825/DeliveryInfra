import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearClientDiagnostics, listClientDiagnostics } from './diagnostics';

const sdk = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class FakeStage {
    static instances: FakeStage[] = [];
    static failJoin = false;
    listeners = new Map<string, Listener[]>();
    join = vi.fn(async () => { if (FakeStage.failJoin) throw new Error('join failed'); });
    leave = vi.fn(() => this.emit('stageConnectionStateChanged', 'disconnected'));
    constructor(public token: string, public strategy: unknown) { FakeStage.instances.push(this); }
    on(name: string, listener: Listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
    emit(name: string, ...args: unknown[]) { this.listeners.get(name)?.forEach((listener) => listener(...args)); }
  }
  return { FakeStage };
});
vi.mock('amazon-ivs-web-broadcast', () => ({
  Stage: sdk.FakeStage,
  StageEvents: {
    STAGE_CONNECTION_STATE_CHANGED: 'stageConnectionStateChanged',
    STAGE_PARTICIPANT_STREAMS_ADDED: 'stageParticipantStreamsAdded',
    STAGE_PARTICIPANT_STREAMS_REMOVED: 'stageParticipantStreamsRemoved',
  },
  StageConnectionState: { CONNECTED: 'connected', CONNECTING: 'connecting', DISCONNECTED: 'disconnected', ERRORED: 'errored' },
  SubscribeType: { AUDIO_VIDEO: 'audio_video', NONE: 'none' },
}));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, apiFetch: vi.fn(actual.apiFetch) };
});

const api = await import('./api');
const actualApi = await vi.importActual<typeof import('./api')>('./api');
const { fetchViewerToken, useViewerStage, viewerStrategy } = await import('./viewer-stage');
const apiFetch = vi.mocked(api.apiFetch);

class FakeMediaStream {
  constructor(public tracks: { id: string }[] = []) {}
  getTracks() { return this.tracks; }
}
const tokenBody = (stage = 'broadcast') => ({ tokens: [{ stage, token: `tok-${stage}`, participantId: 'p', capabilities: ['SUBSCRIBE'], expiresAt: '2026-10-19T00:10:00.000Z' }] });
const stage = () => sdk.FakeStage.instances.at(-1)!;
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearClientDiagnostics();
  vi.useFakeTimers();
  sdk.FakeStage.instances = [];
  sdk.FakeStage.failJoin = false;
  vi.stubGlobal('MediaStream', FakeMediaStream);
  fetchMock = vi.fn(async () => new Response(JSON.stringify(tokenBody())));
  vi.stubGlobal('fetch', fetchMock);
  apiFetch.mockReset();
  apiFetch.mockImplementation(actualApi.apiFetch);
});
/** フック内のトークン取得は即時に解決させる（fake timer と WebCrypto の非同期を切り離すため）。 */
const useInstantTokens = () => apiFetch.mockImplementation(async () => tokenBody());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('viewer strategy', () => {
  it('subscribes to audio+video and never publishes', () => {
    expect(viewerStrategy.stageStreamsToPublish()).toEqual([]);
    expect(viewerStrategy.shouldPublishParticipant({} as never)).toBe(false);
    expect(viewerStrategy.shouldSubscribeToParticipant({} as never)).toBe('audio_video');
  });
});

describe('fetchViewerToken', () => {
  it('requests a viewer token and picks the broadcast stage', async () => {
    await expect(fetchViewerToken()).resolves.toBe('tok-broadcast');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tokens/stage');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"purpose":"viewer"}');
  });
  it('fails without a broadcast token', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(tokenBody('production'))));
    await expect(fetchViewerToken()).rejects.toThrow('配信用ステージのトークンがありません');
  });
});

describe('useViewerStage', () => {
  it('stays idle while inactive', () => {
    const { result } = renderHook(() => useViewerStage(false));
    expect(result.current).toEqual({ stream: null, state: 'idle', error: null });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('joins, exposes remote tracks, and removes them', async () => {
    useInstantTokens();
    const { result } = renderHook(() => useViewerStage(true));
    expect(result.current.state).toBe('connecting');
    await flush();
    expect(stage().token).toBe('tok-broadcast');
    expect(stage().join).toHaveBeenCalled();
    act(() => stage().emit('stageConnectionStateChanged', 'connected'));
    expect(result.current.state).toBe('connected');
    const video = { mediaStreamTrack: { id: 'v' } };
    const audio = { mediaStreamTrack: { id: 'a' } };
    act(() => stage().emit('stageParticipantStreamsAdded', {}, [video, audio]));
    expect((result.current.stream as unknown as FakeMediaStream).getTracks().map((t) => t.id)).toEqual(['v', 'a']);
    act(() => stage().emit('stageParticipantStreamsRemoved', {}, [video]));
    expect((result.current.stream as unknown as FakeMediaStream).getTracks().map((t) => t.id)).toEqual(['a']);
    act(() => stage().emit('stageParticipantStreamsRemoved', {}, [audio]));
    expect(result.current.stream).toBeNull();
    act(() => stage().emit('stageConnectionStateChanged', 'connecting'));
    expect(result.current.state).toBe('connected');
  });

  it('reconnects with a fresh token after an error, with backoff', async () => {
    useInstantTokens();
    const { result } = renderHook(() => useViewerStage(true));
    await flush();
    const first = stage();
    act(() => first.emit('stageParticipantStreamsAdded', {}, [{ mediaStreamTrack: { id: 'v' } }]));
    act(() => first.emit('stageConnectionStateChanged', 'errored'));
    expect(result.current.state).toBe('reconnecting');
    expect(result.current.stream).toBeNull();
    expect(first.leave).toHaveBeenCalledTimes(1);
    expect(sdk.FakeStage.instances).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(999); });
    expect(sdk.FakeStage.instances).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    await flush();
    expect(sdk.FakeStage.instances).toHaveLength(2);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    act(() => first.emit('stageConnectionStateChanged', 'connected'));
    expect(result.current.state).toBe('reconnecting');
    act(() => stage().emit('stageConnectionStateChanged', 'disconnected'));
    await act(async () => { vi.advanceTimersByTime(1999); });
    expect(sdk.FakeStage.instances).toHaveLength(2);
    await act(async () => { vi.advanceTimersByTime(1); });
    await flush();
    expect(sdk.FakeStage.instances).toHaveLength(3);
    act(() => stage().emit('stageConnectionStateChanged', 'connected'));
    expect(result.current.state).toBe('connected');
    act(() => stage().emit('stageConnectionStateChanged', 'errored'));
    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(sdk.FakeStage.instances).toHaveLength(4);
  });

  it('retries when the token request or join fails and reports the error', async () => {
    useInstantTokens();
    apiFetch.mockRejectedValueOnce(new actualApi.ApiError(500, 'X', 'トークン失敗'));
    const { result } = renderHook(() => useViewerStage(true));
    await flush();
    expect(result.current.state).toBe('reconnecting');
    expect(result.current.error).toBe('トークン失敗');
    sdk.FakeStage.instances = [];
    sdk.FakeStage.failJoin = true;
    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(result.current.error).toBe('join failed');
    expect(listClientDiagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'viewer.stage.join', message: 'join failed' })]));
    sdk.FakeStage.failJoin = false;
    await act(async () => { vi.advanceTimersByTime(2000); });
    await flush();
    act(() => stage().emit('stageConnectionStateChanged', 'connected'));
    expect(result.current).toMatchObject({ state: 'connected', error: null });
  });

  it('leaves and stops reconnecting on unmount or when inactive', async () => {
    useInstantTokens();
    const { rerender, result } = renderHook(({ active }) => useViewerStage(active), { initialProps: { active: true } });
    await flush();
    const joined = stage();
    rerender({ active: false });
    expect(joined.leave).toHaveBeenCalled();
    expect(result.current).toMatchObject({ state: 'idle', stream: null });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(sdk.FakeStage.instances).toHaveLength(1);
  });

  it('ignores a token that arrives after unmount', async () => {
    useInstantTokens();
    const { unmount } = renderHook(() => useViewerStage(true));
    unmount();
    await flush();
    expect(sdk.FakeStage.instances).toHaveLength(0);
  });
});
