import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { JwtInvalidClaimError, JwtInvalidSignatureAlgorithmError, JwtInvalidSignatureError, JwtParseError, JwtWithoutValidKidError, KidNotFoundInJwksError, WaitPeriodNotYetEndedJwkError } from 'aws-jwt-verify/error';
import { RoleSchema, type Role } from '@delivery/shared';
import { KEYS, type Database, type Entity } from './database';
import { HttpError } from './errors';
import type { Env } from './env';

/** access token から分かる情報だけを持つ。email・ログイン方式は access token に無い（R1-01）。 */
export interface Principal {
  userId: string;
  username: string;
  role: Role;
}

/** ロール変更・無効化・削除でこれ以前に発行された token を拒否する（R1-09）。 */
export const TOKEN_VALID_AFTER_SK = 'AUTH';

function unverifiedIssuer(token: string): unknown {
  const payload = token.split('.')[1];
  if (!payload || payload.length > 16_384) return undefined;
  try { return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iss?: unknown }).iss; }
  catch { return undefined; }
}

type Verifier = { verify: (token: string) => Promise<Record<string, unknown>> };
let verifierCache: { key: string; verifier: Verifier } | undefined;
/** JWKS キャッシュを生かすため、同じ User Pool / Client の Verifier を使い回す（R1-23）。 */
function getVerifier(env: Env): Verifier {
  const key = `${env.USER_POOL_ID}:${env.USER_POOL_CLIENT_ID}`;
  if (verifierCache?.key !== key) {
    const verifier = CognitoJwtVerifier.create({ userPoolId: env.USER_POOL_ID, tokenUse: 'access', clientId: env.USER_POOL_CLIENT_ID });
    verifierCache = { key, verifier: verifier as unknown as Verifier };
  }
  return verifierCache.verifier;
}

export async function authenticate(token: string | undefined, env: Env, db: Database): Promise<Principal> {
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'ログインが必要です');
  const expectedIssuer = `https://cognito-idp.${env.AWS_REGION}.amazonaws.com/${env.USER_POOL_ID}`;
  if (unverifiedIssuer(token) !== expectedIssuer) throw new HttpError(401, 'UNAUTHORIZED', 'アクセストークンが無効か期限切れです');
  let payload: Record<string, unknown>;
  try { payload = await getVerifier(env).verify(token); }
  catch (error) {
    if (error instanceof JwtParseError || error instanceof JwtInvalidSignatureError || error instanceof JwtInvalidSignatureAlgorithmError || error instanceof JwtInvalidClaimError || error instanceof JwtWithoutValidKidError || error instanceof KidNotFoundInJwksError || error instanceof WaitPeriodNotYetEndedJwkError) {
      throw new HttpError(401, 'UNAUTHORIZED', 'アクセストークンが無効か期限切れです');
    }
    throw error;
  }
  const groups = payload['cognito:groups'];
  if (groups === undefined) throw new HttpError(401, 'TOKEN_REFRESH_REQUIRED', '初回ログインの設定後に再ログインしてください');
  if (!Array.isArray(groups) || groups.length !== 1) throw new HttpError(403, 'INVALID_ROLE', 'ユーザーのロール設定が不正です');
  const role = RoleSchema.safeParse(groups[0]);
  if (!role.success) throw new HttpError(403, 'INVALID_ROLE', 'ユーザーのロール設定が不正です');
  const userId = typeof payload.sub === 'string' ? payload.sub : '';
  const username = typeof payload.username === 'string' ? payload.username : '';
  const issuedAt = typeof payload.iat === 'number' ? payload.iat : undefined;
  if (!userId || !username || issuedAt === undefined) throw new HttpError(401, 'UNAUTHORIZED', 'アクセストークンが不正です');
  const revocation = await db.get<Entity & { tokenValidAfter?: number }>(KEYS.user(userId), TOKEN_VALID_AFTER_SK, true);
  if (revocation?.tokenValidAfter !== undefined && issuedAt <= revocation.tokenValidAfter) {
    throw new HttpError(401, 'TOKEN_REFRESH_REQUIRED', 'アカウント設定が変更されました。再ログインしてください');
  }
  return { userId, username, role: role.data };
}
