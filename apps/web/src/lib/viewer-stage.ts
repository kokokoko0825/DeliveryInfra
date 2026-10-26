import { useEffect, useState } from 'react';
import { Stage, StageConnectionState, StageEvents, SubscribeType, type StageStrategy } from 'amazon-ivs-web-broadcast';
import { StageTokenResponseSchema } from '@delivery/shared';
import { apiFetch, errorMessage } from './api';
import { backoffMs } from './retry';
import { recordClientDiagnostic } from './diagnostics';

export type ViewerState = 'idle' | 'connecting' | 'connected' | 'reconnecting';

/** 視聴者は送信せず、配信用ステージの映像と音声を受信するだけ。 */
export const viewerStrategy: StageStrategy = {
  stageStreamsToPublish: () => [],
  shouldPublishParticipant: () => false,
  shouldSubscribeToParticipant: () => SubscribeType.AUDIO_VIDEO,
};

export async function fetchViewerToken(): Promise<string> {
  const response = await apiFetch('/tokens/stage', { method: 'POST', body: { purpose: 'viewer' }, schema: StageTokenResponseSchema });
  const token = response.tokens.find((entry) => entry.stage === 'broadcast');
  if (!token) throw new Error('配信用ステージのトークンがありません');
  return token.token;
}

/** active の間だけ配信用ステージを SUBSCRIBE で受信し、切断時は自動で再接続する。 */
export function useViewerStage(active: boolean): { stream: MediaStream | null; state: ViewerState; error: string | null } {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [state, setState] = useState<ViewerState>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) { setState('idle'); return undefined; }
    let disposed = false;
    let attempt = 0;
    let stage: Stage | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tracks = new Map<string, MediaStreamTrack>();
    const publish = () => setStream(tracks.size > 0 ? new MediaStream([...tracks.values()]) : null);
    const leave = () => { const current = stage; stage = null; current?.leave(); };
    const scheduleReconnect = () => {
      if (disposed) return;
      leave();
      tracks.clear();
      publish();
      setState('reconnecting');
      clearTimeout(timer);
      timer = setTimeout(() => { void join(); }, backoffMs(attempt));
      attempt += 1;
    };
    const join = async () => {
      try {
        const token = await fetchViewerToken();
        if (disposed) return;
        const current = new Stage(token, viewerStrategy);
        stage = current;
        current.on(StageEvents.STAGE_CONNECTION_STATE_CHANGED, (connectionState) => {
          if (stage !== current) return;
          if (connectionState === StageConnectionState.CONNECTED) { attempt = 0; setError(null); setState('connected'); }
          else if (connectionState === StageConnectionState.ERRORED || connectionState === StageConnectionState.DISCONNECTED) scheduleReconnect();
        });
        current.on(StageEvents.STAGE_PARTICIPANT_STREAMS_ADDED, (_participant, streams) => {
          streams.forEach((s) => tracks.set(s.mediaStreamTrack.id, s.mediaStreamTrack));
          publish();
        });
        current.on(StageEvents.STAGE_PARTICIPANT_STREAMS_REMOVED, (_participant, streams) => {
          streams.forEach((s) => tracks.delete(s.mediaStreamTrack.id));
          publish();
        });
        await current.join();
      } catch (cause) {
        recordClientDiagnostic(cause, 'viewer.stage.join', { retryAttempt: attempt });
        setError(errorMessage(cause));
        scheduleReconnect();
      }
    };
    setState('connecting');
    void join();
    return () => {
      disposed = true;
      clearTimeout(timer);
      leave();
      setStream(null);
    };
  }, [active]);

  return { stream, state, error };
}
