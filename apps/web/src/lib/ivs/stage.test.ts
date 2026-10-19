import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;
const sdk = vi.hoisted(() => {
  class FakeLocalStageStream {
    streamType: string;
    setMuted = vi.fn();
    requestRTCStats = vi.fn().mockResolvedValue('stats');
    constructor(public mediaStreamTrack: { kind: string }, public config: unknown) { this.streamType = mediaStreamTrack.kind; }
  }
  const stages: FakeStage[] = [];
  class FakeStage {
    listeners = new Map<string, Listener>();
    join = vi.fn().mockResolvedValue(undefined);
    leave = vi.fn();
    refreshStrategy = vi.fn();
    removeAllListeners = vi.fn();
    constructor(public token: string, public strategy: Record<string, (...args: unknown[]) => unknown>) { stages.push(this); }
    on(event: string, listener: Listener) { this.listeners.set(event, listener); }
    emit(event: string, ...args: unknown[]) { this.listeners.get(event)?.(...args); }
  }
  return { FakeLocalStageStream, FakeStage, stages };
});

vi.mock('amazon-ivs-web-broadcast', () => ({
  Stage: sdk.FakeStage,
  LocalStageStream: sdk.FakeLocalStageStream,
  StageEvents: {
    STAGE_CONNECTION_STATE_CHANGED: 'state', STAGE_PARTICIPANT_STREAMS_ADDED: 'added', STAGE_PARTICIPANT_STREAMS_REMOVED: 'removed',
    STAGE_PARTICIPANT_LEFT: 'left', STAGE_LEFT: 'stageLeft',
  },
}));

const { createStageSession } = await import('./stage');
const track = (kind: string) => ({ kind }) as unknown as MediaStreamTrack;
const remote = { id: 'r1', isLocal: false, attributes: { kind: 'camera', deviceName: 'CAM1' } };
const local = { ...remote, isLocal: true };

beforeEach(() => { sdk.stages.length = 0; });

describe('createStageSession', () => {
  it('builds a strategy that publishes the given tracks with their config', () => {
    createStageSession('tok', { publish: true, subscribe: false, tracks: [{ track: track('video'), config: { maxFramerate: 30 } }, { track: track('audio') }] });
    const stage = sdk.stages[0]!;
    expect(stage.token).toBe('tok');
    const streams = stage.strategy.stageStreamsToPublish!() as InstanceType<typeof sdk.FakeLocalStageStream>[];
    expect(streams.map((stream) => stream.config)).toEqual([{ maxFramerate: 30 }, {}]);
    expect(stage.strategy.shouldPublishParticipant!(local)).toBe(true);
    expect(stage.strategy.shouldSubscribeToParticipant!(remote)).toBe('none');
  });

  it('subscribes by participant kind when subscribing', () => {
    createStageSession('tok', { publish: false, subscribe: true, tracks: [] });
    const stage = sdk.stages[0]!;
    expect(stage.strategy.shouldPublishParticipant!(local)).toBe(false);
    expect(stage.strategy.shouldSubscribeToParticipant!(remote)).toBe('audio_video');
    expect(stage.strategy.shouldSubscribeToParticipant!({ ...remote, attributes: { kind: 'mic' } })).toBe('audio_only');
  });

  it('forwards remote events and ignores the local participant', () => {
    const handlers = { onConnectionState: vi.fn(), onStreamsAdded: vi.fn(), onStreamsRemoved: vi.fn(), onParticipantLeft: vi.fn(), onRecoverableLoss: vi.fn() };
    createStageSession('tok', { publish: false, subscribe: true, tracks: [] }, handlers);
    const stage = sdk.stages[0]!;
    const video = { streamType: 'video', mediaStreamTrack: track('video') };
    const audio = { streamType: 'audio', mediaStreamTrack: track('audio') };
    stage.emit('added', remote, [video, audio]);
    stage.emit('added', local, [video]);
    expect(handlers.onStreamsAdded).toHaveBeenCalledTimes(1);
    expect(handlers.onStreamsAdded).toHaveBeenCalledWith({ id: 'r1', kind: 'camera', deviceName: 'CAM1' }, [{ kind: 'video', track: video.mediaStreamTrack }, { kind: 'audio', track: audio.mediaStreamTrack }]);
    stage.emit('removed', remote, [audio]);
    stage.emit('removed', local, [audio]);
    expect(handlers.onStreamsRemoved).toHaveBeenCalledTimes(1);
    expect(handlers.onStreamsRemoved).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), [{ kind: 'audio', track: audio.mediaStreamTrack }]);
    stage.emit('left', remote);
    stage.emit('left', local);
    expect(handlers.onParticipantLeft).toHaveBeenCalledTimes(1);
  });

  it('reports recoverable losses only', () => {
    const handlers = { onConnectionState: vi.fn(), onRecoverableLoss: vi.fn() };
    createStageSession('tok', { publish: true, subscribe: false, tracks: [] }, handlers);
    const stage = sdk.stages[0]!;
    stage.emit('state', 'connected');
    expect(handlers.onConnectionState).toHaveBeenCalledWith('connected');
    expect(handlers.onRecoverableLoss).not.toHaveBeenCalled();
    stage.emit('state', 'errored');
    expect(handlers.onRecoverableLoss).toHaveBeenCalledWith('errored');
    stage.emit('stageLeft', 'user-initiated');
    expect(handlers.onRecoverableLoss).toHaveBeenCalledTimes(1);
    stage.emit('stageLeft', 'unknown');
    expect(handlers.onRecoverableLoss).toHaveBeenLastCalledWith('unknown');
  });

  it('reports a server-side disconnect as ended, not as recoverable (R3-02)', () => {
    const handlers = { onRecoverableLoss: vi.fn(), onEnded: vi.fn() };
    createStageSession('tok', { publish: true, subscribe: false, tracks: [] }, handlers);
    const stage = sdk.stages[0]!;
    stage.emit('stageLeft', 'user-initiated');
    expect(handlers.onEnded).not.toHaveBeenCalled();
    stage.emit('stageLeft', 'participant-disconnected');
    expect(handlers.onEnded).toHaveBeenCalledWith('participant-disconnected');
    stage.emit('stageLeft', 'stage-deleted');
    expect(handlers.onEnded).toHaveBeenLastCalledWith('stage-deleted');
    expect(handlers.onRecoverableLoss).not.toHaveBeenCalled();
  });

  it('works without handlers', () => {
    createStageSession('tok', { publish: true, subscribe: false, tracks: [] });
    const stage = sdk.stages[0]!;
    expect(() => {
      stage.emit('state', 'errored');
      stage.emit('added', remote, []);
      stage.emit('removed', remote, []);
      stage.emit('left', remote);
      stage.emit('stageLeft', 'unknown');
    }).not.toThrow();
  });

  it('joins, leaves, swaps tracks, mutes by kind and reads stats', async () => {
    const session = createStageSession('tok', { publish: true, subscribe: false, tracks: [{ track: track('audio') }] });
    const stage = sdk.stages[0]!;
    await session.join();
    expect(stage.join).toHaveBeenCalled();
    expect(await session.getOutboundStats()).toBe('stats');
    session.setPublishTracks([{ track: track('video') }, { track: track('audio'), config: { stereo: true } }]);
    expect(stage.refreshStrategy).toHaveBeenCalled();
    const streams = stage.strategy.stageStreamsToPublish!() as InstanceType<typeof sdk.FakeLocalStageStream>[];
    expect(streams.map((stream) => stream.config)).toEqual([{}, { stereo: true }]);
    session.setMuted('audio', true);
    expect(streams[1]!.setMuted).toHaveBeenCalledWith(true);
    expect(streams[0]!.setMuted).not.toHaveBeenCalled();
    await session.getOutboundStats();
    expect(streams[0]!.requestRTCStats).toHaveBeenCalled();
    expect(streams[1]!.requestRTCStats).not.toHaveBeenCalled();
    session.setPublishTracks([]);
    expect(stage.strategy.shouldPublishParticipant!(local)).toBe(false);
    expect(await session.getOutboundStats()).toBeUndefined();
    session.leave();
    expect(stage.removeAllListeners).toHaveBeenCalled();
    expect(stage.leave).toHaveBeenCalled();
  });
});
