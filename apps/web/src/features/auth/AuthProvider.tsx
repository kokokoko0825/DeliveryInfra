import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Hub } from 'aws-amplify/utils';
import { MeResponseSchema, type MeResponse } from '@delivery/shared';
import { ApiError, apiFetch, errorMessage, setTokenProvider, setUnauthorizedHandler } from '@/lib/api';
import { configureAuth, getAccessToken, logout as amplifyLogout } from '@/lib/auth';
import { loadRuntimeConfig, type RuntimeConfig } from '@/lib/config';
import { resetFileCookies } from '@/lib/files';
import { AuthContext, type AuthContextValue, type AuthStatus } from './auth-context';

export const fetchMe = () => apiFetch('/me', { schema: MeResponseSchema });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [me, setMeState] = useState<MeResponse | null>(null);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signOutLocally = useCallback(() => {
    setMeState(null);
    setStatus('signedOut');
    resetFileCookies();
  }, []);

  const refresh = useCallback(async (): Promise<MeResponse | null> => {
    const token = await getAccessToken();
    if (!token) { signOutLocally(); return null; }
    try {
      const profile = await fetchMe();
      setMeState(profile);
      setStatus('signedIn');
      return profile;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { signOutLocally(); return null; }
      setError(errorMessage(cause));
      setStatus('error');
      return null;
    }
  }, [signOutLocally]);

  useEffect(() => {
    let active = true;
    setTokenProvider(getAccessToken);
    setUnauthorizedHandler(signOutLocally);
    loadRuntimeConfig()
      .then((loaded) => {
        if (!active) return;
        configureAuth(loaded);
        setConfig(loaded);
        void refresh();
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(errorMessage(cause));
        setStatus('error');
      });
    const stopListening = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signInWithRedirect') void refresh();
      if (payload.event === 'tokenRefresh_failure' || payload.event === 'signedOut') signOutLocally();
    });
    return () => {
      active = false;
      stopListening();
      setTokenProvider(undefined);
      setUnauthorizedHandler(undefined);
    };
  }, [refresh, signOutLocally]);

  const logout = useCallback(async () => {
    try { await amplifyLogout(); } finally { signOutLocally(); }
  }, [signOutLocally]);

  const value = useMemo<AuthContextValue>(() => ({
    status, me, config, error, refresh, logout,
    setMe: (profile) => { setMeState(profile); setStatus('signedIn'); },
  }), [status, me, config, error, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
