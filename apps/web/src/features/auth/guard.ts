import { canAccess, getPostLoginPath, type Feature, type MeResponse } from '@delivery/shared';
import type { AuthStatus } from './auth-context';

export type GuardResult =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'redirect'; to: string }
  | { kind: 'forbidden'; home: string }
  | { kind: 'allow' };

export type GuardInput = {
  status: AuthStatus;
  me: MeResponse | null;
  feature?: Feature | undefined;
  /** 表示名入力画面自体は表示名未設定でも開ける */
  requireDisplayName?: boolean | undefined;
};

/** ルートガード: 未ログイン→/login、表示名未設定→/display-name、ロール不許可→案内。 */
export function resolveGuard({ status, me, feature, requireDisplayName = true }: GuardInput): GuardResult {
  if (status === 'loading') return { kind: 'loading' };
  if (status === 'error') return { kind: 'error' };
  if (status === 'signedOut' || !me) return { kind: 'redirect', to: '/login' };
  if (requireDisplayName && !me.displayName) return { kind: 'redirect', to: '/display-name' };
  if (feature && !canAccess(me.role, feature)) return { kind: 'forbidden', home: getPostLoginPath(me.role) };
  return { kind: 'allow' };
}
