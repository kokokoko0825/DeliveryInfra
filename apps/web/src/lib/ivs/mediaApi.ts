/** 送信・スイッチングで使う API 呼び出し（契約は @delivery/shared の zod）。 */
import {
  BroadcastResponseSchema, BroadcastSchema, BroadcastStartRequestSchema, DeviceNamesResponseSchema, HeartbeatResponseSchema, StageTokenRequestSchema,
  StageTokenResponseSchema, StatusResponseSchema, ViewerCountResponseSchema,
  type StageName, type StagePurpose, type StageTokenResponse,
} from '@delivery/shared';
import { apiFetch } from '@/lib/api';

/** takeover は本人の別端末が同じ端末名で送信中のときに明示的に引き継ぐ場合だけ true にする（R3-02）。 */
export function requestStageTokens(purpose: StagePurpose, deviceName?: string, takeover = false): Promise<StageTokenResponse> {
  const body = StageTokenRequestSchema.parse({ purpose, ...(deviceName === undefined ? {} : { deviceName }), ...(takeover ? { takeover } : {}) });
  return apiFetch('/tokens/stage', { method: 'POST', body, schema: StageTokenResponseSchema });
}

/** 他のユーザーが使用中の端末名（R3-01）。 */
export const fetchDeviceNamesInUse = (purpose: 'camera' | 'mic') =>
  apiFetch(`/devices/names?purpose=${purpose}`, { schema: DeviceNamesResponseSchema });

/** 応答から指定ステージのトークンを取り出す（配列順には依存しない）。 */
export function tokenFor(response: StageTokenResponse, stage: StageName): string {
  const found = response.tokens.find((token) => token.stage === stage);
  if (!found) throw new Error(`${stage} ステージのトークンがありません`);
  return found.token;
}

/** 期限まで残りがこれ未満のトークンは使わずに取り直す。 */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * スイッチャー用トークンの取得元（Review-1 R1-02）。
 * purpose=switcher の1回の応答に production/slide/broadcast の3本が入るので、それを各ステージで1回ずつ使う。
 * 同じステージが再度求めたとき（再接続）か、期限が近いときだけ取り直す。
 */
export function createSwitcherTokens(request: () => Promise<StageTokenResponse>, now: () => number = Date.now) {
  let pending: Promise<StageTokenResponse> | null = null;
  const used = new Set<StageName>();
  const refresh = () => {
    used.clear();
    const next = request();
    pending = next;
    // 失敗した応答は次回に取り直す
    next.catch(() => { if (pending === next) pending = null; });
    return next;
  };
  return async (stage: StageName): Promise<string> => {
    let response = await (pending && !used.has(stage) ? pending : refresh());
    const fresh = (r: StageTokenResponse) => {
      const expiresAt = r.tokens.find((token) => token.stage === stage)?.expiresAt;
      return expiresAt === undefined || Date.parse(expiresAt) - now() >= TOKEN_REFRESH_MARGIN_MS;
    };
    if (!fresh(response)) response = await refresh();
    used.add(stage);
    return tokenFor(response, stage);
  };
}

export const sendHeartbeat = (deviceId: string) =>
  apiFetch(`/devices/${encodeURIComponent(deviceId)}/heartbeat`, { method: 'POST', body: {}, schema: HeartbeatResponseSchema });

export const releaseDevice = (deviceId: string) =>
  apiFetch(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });

export const fetchBroadcast = () => apiFetch('/broadcast', { schema: BroadcastResponseSchema });

export const startBroadcast = (title: string) =>
  apiFetch('/broadcast/start', { method: 'POST', body: BroadcastStartRequestSchema.parse({ title }), schema: BroadcastSchema });

export const stopBroadcast = () => apiFetch('/broadcast/stop', { method: 'POST', body: {}, schema: BroadcastSchema });

export const fetchBroadcastStats = () => apiFetch('/broadcast/stats', { schema: ViewerCountResponseSchema });

export const fetchStatus = () => apiFetch('/status', { schema: StatusResponseSchema });
