import { EmptyResponseSchema, UserInviteResponseSchema, UserUpdateResponseSchema, UsersResponseSchema, type Role } from '@delivery/shared';
import { apiFetch } from '@/lib/api';
import { chunk } from '@/lib/validation';

export const INVITE_BATCH = 100;
const userPath = (userId: string) => `/users/${encodeURIComponent(userId)}`;

export const fetchUsers = () => apiFetch('/users', { schema: UsersResponseSchema });

/** 招待 API は 1 回 100 件までなので分割して順に送る。 */
export async function inviteUsers(emails: readonly string[], role: Role): Promise<string[]> {
  const invited: string[] = [];
  for (const batch of chunk(emails, INVITE_BATCH)) {
    const response = await apiFetch('/users/invite', { method: 'POST', body: { emails: batch, role }, schema: UserInviteResponseSchema });
    invited.push(...response.invited);
  }
  return invited;
}

export const changeRole = (userId: string, role: Role) =>
  apiFetch(`${userPath(userId)}/role`, { method: 'PUT', body: { role }, schema: UserUpdateResponseSchema });
export const setUserEnabled = (userId: string, enabled: boolean) =>
  apiFetch(`${userPath(userId)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST', schema: EmptyResponseSchema });
export const deleteUser = (userId: string) => apiFetch(userPath(userId), { method: 'DELETE', schema: EmptyResponseSchema });
