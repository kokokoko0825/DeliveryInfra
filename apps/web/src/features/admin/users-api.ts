import { EmptyResponseSchema, UserInviteResponseSchema, UserUpdateResponseSchema, UsersResponseSchema, type Role, type UserInviteResponse } from '@delivery/shared';
import { apiFetch } from '@/lib/api';
import { chunk } from '@/lib/validation';

export const INVITE_BATCH = 100;
const userPath = (userId: string) => `/users/${encodeURIComponent(userId)}`;

export const fetchUsers = () => apiFetch('/users', { schema: UsersResponseSchema });

/**
 * 招待 API は 1 回 100 件までなので分割して順に送り、部分成功（invited / failed）をまとめる（Review-1 R1-11）。
 * 途中のバッチが丸ごと失敗したらその分を failed に入れて続ける。全バッチが失敗したときだけ例外を投げる。
 */
export async function inviteUsers(emails: readonly string[], role: Role): Promise<UserInviteResponse> {
  const result: UserInviteResponse = { invited: [], failed: [] };
  let answered = false;
  let lastError: unknown = null;
  for (const batch of chunk(emails, INVITE_BATCH)) {
    try {
      const response = await apiFetch('/users/invite', { method: 'POST', body: { emails: batch, role }, schema: UserInviteResponseSchema });
      result.invited.push(...response.invited);
      result.failed.push(...response.failed);
      answered = true;
    } catch (error) {
      lastError = error;
      result.failed.push(...batch.map((email) => ({ email, reason: 'FAILED' as const })));
    }
  }
  // 1回も応答が無ければエラー内容をそのまま見せる
  if (!answered && lastError !== null) throw lastError;
  return result;
}

export const changeRole = (userId: string, role: Role) =>
  apiFetch(`${userPath(userId)}/role`, { method: 'PUT', body: { role }, schema: UserUpdateResponseSchema });
export const setUserEnabled = (userId: string, enabled: boolean) =>
  apiFetch(`${userPath(userId)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST', schema: EmptyResponseSchema });
export const deleteUser = (userId: string) => apiFetch(userPath(userId), { method: 'DELETE', schema: EmptyResponseSchema });
