import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext } from '@/features/auth/auth-context';
import { makeAuth } from '@/test/render';

const chat = vi.hoisted(() => ({ useChatRoom: vi.fn() }));
vi.mock('@/lib/chat', () => chat);
const { ChatProvider } = await import('./ChatProvider');

describe('ChatProvider', () => {
  it('connects only when signed in and invalidates queries on custom events', () => {
    chat.useChatRoom.mockReturnValue({ comments: [], connection: 'connected', capabilities: [], send: vi.fn(), remove: vi.fn() });
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    const auth = makeAuth();
    render(<QueryClientProvider client={queryClient}><AuthContext.Provider value={auth}><ChatProvider><p>x</p></ChatProvider></AuthContext.Provider></QueryClientProvider>);
    const options = chat.useChatRoom.mock.calls.at(-1)?.[0];
    expect(options).toMatchObject({ enabled: true, region: 'ap-northeast-1' });
    options.onEvent('broadcast-started');
    expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toEqual([['broadcast']]);
    invalidate.mockClear();
    options.onEvent('broadcast-ended');
    expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toEqual([['broadcast'], ['archives']]);
    invalidate.mockClear();
    options.onEvent('slides-updated');
    options.onEvent('archives-updated');
    expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toEqual([['slides'], ['archives']]);
    options.onServerDisconnect();
    expect(auth.refresh).toHaveBeenCalled();
  });

  it('tolerates a duplicated broadcast-ended event resent by the API (R2-03)', () => {
    chat.useChatRoom.mockReturnValue({ comments: [], connection: 'connected', capabilities: [], send: vi.fn(), remove: vi.fn() });
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    render(<QueryClientProvider client={queryClient}><AuthContext.Provider value={makeAuth()}><ChatProvider><p>x</p></ChatProvider></AuthContext.Provider></QueryClientProvider>);
    const options = chat.useChatRoom.mock.calls.at(-1)?.[0];
    expect(() => { options.onEvent('broadcast-ended'); options.onEvent('broadcast-ended'); }).not.toThrow();
    // 重複しても再取得が増えるだけで状態は壊れない（冪等）
    expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toEqual([['broadcast'], ['archives'], ['broadcast'], ['archives']]);
  });

  it('stays disconnected when signed out', () => {
    chat.useChatRoom.mockReturnValue({ comments: [], connection: 'disconnected', capabilities: [], send: vi.fn(), remove: vi.fn() });
    render(<QueryClientProvider client={new QueryClient()}><AuthContext.Provider value={makeAuth({ status: 'signedOut', me: null, config: null })}><ChatProvider><p>x</p></ChatProvider></AuthContext.Provider></QueryClientProvider>);
    expect(chat.useChatRoom.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false, region: undefined });
  });
});
