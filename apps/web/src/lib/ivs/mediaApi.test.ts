import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BroadcastResponseSchema, BroadcastSchema, DeviceNamesResponseSchema, HeartbeatResponseSchema, StageTokenResponseSchema, StatusResponseSchema, ViewerCountResponseSchema } from '@delivery/shared';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch }));
const api = await import('./mediaApi');

beforeEach(() => apiFetch.mockReset().mockResolvedValue('ok'));

const tokens = (stages: string[], suffix = '', expiresAt = '2026-10-19T00:00:00Z') => ({
  tokens: stages.map((stage) => ({ stage, token: `tok-${stage}${suffix}`, participantId: 'p', capabilities: [], expiresAt })),
}) as Parameters<typeof api.tokenFor>[0];
const ALL = ['production', 'slide', 'broadcast'];
const switcher = () => api.requestStageTokens('switcher');
const NOW = Date.parse('2026-10-19T00:00:00Z') - 600_000;

describe('mediaApi', () => {
  it('requests stage tokens with and without a device name', async () => {
    await api.requestStageTokens('camera', 'CAM1');
    expect(apiFetch).toHaveBeenLastCalledWith('/tokens/stage', { method: 'POST', body: { purpose: 'camera', deviceName: 'CAM1' }, schema: StageTokenResponseSchema });
    await api.requestStageTokens('switcher');
    expect(apiFetch).toHaveBeenLastCalledWith('/tokens/stage', { method: 'POST', body: { purpose: 'switcher' }, schema: StageTokenResponseSchema });
    await api.requestStageTokens('camera', 'CAM1', true);
    expect(apiFetch).toHaveBeenLastCalledWith('/tokens/stage', { method: 'POST', body: { purpose: 'camera', deviceName: 'CAM1', takeover: true }, schema: StageTokenResponseSchema });
    await api.requestStageTokens('camera', 'CAM1', false);
    expect(apiFetch).toHaveBeenLastCalledWith('/tokens/stage', { method: 'POST', body: { purpose: 'camera', deviceName: 'CAM1' }, schema: StageTokenResponseSchema });
  });

  it('fetches device names used by others (R3-01)', async () => {
    await api.fetchDeviceNamesInUse('mic');
    expect(apiFetch).toHaveBeenLastCalledWith('/devices/names?purpose=mic', { schema: DeviceNamesResponseSchema });
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

  describe('createSwitcherTokens (R1-02)', () => {
    it('uses one switcher response for all three stages', async () => {
      apiFetch.mockReset().mockResolvedValue(tokens(ALL));
      const tokenOf = api.createSwitcherTokens(switcher, () => NOW);
      const [production, slide] = await Promise.all([tokenOf('production'), tokenOf('slide')]);
      expect([production, slide, await tokenOf('broadcast')]).toEqual(['tok-production', 'tok-slide', 'tok-broadcast']);
      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(apiFetch).toHaveBeenCalledWith('/tokens/stage', { method: 'POST', body: { purpose: 'switcher' }, schema: StageTokenResponseSchema });
    });

    it('requests again only when the same stage reconnects', async () => {
      apiFetch.mockReset().mockResolvedValueOnce(tokens(ALL, '-1')).mockResolvedValue(tokens(ALL, '-2'));
      const tokenOf = api.createSwitcherTokens(switcher, () => NOW);
      expect(await tokenOf('production')).toBe('tok-production-1');
      expect(await tokenOf('production')).toBe('tok-production-2');
      expect(await tokenOf('slide')).toBe('tok-slide-2');
      expect(apiFetch).toHaveBeenCalledTimes(2);
    });

    it('requests again when the cached token is about to expire', async () => {
      apiFetch.mockReset().mockResolvedValueOnce(tokens(ALL, '-1')).mockResolvedValue(tokens(ALL, '-2', '2026-10-19T01:00:00Z'));
      let now = NOW;
      const tokenOf = api.createSwitcherTokens(switcher, () => now);
      await tokenOf('production');
      now = Date.parse('2026-10-19T00:00:00Z') - api.TOKEN_REFRESH_MARGIN_MS + 1;
      expect(await tokenOf('broadcast')).toBe('tok-broadcast-2');
      expect(apiFetch).toHaveBeenCalledTimes(2);
    });

    it('retries after a failed request', async () => {
      apiFetch.mockReset().mockRejectedValueOnce(new Error('down')).mockResolvedValue(tokens(ALL));
      const tokenOf = api.createSwitcherTokens(switcher, () => NOW);
      await expect(tokenOf('production')).rejects.toThrow('down');
      expect(await tokenOf('slide')).toBe('tok-slide');
      expect(apiFetch).toHaveBeenCalledTimes(2);
    });
  });
});
