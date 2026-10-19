import { createContext, useContext } from 'react';
import type { MeResponse } from '@delivery/shared';
import type { RuntimeConfig } from '@/lib/config';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'error';

export type AuthContextValue = {
  status: AuthStatus;
  me: MeResponse | null;
  config: RuntimeConfig | null;
  error: string | null;
  /** ログイン直後・表示名変更後などにプロフィールを再取得する */
  refresh: () => Promise<MeResponse | null>;
  setMe: (me: MeResponse) => void;
  logout: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider の内側で使用してください');
  return value;
}
