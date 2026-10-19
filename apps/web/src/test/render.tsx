import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import type { MeResponse } from '@delivery/shared';
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context';
import { ChatContext } from '@/features/viewer/chat-context';
import type { ChatRoomState } from '@/lib/chat';

export const makeMe = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  userId: 'u1', email: 'user@example.com', role: 'viewer', loginMethod: 'email', displayName: 'たなか', commentSuspended: false, ...overrides,
});

export const makeAuth = (overrides: Partial<AuthContextValue> = {}): AuthContextValue => ({
  status: 'signedIn', me: makeMe(), config: { region: 'ap-northeast-1', userPoolId: 'pool', userPoolClientId: 'client' }, error: null, loginError: null,
  refresh: vi.fn(async () => makeMe()), setMe: vi.fn(), logout: vi.fn(async () => undefined), ...overrides,
});

export const makeChat = (overrides: Partial<ChatRoomState> = {}): ChatRoomState => ({
  comments: [], connection: 'connected', capabilities: ['SEND_MESSAGE'], send: vi.fn(async () => undefined), remove: vi.fn(), ...overrides,
});

type Options = { auth?: AuthContextValue; chat?: ChatRoomState; path?: string | { pathname: string; state?: unknown }; route?: string; extraRoutes?: ReactNode };

/** 画面テスト用: Auth/Chat コンテキスト、QueryClient、ルーターを用意して描画する。 */
export function renderPage(ui: ReactElement, { auth = makeAuth(), chat = makeChat(), path = '/', route = '*', extraRoutes }: Options = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <ChatContext.Provider value={chat}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={route} element={ui} />
              {extraRoutes}
            </Routes>
          </MemoryRouter>
        </ChatContext.Provider>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

type Handler = (init: RequestInit & { url: string }) => unknown;

/** fetch のモック。`METHOD /api/path` をキーに JSON 応答を返す。Response を返せばそのまま使う。 */
export function mockApi(routes: Record<string, unknown | Handler>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url}`;
    if (!(key in routes)) return new Response(JSON.stringify({ error: { code: 'NOT_MOCKED', message: key } }), { status: 500 });
    const route = routes[key];
    const value = typeof route === 'function' ? (route as Handler)({ ...init, url }) : route;
    if (value instanceof Response) return value;
    return new Response(value === undefined ? '' : JSON.stringify(value), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const apiError = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), { status });

export const callsTo = (fetchMock: ReturnType<typeof mockApi>, key: string) =>
  fetchMock.mock.calls.filter(([input, init]) => `${((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase()} ${String(input)}` === key);

export const bodyOf = (call: unknown[] | undefined) => JSON.parse(String((call?.[1] as RequestInit).body));
