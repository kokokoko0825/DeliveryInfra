/** 送信・スイッチングで使う API 呼び出し（契約は @delivery/shared の zod）。 */
import {
  BroadcastResponseSchema, BroadcastSchema, BroadcastStartRequestSchema, HeartbeatResponseSchema, StageTokenRequestSchema,
  StageTokenResponseSchema, StatusResponseSchema, ViewerCountResponseSchema,
  type StageName, type StagePurpose, type StageTokenResponse,
} from '@delivery/shared';
import { apiFetch } from '@/lib/api';

export function requestStageTokens(purpose: StagePurpose, deviceName?: string): Promise<StageTokenResponse> {
  const body = StageTokenRequestSchema.parse(deviceName === undefined ? { purpose } : { purpose, deviceName });
  return apiFetch('/tokens/stage', { method: 'POST', body, schema: StageTokenResponseSchema });
}

/** 応答から指定ステージのトークンを取り出す（配列順には依存しない）。 */
export function tokenFor(response: StageTokenResponse, stage: StageName): string {
  const found = response.tokens.find((token) => token.stage === stage);
  if (!found) throw new Error(`${stage} ステージのトークンがありません`);
  return found.token;
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
