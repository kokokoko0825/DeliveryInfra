import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Comment } from '@delivery/shared';

const sdk = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => unknown;
  class FakeChatRoom {
    static instances: FakeChatRoom[] = [];
    listeners = new Map<string, Set<Listener>>();
    state = 'disconnected';
    connect = vi.fn(() => { this.state = 'connecting'; });
    disconnect = vi.fn();
    sendMessage = vi.fn<(request: unknown) => Promise<object>>(async () => ({}));
    constructor(public config: { regionOrUrl: string; tokenProvider: () => Promise<{ token: string }> }) { FakeChatRoom.instances.push(this); }
    addListener(name: string, listener: Listener) {
      const set = this.listeners.get(name) ?? new Set();
      set.add(listener);
      this.listeners.set(name, set);
      return () => set.delete(listener);
    }
    emit(name: string, ...args: unknown[]) {
      if (name === 'connect') this.state = 'connected';
      this.listeners.get(name)?.forEach((listener) => listener(...args));
    }
  }
  class SendMessageRequest { constructor(public content: string, public attributes?: Record<string, string>) {} }
  return { FakeChatRoom, SendMessageRequest };
});
vi.mock('amazon-ivs-chat-messaging', () => ({ ChatRoom: sdk.FakeChatRoom, SendMessageRequest: sdk.SendMessageRequest }));

const { chatErrorMessage, isChatEventName, mergeComments, removeComment, replaceWithHistory, toComment, useChatRoom } = await import('./chat');

const comment = (id: string, sentAt: string, overrides: Partial<Comment> = {}): Comment => ({
  messageId: id, userId: 'u', displayName: 'n', comment: id, sentAt, deleted: false, ...overrides,
});
const room = () => sdk.FakeChatRoom.instances.at(-1)!;

describe('pure helpers', () => {
  it('maps chat messages to comments', () => {
    const sendTime = new Date('2026-10-19T00:00:00Z');
    expect(toComment({ id: 'm1', content: 'hi', sendTime, sender: { userId: 'u1' }, attributes: { displayName: 'たなか' } })).toEqual({
      messageId: 'm1', userId: 'u1', displayName: 'たなか', comment: 'hi', sentAt: '2026-10-19T00:00:00.000Z', deleted: false,
    });
    expect(toComment({ id: 'm2', content: 'x', sendTime, sender: { userId: 'u2', attributes: { displayName: 'すずき' } } }).displayName).toBe('すずき');
    expect(toComment({ id: 'm3', content: 'x', sendTime, sender: { userId: 'u3' } }).displayName).toBe('');
  });
  it('merges by id, sorts by time, drops deleted, keeps the latest 100', () => {
    const merged = mergeComments([comment('b', '2'), comment('a', '1')], [comment('b', '2', { comment: 'new' }), comment('c', '3', { deleted: true })]);
    expect(merged.map((c) => [c.messageId, c.comment])).toEqual([['a', 'a'], ['b', 'new']]);
    const many = Array.from({ length: 105 }, (_, i) => comment(`m${i}`, String(i).padStart(3, '0')));
    const capped = mergeComments([], many);
    expect(capped).toHaveLength(100);
    expect(capped[0]?.messageId).toBe('m5');
    expect(capped.at(-1)?.messageId).toBe('m104');
  });
  it('replaces with history but keeps newer live comments', () => {
    const current = [comment('old-deleted', '1'), comment('live', '9')];
    expect(replaceWithHistory(current, [comment('h1', '2'), comment('h2', '5')]).map((c) => c.messageId)).toEqual(['h1', 'h2', 'live']);
    expect(replaceWithHistory([comment('same', '5')], [comment('h', '5')]).map((c) => c.messageId)).toEqual(['h']);
    expect(replaceWithHistory([comment('x', '1')], []).map((c) => c.messageId)).toEqual(['x']);
  });
  it('removes comments by id', () => {
    expect(removeComment([comment('a', '1'), comment('b', '2')], 'a').map((c) => c.messageId)).toEqual(['b']);
  });
  it('recognises custom events', () => {
    expect(isChatEventName('slides-updated')).toBe(true);
    expect(isChatEventName('other')).toBe(false);
  });
  it('maps chat errors', () => {
    expect(chatErrorMessage({ errorCode: 429, errorMessage: 'x' })).toBe('連投はできません。しばらく待ってから送信してください');
    expect(chatErrorMessage({ errorCode: 403 })).toBe('コメントを送信する権限がありません');
    expect(chatErrorMessage({ errorCode: 406 })).toBe('NGワードを含むか、送信できない内容です');
    expect(chatErrorMessage({ errorCode: 500, errorMessage: 'boom' })).toBe('送信できませんでした（boom）');
    expect(chatErrorMessage({ errorCode: 500 })).toBe('送信できませんでした');
    expect(chatErrorMessage(new Error('e'))).toBe('e');
    expect(chatErrorMessage(null)).toBe('送信できませんでした');
  });
});

describe('useChatRoom', () => {
  const history = [comment('h1', '2026-10-19T00:00:00.000Z')];
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sdk.FakeChatRoom.instances = [];
    fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/tokens/chat') return new Response(JSON.stringify({ token: 'chat-token', capabilities: ['SEND_MESSAGE'] }));
      return new Response(JSON.stringify(history));
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('does nothing until enabled with a region', () => {
    renderHook(() => useChatRoom({ enabled: false, region: 'ap-northeast-1' }));
    renderHook(() => useChatRoom({ enabled: true, region: undefined }));
    expect(sdk.FakeChatRoom.instances).toHaveLength(0);
  });

  it('connects, fetches a token and history, and receives / deletes messages', async () => {
    const { result } = renderHook(() => useChatRoom({ enabled: true, region: 'ap-northeast-1' }));
    expect(room().config.regionOrUrl).toBe('ap-northeast-1');
    expect(room().connect).toHaveBeenCalledTimes(1);
    act(() => room().emit('connecting'));
    expect(result.current.connection).toBe('connecting');
    await act(async () => { await expect(room().config.tokenProvider()).resolves.toEqual({ token: 'chat-token' }); });
    expect(result.current.capabilities).toEqual(['SEND_MESSAGE']);
    act(() => room().emit('connect'));
    expect(result.current.connection).toBe('connected');
    await waitFor(() => expect(result.current.comments.map((c) => c.messageId)).toEqual(['h1']));
    act(() => room().emit('message', { id: 'm1', content: 'hello', sendTime: new Date('2026-10-19T00:01:00Z'), sender: { userId: 'u1' }, attributes: { displayName: 'A' } }));
    expect(result.current.comments.map((c) => c.messageId)).toEqual(['h1', 'm1']);
    act(() => room().emit('messageDelete', { messageId: 'h1' }));
    expect(result.current.comments.map((c) => c.messageId)).toEqual(['m1']);
    act(() => result.current.remove('m1'));
    expect(result.current.comments).toEqual([]);
  });

  it('sends messages without client attributes (R1-04) and maps errors', async () => {
    const { result } = renderHook(() => useChatRoom({ enabled: true, region: 'r' }));
    await expect(result.current.send('x')).rejects.toThrow('コメントサーバーに接続していません');
    act(() => room().emit('connect'));
    await result.current.send('hello');
    expect(room().sendMessage).toHaveBeenCalledTimes(1);
    const request = room().sendMessage.mock.calls[0]?.[0] as InstanceType<typeof sdk.SendMessageRequest>;
    expect(request).toEqual(new sdk.SendMessageRequest('hello'));
    expect(request.attributes).toBeUndefined();
    room().sendMessage.mockRejectedValueOnce({ errorCode: 429 });
    await expect(result.current.send('again')).rejects.toThrow('連投はできません');
  });

  it('forwards custom events and ignores unknown ones', () => {
    const onEvent = vi.fn();
    renderHook(() => useChatRoom({ enabled: true, region: 'r', onEvent }));
    act(() => room().emit('event', { eventName: 'slides-updated' }));
    act(() => room().emit('event', { eventName: 'unknown' }));
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith('slides-updated');
  });

  it('reconnects with backoff after errors and notifies server disconnects', () => {
    const onServerDisconnect = vi.fn();
    const { result } = renderHook(() => useChatRoom({ enabled: true, region: 'r', onServerDisconnect }));
    act(() => room().emit('disconnect', 'socketError'));
    expect(result.current.connection).toBe('disconnected');
    expect(onServerDisconnect).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(999); });
    expect(room().connect).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(room().connect).toHaveBeenCalledTimes(2);
    act(() => room().emit('disconnect', 'serverDisconnect'));
    expect(onServerDisconnect).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1999); });
    expect(room().connect).toHaveBeenCalledTimes(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(room().connect).toHaveBeenCalledTimes(3);
    act(() => room().emit('connect'));
    act(() => room().emit('disconnect', 'fetchTokenError'));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(room().connect).toHaveBeenCalledTimes(4);
  });

  it('does not reconnect after a client disconnect and cleans up on unmount', () => {
    const { unmount } = renderHook(() => useChatRoom({ enabled: true, region: 'r' }));
    act(() => room().emit('disconnect', 'clientDisconnect'));
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(room().connect).toHaveBeenCalledTimes(1);
    act(() => room().emit('disconnect', 'socketError'));
    unmount();
    expect(room().disconnect).toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(room().connect).toHaveBeenCalledTimes(1);
    expect([...room().listeners.values()].every((set) => set.size === 0)).toBe(true);
  });
});
