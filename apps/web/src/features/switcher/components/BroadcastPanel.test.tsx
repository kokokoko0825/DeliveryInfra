import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/test/render';

const api = vi.hoisted(() => ({ fetchBroadcast: vi.fn(), fetchBroadcastStats: vi.fn(), startBroadcast: vi.fn(), stopBroadcast: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/ivs/mediaApi', () => api);
vi.mock('sonner', () => ({ toast }));
const { BroadcastPanel } = await import('./BroadcastPanel');

const live = { id: 'b-1', title: '定例会', status: 'live', startedAt: '2026-10-20T00:00:00.000Z', endedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchBroadcast.mockResolvedValue(null);
  api.fetchBroadcastStats.mockResolvedValue({ viewerCount: 0 });
});

const start = async () => {
  const props = { running: true, publishing: false, bitrate: null, startPublishing: vi.fn(async () => undefined), stopPublishing: vi.fn() };
  renderPage(<BroadcastPanel {...props} />);
  fireEvent.change(screen.getByLabelText('配信タイトル'), { target: { value: '定例会' } });
  fireEvent.click(screen.getByRole('button', { name: '配信開始' }));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '配信開始' }));
  return props;
};

describe('BroadcastPanel start (R4-01)', () => {
  it('keeps publishing once the start API succeeded, even if a later step throws', async () => {
    api.startBroadcast.mockResolvedValue(live);
    toast.success.mockImplementationOnce(() => { throw new Error('toast failed'); });
    const props = await start();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('toast failed'));
    expect(props.startPublishing).toHaveBeenCalledTimes(1);
    expect(props.stopPublishing).not.toHaveBeenCalled();
  });

  it('stops publishing when the start API fails', async () => {
    api.startBroadcast.mockRejectedValue(new Error('処理に失敗しました'));
    const props = await start();
    await waitFor(() => expect(props.stopPublishing).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith('処理に失敗しました');
  });
});
