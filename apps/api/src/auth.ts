import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { RoleSchema, type Role } from '@delivery/shared';
import { HttpError } from './errors';
import type { Env } from './env';

export interface Principal {
  userId: string;
  role: Role;
  email: string;
  loginMethod: string;
}

export async function authenticate(token: string | undefined, env: Env): Promise<Principal> {
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'ログインが必要です');
  try {
    const verifier = CognitoJwtVerifier.create({ userPoolId: env.USER_POOL_ID, tokenUse: 'access', clientId: env.USER_POOL_CLIENT_ID });
    const payload = await verifier.verify(token);
    const groups = payload['cognito:groups'];
    if (groups === undefined) throw new HttpError(401, 'TOKEN_REFRESH_REQUIRED', '初回ログインの設定後に再ログインしてください');
    if (!Array.isArray(groups) || groups.length !== 1) throw new HttpError(403, 'INVALID_ROLE', 'ユーザーのロール設定が不正です');
    const role = RoleSchema.safeParse(groups[0]);
    if (!role.success) throw new HttpError(403, 'INVALID_ROLE', 'ユーザーのロール設定が不正です');
    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!userId) throw new HttpError(401, 'UNAUTHORIZED', 'アクセストークンが不正です');
    const email = typeof payload.email === 'string' ? payload.email : '';
    const identities = payload.identities;
    const loginMethod = Array.isArray(identities) && identities.length > 0 ? 'Okta' : 'email';
    return { userId, role: role.data, email, loginMethod };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'UNAUTHORIZED', 'アクセストークンが無効か期限切れです');
  }
}
