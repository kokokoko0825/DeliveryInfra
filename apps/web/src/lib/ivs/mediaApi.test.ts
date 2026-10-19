import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BroadcastResponseSchema, BroadcastSchema, HeartbeatResponseSchema, StageTokenResponseSchema, StatusResponseSchema, ViewerCountResponseSchema } from '@delivery/shared';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch }));
const api = await import('./mediaApi');

beforeEach(() => apiFetch.mockReset().mockResolvedValue('ok'));

const tokens = (stages: string[]) => ({
  tokens: stages.map((stage) => ({ stage, token: `tok-${stage}`, participantId: 'p', capabilities: [], expiresAt: '2026-10-19T00:00:00Z' })),
}) as Parameters<typeof api.tokenFor>[0];

describe('mediaApi', () => {
  it('requests stage tokens with and without a device name', async () => {
    await api.requestStageTokens('camera', 'CAM1');
    expect(apiFetch).toHaveBeenLastCalledWith('/tokens/stage', { method: 'POST', body: { purpose: 'camera', deviceName: 'CAM1' }, schema: StageTokenResponseSchema });
    await api.requestStageTokens('switcher');
    expect(apiFetch).toHaveBeenLastCalledWith('/tokens/stage', { method: 'POST', body: { purpose: 'switcher' }, schema: StageTokenResponseSchema });
  });

  it('rejects invalid device names before calling the API', () => {
    expect(() => api.requestStageTokens('camera', 'CAM 1')).toThrow();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('picks tokens by logical stage name regardless of order', () => {
    const response = tokens(['broadcast', 'production', 'slide']);
    expect(api.tokenFor(response, 'production')).toBe('tok-production');
    expect(api.tokenFor(response, 'slide')).toBe('tok-slide');
    expect(api.tokenFor(response, 'broadcast')).toBe('tok-broadcast');
    expect(() => api.tokenFor(tokens(['production']), 'broadcast')).toThrow('broadcast ステージのトークンがありません');
  });

  it('sends heartbeats and releases devices with encoded ids', async () => {
    await api.sendHeartbeat('a/b');
    expect(apiFetch).toHaveBeenLastCalledWith('/devices/a%2Fb/heartbeat', { method: 'POST', body: {}, schema: HeartbeatResponseSchema });
    await api.releaseDevice('a/b');
    expect(apiFetch).toHaveBeenLastCalledWith('/devices/a%2Fb', { method: 'DELETE' });
  });

  it('calls broadcast, stats and status endpoints', async () => {
    await api.fetchBroadcast();
    expect(apiFetch).toHaveBeenLastCalledWith('/broadcast', { schema: BroadcastResponseSchema });
    await api.startBroadcast('定例会');
    expect(apiFetch).toHaveBeenLastCalledWith('/broadcast/start', { method: 'POST', body: { title: '定例会' }, schema: BroadcastSchema });
    await api.stopBroadcast();
    expect(apiFetch).toHaveBeenLastCalledWith('/broadcast/stop', { method: 'POST', body: {}, schema: BroadcastSchema });
    await api.fetchBroadcastStats();
    expect(apiFetch).toHaveBeenLastCalledWith('/broadcast/stats', { schema: ViewerCountResponseSchema });
    await api.fetchStatus();
    expect(apiFetch).toHaveBeenLastCalledWith('/status', { schema: StatusResponseSchema });
  });

  it('validates the broadcast title (1〜100)', () => {
    expect(() => api.startBroadcast('')).toThrow();
    expect(() => api.startBroadcast('a'.repeat(101))).toThrow();
    expect(() => api.startBroadcast('a'.repeat(100))).not.toThrow();
  });
});
