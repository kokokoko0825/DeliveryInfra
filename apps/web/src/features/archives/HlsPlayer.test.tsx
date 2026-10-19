import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: string, data: Record<string, unknown>) => void;
const hls = vi.hoisted(() => {
  const instances: FakeHls[] = [];
  class FakeHls {
    static isSupported = vi.fn(() => true);
    static Events = { ERROR: 'hlsError', FRAG_LOADED: 'hlsFragLoaded' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    handlers = new Map<string, Handler>();
    config: unknown;
    loadSource = vi.fn();
    attachMedia = vi.fn();
    startLoad = vi.fn();
    destroy = vi.fn();
    constructor(config: unknown) { this.config = config; instances.push(this); }
    on(event: string, handler: Handler) { this.handlers.set(event, handler); }
    emit(event: string, data: Record<string, unknown> = {}) { this.handlers.get(event)?.(event, data); }
  }
  return { FakeHls, instances };
});
vi.mock('hls.js', () => ({ default: hls.FakeHls }));

const { HlsPlayer, MAX_RECOVERIES } = await import('./HlsPlayer');
const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
const forbidden = { fatal: true, type: 'networkError', response: { url: 'seg.ts', code: 403 } };
const FAILED = '再生中にエラーが発生しました。ページを再読み込みしてください';

let nativeHls = false;
beforeEach(() => {
  hls.instances.length = 0;
  nativeHls = false;
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation(() => (nativeHls ? 'maybe' : ''));
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('HlsPlayer (hls.js)', () => {
  it('loads the playback path with credentials', () => {
    render(<HlsPlayer src="/archives/a/master.m3u8" title="定例会" refreshCookies={vi.fn()} />);
    const player = hls.instances[0]!;
    expect(player.loadSource).toHaveBeenCalledWith('/archives/a/master.m3u8');
    expect(player.attachMedia).toHaveBeenCalledWith(screen.getByLabelText('定例会'));
    const xhr = { withCredentials: false };
    (player.config as { xhrSetup: (x: typeof xhr) => void }).xhrSetup(xhr);
    expect(xhr.withCredentials).toBe(true);
  });

  it('refreshes cookies and resumes from the current position after a 403 (R3-03)', async () => {
    const refreshCookies = vi.fn().mockResolvedValue(undefined);
    render(<HlsPlayer src="/a.m3u8" title="定例会" refreshCookies={refreshCookies} />);
    const video = screen.getByLabelText<HTMLVideoElement>('定例会');
    Object.defineProperty(video, 'currentTime', { value: 1234.5, configurable: true });
    const player = hls.instances[0]!;
    player.emit('hlsError', forbidden);
    expect(refreshCookies).toHaveBeenCalledTimes(1);
    expect(player.startLoad).not.toHaveBeenCalled();
    await flush();
    expect(player.startLoad).toHaveBeenCalledWith(1234.5);
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });

  it('ignores non-fatal errors and shows fatal media errors', () => {
    const refreshCookies = vi.fn();
    render(<HlsPlayer src="/a.m3u8" title="定例会" refreshCookies={refreshCookies} />);
    const player = hls.instances[0]!;
    act(() => player.emit('hlsError', { ...forbidden, fatal: false }));
    expect(refreshCookies).not.toHaveBeenCalled();
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
    act(() => player.emit('hlsError', { fatal: true, type: 'mediaError' }));
    expect(refreshCookies).not.toHaveBeenCalled();
    expect(screen.getByText(FAILED)).toBeInTheDocument();
  });

  it('gives up after repeated failures without progress, and resets once fragments load', async () => {
    const refreshCookies = vi.fn().mockResolvedValue(undefined);
    render(<HlsPlayer src="/a.m3u8" title="定例会" refreshCookies={refreshCookies} />);
    const player = hls.instances[0]!;
    for (let i = 0; i < MAX_RECOVERIES; i += 1) {
      player.emit('hlsError', forbidden);
      await flush();
    }
    expect(MAX_RECOVERIES).toBe(3);
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
    player.emit('hlsFragLoaded');
    player.emit('hlsError', forbidden);
    await flush();
    expect(refreshCookies).toHaveBeenCalledTimes(MAX_RECOVERIES + 1);
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
    for (let i = 0; i < MAX_RECOVERIES; i += 1) {
      player.emit('hlsError', forbidden);
      await flush();
    }
    expect(refreshCookies).toHaveBeenCalledTimes(MAX_RECOVERIES * 2);
    expect(screen.getByText(FAILED)).toBeInTheDocument();
  });

  it('shows an error when the cookies cannot be refreshed', async () => {
    render(<HlsPlayer src="/a.m3u8" title="定例会" refreshCookies={vi.fn().mockRejectedValue(new Error('403'))} />);
    hls.instances[0]!.emit('hlsError', forbidden);
    await flush();
    expect(screen.getByText(FAILED)).toBeInTheDocument();
    expect(hls.instances[0]!.startLoad).not.toHaveBeenCalled();
  });

  it('does not resume after unmount and destroys the player', async () => {
    const refreshCookies = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<HlsPlayer src="/a.m3u8" title="定例会" refreshCookies={refreshCookies} />);
    const player = hls.instances[0]!;
    player.emit('hlsError', forbidden);
    unmount();
    await flush();
    expect(player.destroy).toHaveBeenCalled();
    expect(player.startLoad).not.toHaveBeenCalled();
  });

  it('explains when HLS is not supported', () => {
    hls.FakeHls.isSupported.mockReturnValueOnce(false);
    render(<HlsPlayer src="/a.m3u8" title="定例会" refreshCookies={vi.fn()} />);
    expect(screen.getByText('このブラウザではアーカイブを再生できません')).toBeInTheDocument();
    expect(hls.instances).toHaveLength(0);
  });
});

describe('HlsPlayer (Safari native HLS)', () => {
  it('reloads the source at the same position after refreshing cookies on a video error (R3-03)', async () => {
    nativeHls = true;
    const refreshCookies = vi.fn().mockResolvedValue(undefined);
    render(<HlsPlayer src="https://cdn.example/a.m3u8" title="定例会" refreshCookies={refreshCookies} />);
    const video = screen.getByLabelText<HTMLVideoElement>('定例会');
    expect(video.src).toBe('https://cdn.example/a.m3u8');
    expect(hls.instances).toHaveLength(0);
    let time = 600;
    Object.defineProperty(video, 'currentTime', { get: () => time, set: (value: number) => { time = value; }, configurable: true });
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    video.removeAttribute('src');
    act(() => { video.dispatchEvent(new Event('error')); });
    expect(refreshCookies).toHaveBeenCalledTimes(1);
    await flush();
    expect(video.src).toBe('https://cdn.example/a.m3u8');
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    time = 0;
    act(() => { video.dispatchEvent(new Event('loadedmetadata')); });
    expect(time).toBe(600);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('shows the error after repeated native failures', async () => {
    nativeHls = true;
    render(<HlsPlayer src="https://cdn.example/a.m3u8" title="定例会" refreshCookies={vi.fn().mockResolvedValue(undefined)} />);
    const video = screen.getByLabelText<HTMLVideoElement>('定例会');
    for (let i = 0; i <= MAX_RECOVERIES; i += 1) {
      act(() => { video.dispatchEvent(new Event('error')); });
      await flush();
    }
    expect(screen.getByText(FAILED)).toBeInTheDocument();
  });

  it('counts afresh once playback resumes', async () => {
    nativeHls = true;
    const refreshCookies = vi.fn().mockResolvedValue(undefined);
    render(<HlsPlayer src="https://cdn.example/a.m3u8" title="定例会" refreshCookies={refreshCookies} />);
    const video = screen.getByLabelText<HTMLVideoElement>('定例会');
    for (let i = 0; i < MAX_RECOVERIES; i += 1) {
      act(() => { video.dispatchEvent(new Event('error')); });
      await flush();
    }
    act(() => { video.dispatchEvent(new Event('playing')); });
    act(() => { video.dispatchEvent(new Event('error')); });
    await flush();
    expect(refreshCookies).toHaveBeenCalledTimes(MAX_RECOVERIES + 1);
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });
});
