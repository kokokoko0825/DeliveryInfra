import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { StageName } from '@delivery/shared';
import { ApiError } from '@/lib/api';
import { createManagedSession, type ManagedSession } from '@/lib/ivs/managedSession';
import { releaseDevice, requestStageTokens, sendHeartbeat, tokenFor } from '@/lib/ivs/mediaApi';
import type { PublishTrack } from '@/lib/ivs/stage';
import { holdWakeLock } from '@/lib/ivs/wakeLock';
import { classifyError, initialSenderState, isActive, senderReducer } from './engine/session';

export const HEARTBEAT_INTERVAL_MS = 15_000;

type SenderPurpose = 'camera' | 'mic' | 'slide';
const STAGE_OF: Record<SenderPurpose, StageName> = { camera: 'production', mic: 'production', slide: 'slide' };

/**
 * 1つのステージへ PUBLISH する送信セッション。
 * トークン発行（枠確保）→ join → 15秒ハートビート → 切断時は枠を返してトークン再発行込みで自動再接続 → 停止時に枠を解放。
 */
export function useStageSender(purpose: SenderPurpose) {
  const [state, dispatch] = useReducer(senderReducer, initialSenderState);
  const managed = useRef<ManagedSession | null>(null);
  const deviceId = useRef<string | undefined>(undefined);
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopHeartbeat = useCallback(() => {
    if (heartbeat.current) clearInterval(heartbeat.current);
    heartbeat.current = null;
  }, []);
  /** 枠を返す。失敗しても失効で回収されるので握りつぶす。 */
  const release = useCallback(async () => {
    const id = deviceId.current;
    deviceId.current = undefined;
    if (id) await releaseDevice(id).catch(() => undefined);
  }, []);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    const id = deviceId.current;
    if (!id) return;
    heartbeat.current = setInterval(() => {
      sendHeartbeat(id).catch((error: unknown) => {
        // 枠が失効していたら取り直す
        if (error instanceof ApiError && error.status === 404) managed.current?.restart();
      });
    }, HEARTBEAT_INTERVAL_MS);
  }, [stopHeartbeat]);

  const start = useCallback(async (tracks: PublishTrack[], deviceName?: string, muted = false) => {
    managed.current?.stop();
    dispatch({ type: 'START' });
    const session = createManagedSession({
      publish: true,
      subscribe: false,
      tracks,
      fetchToken: async () => {
        // 再接続時は前の枠を返し終えてから取り直す（上限ちょうどのとき 409 にならないように）
        await release();
        const response = await requestStageTokens(purpose, deviceName);
        deviceId.current = response.deviceId;
        return tokenFor(response, STAGE_OF[purpose]);
      },
      onStatus: (status) => {
        if (status === 'connected') {
          startHeartbeat();
          dispatch({ type: 'CONNECTED' });
        } else if (status === 'reconnecting') {
          stopHeartbeat();
          dispatch({ type: 'CONNECTION_LOST' });
        }
      },
    });
    session.setMuted(muted);
    managed.current = session;
    try {
      await session.start();
    } catch (error) {
      // 初回の失敗（台数上限・権限など）は自動再試行せずに表示する
      session.stop();
      stopHeartbeat();
      void release();
      dispatch({ type: 'FAILED', error: classifyError(error) });
    }
  }, [purpose, release, startHeartbeat, stopHeartbeat]);

  const stop = useCallback(() => {
    managed.current?.stop();
    managed.current = null;
    stopHeartbeat();
    void release();
    dispatch({ type: 'STOPPED' });
  }, [release, stopHeartbeat]);

  /** 送信中のトラックを差し替える（カメラ切替・再共有）。空配列なら送信を止める。 */
  const updateTracks = useCallback((tracks: PublishTrack[]) => managed.current?.setPublishTracks(tracks), []);
  const setMuted = useCallback((value: boolean) => managed.current?.setMuted(value), []);

  const active = isActive(state.status);
  useEffect(() => (active ? holdWakeLock() : undefined), [active]);
  useEffect(() => {
    const onPageHide = () => void release();
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [release]);
  useEffect(() => () => {
    managed.current?.stop();
    stopHeartbeat();
    void release();
  }, [release, stopHeartbeat]);

  return { state, start, stop, updateTracks, setMuted };
}
