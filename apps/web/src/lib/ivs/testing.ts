/** テスト専用: jsdom に無いメディア API の代用品と、IVS アダプタのモック状態。 */
import { vi } from 'vitest';
import type { StageSessionHandlers, StageSessionOptions } from './stage';

export class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  contentHint = '';
  stop = vi.fn(() => { this.readyState = 'ended'; });
  constructor(public kind: 'audio' | 'video', public id = `${kind}-${Math.random().toString(36).slice(2, 8)}`) { super(); }
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

export class FakeMediaStream {
  constructor(public tracks: FakeTrack[] = []) {}
  getTracks = () => this.tracks;
  getVideoTracks = () => this.tracks.filter((track) => track.kind === 'video');
  getAudioTracks = () => this.tracks.filter((track) => track.kind === 'audio');
}

export type FakeSession = {
  token: string;
  options: StageSessionOptions;
  handlers: StageSessionHandlers;
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  setPublishTracks: ReturnType<typeof vi.fn>;
  setMuted: ReturnType<typeof vi.fn>;
  getOutboundStats: ReturnType<typeof vi.fn>;
};

/** vi.mock('@/lib/ivs/stage', () => stageMock(sessions)) で使う。 */
export function stageMock(sessions: FakeSession[]) {
  return {
    createStageSession: vi.fn((token: string, options: StageSessionOptions, handlers: StageSessionHandlers = {}) => {
      const session: FakeSession = {
        token, options, handlers,
        join: vi.fn().mockResolvedValue(undefined), leave: vi.fn(), setPublishTracks: vi.fn(), setMuted: vi.fn(),
        getOutboundStats: vi.fn().mockResolvedValue(undefined),
      };
      sessions.push(session);
      return session;
    }),
  };
}

export const tokenResponse = (stages: string[], deviceId?: string) => ({
  tokens: stages.map((stage) => ({ stage, token: `tok-${stage}`, participantId: `p-${stage}`, capabilities: [], expiresAt: '2099-01-01T00:00:00.000Z' })),
  ...(deviceId ? { deviceId } : {}),
});

/** jsdom に無い API を差し替える。 */
export function installMediaGlobals() {
  vi.stubGlobal('MediaStream', FakeMediaStream);
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}
