/**
 * amazon-ivs-web-broadcast の Stage API への薄いアダプタ。
 * 判断ロジックは strategy.ts に置き、ここは SDK の呼び出しとイベント変換だけを行う。
 * テストではこのモジュールをモックする。
 */
import { LocalStageStream, Stage, StageEvents, type StageParticipantInfo, type StageStream, type SubscribeType } from 'amazon-ivs-web-broadcast';
import { isRecoverableLeave, shouldPublish, subscribeTypeFor, toRemoteParticipant, type ConnectionState, type RemoteParticipant } from './strategy';

export type PublishConfig = { maxVideoBitrateKbps?: number; maxFramerate?: number; maxAudioBitrateKbps?: number; stereo?: boolean };
export type PublishTrack = {
  track: MediaStreamTrack;
  config?: PublishConfig | undefined;
};
export type RemoteTrack = { kind: 'audio' | 'video'; track: MediaStreamTrack };

export type StageSessionHandlers = {
  onConnectionState?: (state: ConnectionState) => void;
  onStreamsAdded?: (participant: RemoteParticipant, tracks: RemoteTrack[]) => void;
  onStreamsRemoved?: (participant: RemoteParticipant, tracks: RemoteTrack[]) => void;
  onParticipantLeft?: (participant: RemoteParticipant) => void;
  /** 自動再接続の対象となる切断（ERRORED 含む）。 */
  onRecoverableLoss?: (reason: string) => void;
};

export type StageSession = {
  join: () => Promise<void>;
  leave: () => void;
  setPublishTracks: (tracks: PublishTrack[]) => void;
  setMuted: (kind: 'audio' | 'video', muted: boolean) => void;
  getOutboundStats: () => Promise<RTCStatsReport | undefined>;
};

export type StageSessionOptions = { publish: boolean; subscribe: boolean; tracks: PublishTrack[] };

const toRemoteTracks = (streams: StageStream[]): RemoteTrack[] =>
  streams.map((stream) => ({ kind: stream.streamType === 'audio' ? 'audio' : 'video', track: stream.mediaStreamTrack }));

export function createStageSession(token: string, options: StageSessionOptions, handlers: StageSessionHandlers = {}): StageSession {
  let local = options.tracks.map(({ track, config }) => new LocalStageStream(track, config ?? {}));
  const stage = new Stage(token, {
    stageStreamsToPublish: () => local,
    shouldPublishParticipant: () => shouldPublish(options.publish, local.length),
    shouldSubscribeToParticipant: (participant: StageParticipantInfo) =>
      subscribeTypeFor(toRemoteParticipant(participant), options.subscribe) as SubscribeType,
  });
  stage.on(StageEvents.STAGE_CONNECTION_STATE_CHANGED, (state) => {
    handlers.onConnectionState?.(state as ConnectionState);
    if (state === 'errored') handlers.onRecoverableLoss?.('errored');
  });
  stage.on(StageEvents.STAGE_PARTICIPANT_STREAMS_ADDED, (participant, streams) => {
    if (!participant.isLocal) handlers.onStreamsAdded?.(toRemoteParticipant(participant), toRemoteTracks(streams));
  });
  stage.on(StageEvents.STAGE_PARTICIPANT_STREAMS_REMOVED, (participant, streams) => {
    if (!participant.isLocal) handlers.onStreamsRemoved?.(toRemoteParticipant(participant), toRemoteTracks(streams));
  });
  stage.on(StageEvents.STAGE_PARTICIPANT_LEFT, (participant) => {
    if (!participant.isLocal) handlers.onParticipantLeft?.(toRemoteParticipant(participant));
  });
  stage.on(StageEvents.STAGE_LEFT, (reason) => {
    if (isRecoverableLeave(String(reason))) handlers.onRecoverableLoss?.(String(reason));
  });

  return {
    join: () => stage.join(),
    leave: () => {
      stage.removeAllListeners();
      stage.leave();
    },
    setPublishTracks: (tracks) => {
      local = tracks.map(({ track, config }) => new LocalStageStream(track, config ?? {}));
      stage.refreshStrategy();
    },
    setMuted: (kind, muted) => local.filter((stream) => stream.streamType === kind).forEach((stream) => stream.setMuted(muted)),
    getOutboundStats: async () => {
      const video = local.find((stream) => stream.streamType === 'video') ?? local[0];
      return video?.requestRTCStats();
    },
  };
}
