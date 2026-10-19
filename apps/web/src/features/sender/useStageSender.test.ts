import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { FakeTrack, stageMock, tokenResponse, type FakeSession } from '@/lib/ivs/testing';

const sessions = vi.hoisted(() => [] as FakeSession[]);
const api = vi.hoisted(() => ({ requestStageTokens: vi.fn(), sendHeartbeat: vi.fn(), releaseDevice: vi.fn() }));
vi.mock('@/lib/ivs/stage', () => stageMock(sessions));
vi.mock('@/lib/ivs/mediaApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/ivs/mediaApi')>()), ...api }));

const { HEARTBEAT_INTERVAL_MS, useStageSender } = await import('./useStageSender');
const tracks = [{ track: new FakeTrack('video') as unknown as MediaStreamTrack }];
const wakeLock = { request: vi.fn() };

beforeEach(() => {
  sessions.length = 0;
  api.requestStageTokens.mockReset().mockResolvedValueOnce(tokenResponse(['production'], 'dev-1')).mockResolvedValue(tokenResponse(['production'], 'dev-2'));
  api.sendHeartbeat.mockReset().mockResolvedValue({ expiresAt: '2026-10-19T00:00:00.000Z' });
  api.releaseDevice.mockReset().mockResolvedValue(undefined);
  wakeLock.request.mockReset().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) });
  Object.defineProperty(navigator, 'wakeLock', { value: wakeLock, configurable: true });
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('useStageSender', () => {
  it('publishes to the production stage with the device name and holds a wake lock', async () => {
    const { result } = renderHook(() => useStageSender('camera'));
    await act(() => result.current.start(tracks, 'CAM2'));
    expect(api.requestStageTokens).toHaveBeenCalledWith('camera', 'CAM2');
    expect(sessions[0]).toMatchObject({ token: 'tok-production', options: { publish: true, subscribe: false, tracks } });
    expect(result.current.state.status).toBe('live');
    expect(wakeLock.request).toHaveBeenCalledWith('screen');
  });

  it('uses the slide stage for slide sharing', async () => {
    api.requestStageTokens.mockReset().mockResolvedValue(tokenResponse(['slide'], 'dev-s'));
    const { result } = renderHook(() => useStageSender('slide'));
    await act(() => result.current.start(tracks));
    expect(api.requestStageTokens).toHaveBeenCalledWith('slide', undefined);
    expect(sessions[0]?.token).toBe('tok-slide');
  });

  it('sends a heartbeat every 15 seconds', async () => {
    const { result } = renderHook(() => useStageSender('mic'));
    await act(() => result.current.start(tracks, 'MIC1'));
    expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);
    await act(() => vi.advanceTimersByTimeAsync(14_999));
    expect(api.sendHeartbeat).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(api.sendHeartbeat).toHaveBeenCalledWith('dev-1');
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(api.sendHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('shows the device limit and does not retry (F-CAM-06)', async () => {
    api.requestStageTokens.mockReset().mockRejectedValue(new ApiError(409, 'DEVICE_LIMIT', '上限です'));
    const { result } = renderHook(() => useStageSender('camera'));
    await act(() => result.current.start(tracks, 'CAM1'));
    expect(result.current.state).toMatchObject({ status: 'error', error: 'deviceLimit' });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(api.requestStageTokens).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(0);
  });

  it('reconnects with a new token after a loss and returns the old slot first', async () => {
    const { result } = renderHook(() => useStageSender('camera'));
    await act(() => result.current.start(tracks, 'CAM1'));
    act(() => sessions[0]?.handlers.onRecoverableLoss?.('errored'));
    expect(result.current.state.status).toBe('reconnecting');
    expect(sessions[0]?.leave).toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(api.releaseDevice).toHaveBeenCalledWith('dev-1');
    expect(api.requestStageTokens).toHaveBeenCalledTimes(2);
    expect(sessions).toHaveLength(2);
    expect(result.current.state).toMatchObject({ status: 'live', reconnects: 1 });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(api.sendHeartbeat).toHaveBeenLastCalledWith('dev-2');
  });

  it('waits for the old slot to be released before requesting a new token (R1-17)', async () => {
    let finishRelease: () => void = () => undefined;
    api.releaseDevice.mockReset().mockImplementation(() => new Promise<void>((resolve) => { finishRelease = resolve; }));
    const { result } = renderHook(() => useStageSender('camera'));
    await act(() => result.current.start(tracks, 'CAM1'));
    act(() => sessions[0]?.handlers.onRecoverableLoss?.('errored'));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(api.releaseDevice).toHaveBeenCalledWith('dev-1');
    expect(api.requestStageTokens).toHaveBeenCalledTimes(1);
    await act(async () => finishRelease());
    expect(api.requestStageTokens).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe('live');
  });

  it('keeps retrying while the slot is still taken during reconnection', async () => {
    api.requestStageTokens.mockReset()
      .mockResolvedValueOnce(tokenResponse(['production'], 'dev-1'))
      .mockRejectedValueOnce(new ApiError(409, 'DEVICE_LIMIT', '上限です'))
      .mockResolvedValue(tokenResponse(['production'], 'dev-3'));
    const { result } = renderHook(() => useStageSender('camera'));
    await act(() => result.current.start(tracks, 'CAM1'));
    act(() => sessions[0]?.handlers.onRecoverableLoss?.('unknown'));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.state.status).toBe('reconnecting');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(result.current.state.status).toBe('live');
  });

  it('re-acquires the slot when the heartbeat says it expired', async () => {
    api.sendHeartbeat.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'なし'));
    const { result } = renderHook(() => useStageSender('camera'));
    await act(() => result.current.start(tracks, 'CAM1'));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.state.status).toBe('reconnecting');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(sessions).toHaveLength(2);
  });

  it('ignores transient heartbeat failures', async () => {
    api.sendHeartbeat.mockRejectedValue(new ApiError(500, 'INTERNAL', 'x'));
    const { result } = renderHook(() => useStageSender('camera'));
    await act(() => result.current.start(tracks, 'CAM1'));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.state.status).toBe('live');
  });

  it('stop leaves, releases the slot and stops heartbeats', async () => {
    const { result } = renderHook(() => useStageSender('camera'));
    await act(() => result.current.start(tracks, 'CAM1'));
    act(() => result.current.stop());
    expect(sessions[0]?.leave).toHaveBeenCalled();
    expect(api.releaseDevice).toHaveBeenCalledWith('dev-1');
    expect(result.current.state.status).toBe('idle');
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(api.sendHeartbeat).not.toHaveBeenCalled();
  });

  it('applies mute, track updates and releases on unmount', async () => {
    const { result, unmount } = renderHook(() => useStageSender('mic'));
    await act(() => result.current.start(tracks, 'MIC1', true));
    expect(sessions[0]?.setMuted).toHaveBeenCalledWith('audio', true);
    act(() => result.current.setMuted(false));
    expect(sessions[0]?.setMuted).toHaveBeenLastCalledWith('audio', false);
    act(() => result.current.updateTracks([]));
    expect(sessions[0]?.setPublishTracks).toHaveBeenCalledWith([]);
    unmount();
    expect(api.releaseDevice).toHaveBeenCalledWith('dev-1');
  });
});
