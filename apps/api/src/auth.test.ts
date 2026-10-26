import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { JwtParseError, KidNotFoundInJwksError, WaitPeriodNotYetEndedJwkError } from 'aws-jwt-verify/error';

const { verify, create } = vi.hoisted(() => {
  const verify = vi.fn();
  return { verify, create: vi.fn(() => ({ verify })) };
});
vi.mock('aws-jwt-verify', () => ({ CognitoJwtVerifier: { create } }));
import { authenticate } from './auth';
import { createClients } from './aws';
import { makeDatabase } from './database';
import { ApiEnvSchema } from './env';

const env = ApiEnvSchema.parse({USER_POOL_ID: 'pool', USER_POOL_CLIENT_ID: 'client', TABLE_NAME: 'table', STAGE_PRODUCTION_ARN: 'prod', STAGE_SLIDE_ARN: 'slide', STAGE_BROADCAST_ARN: 'broadcast', CHAT_ROOM_NAME: 'room-name', CONTENT_BUCKET: 'content', RECORDING_BUCKET: 'recording', RECORDING_STORAGE_CONFIGURATION_NAME: 'storage-name', ENCODER_CONFIGURATION_ARN: 'encoder', CLOUDFRONT_KEY_PAIR_ID: 'key', CLOUDFRONT_PRIVATE_KEY_PARAMETER: 'parameter'});
const clients = createClients(env);
const ddb = mockClient(clients.ddb);
const db = makeDatabase(clients.ddb, env);

/** Cognito access token の実際のクレーム（email・identities は含まれない）。 */
const accessToken = (overrides: Record<string, unknown> = {}) => ({
  sub: 'sub-1', 'cognito:groups': ['camera'], iss: 'https://cognito-idp.ap-northeast-1.amazonaws.com/pool', client_id: 'client',
  origin_jti: 'origin', event_id: 'event', token_use: 'access', scope: 'openid email', auth_time: 1_700_000_000,
  exp: 1_700_003_600, iat: 1_700_000_100, jti: 'jti', username: 'okta_user-1', ...overrides,
});
const validIssuer = 'https://cognito-idp.ap-northeast-1.amazonaws.com/pool';
const tokenWithIssuer = (issuer: unknown) => `header.${Buffer.from(JSON.stringify({ iss: issuer })).toString('base64url')}.signature`;
const tokenWithPayload = (payload: string) => `header.${Buffer.from(payload).toString('base64url')}.signature`;
const validToken = tokenWithIssuer(validIssuer);

describe('authenticate', () => {
  beforeEach(() => { verify.mockReset(); ddb.reset(); ddb.on(GetCommand).resolves({}); });
  it('requires a token', async () => await expect(authenticate(undefined, env, db)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED', message: 'ログインが必要です' }));
  it('maps invalid JWT failures to 401', async () => {
    verify.mockRejectedValue(new JwtParseError('invalid token'));
    await expect(authenticate(validToken, env, db)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
  });
  it.each([
    ['missing issuer', undefined],
    ['issuer from another user pool', 'https://cognito-idp.ap-northeast-1.amazonaws.com/other-pool'],
  ])('rejects JWTs with a %s as unauthorized before verifier issuer lookup', async (_label, issuer) => {
    await expect(authenticate(tokenWithIssuer(issuer), env, db)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED', message: 'アクセストークンが無効か期限切れです' });
    expect(verify).not.toHaveBeenCalled();
  });
  it('rejects malformed JWT payloads without calling the verifier', async () => {
    await expect(authenticate('header.bm90LWpzb24.signature', env, db)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    expect(verify).not.toHaveBeenCalled();
  });
  it('accepts a valid issuer at the maximum inspected payload size', async () => {
    verify.mockResolvedValue(accessToken());
    const payload = JSON.stringify({ iss: validIssuer });
    const paddedPayload = `${payload}${' '.repeat(12_288 - Buffer.byteLength(payload))}`;
    expect(Buffer.from(paddedPayload).toString('base64url')).toHaveLength(16_384);
    await expect(authenticate(tokenWithPayload(paddedPayload), env, db)).resolves.toMatchObject({ userId: 'sub-1' });
  });
  it('keeps repeated unknown key IDs classified as invalid tokens during the JWKS backoff window', async () => {
    verify.mockRejectedValueOnce(new KidNotFoundInJwksError('unknown kid'));
    await expect(authenticate(validToken, env, db)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    verify.mockRejectedValueOnce(new WaitPeriodNotYetEndedJwkError('retry later'));
    await expect(authenticate(validToken, env, db)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
  });
  it('lets verifier infrastructure errors reach the API error handler', async () => {
    verify.mockRejectedValue(new Error('JWKS endpoint unavailable'));
    await expect(authenticate(validToken, env, db)).rejects.toThrow('JWKS endpoint unavailable');
  });
  it('requires refresh when initial federation has no group', async () => {
    verify.mockResolvedValue(accessToken({ 'cognito:groups': undefined }));
    await expect(authenticate(validToken, env, db)).rejects.toMatchObject({ statusCode: 401, code: 'TOKEN_REFRESH_REQUIRED' });
  });
  it('rejects empty, multiple and unknown groups', async () => {
    for (const groups of [[], ['camera', 'audio'], ['invalid']]) {
      verify.mockResolvedValue(accessToken({ 'cognito:groups': groups }));
      await expect(authenticate(validToken, env, db)).rejects.toMatchObject({ statusCode: 403, code: 'INVALID_ROLE' });
    }
  });
  it('rejects non-array and non-string group claims instead of inferring viewer', async () => {
    for (const groups of [null, 'viewer', [null], [1], {}]) {
      verify.mockResolvedValue(accessToken({ 'cognito:groups': groups }));
      await expect(authenticate(validToken, env, db)).rejects.toMatchObject({ statusCode: 403, code: 'INVALID_ROLE' });
    }
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });
  it('returns the role, subject and username from real access token claims (R1-01/R1-12)', async () => {
    verify.mockResolvedValue(accessToken());
    await expect(authenticate(validToken, env, db)).resolves.toEqual({ userId: 'sub-1', username: 'okta_user-1', role: 'camera' });
  });
  it('rejects tokens without a username or iat claim', async () => {
    verify.mockResolvedValue(accessToken({ username: undefined }));
    await expect(authenticate(validToken, env, db)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    verify.mockResolvedValue(accessToken({ iat: undefined }));
    await expect(authenticate(validToken, env, db)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
  });
  it.each([
    { name: 'older than', iat: 1_700_000_099, rejected: true },
    { name: 'equal to', iat: 1_700_000_100, rejected: true },
    { name: 'newer than', iat: 1_700_000_101, rejected: false },
  ])('treats a token issued $name tokenValidAfter accordingly (R1-09)', async ({ iat, rejected }) => {
    verify.mockResolvedValue(accessToken({ iat }));
    ddb.on(GetCommand, { TableName: 'table', Key: { PK: 'USER#sub-1', SK: 'AUTH' }, ConsistentRead: true }).resolves({ Item: { PK: 'USER#sub-1', SK: 'AUTH', tokenValidAfter: 1_700_000_100 } });
    const result = authenticate(validToken, env, db);
    if (rejected) await expect(result).rejects.toMatchObject({ statusCode: 401, code: 'TOKEN_REFRESH_REQUIRED' });
    else await expect(result).resolves.toMatchObject({ userId: 'sub-1' });
  });
  it('reuses one verifier so the JWKS cache survives across requests (R1-23)', async () => {
    verify.mockResolvedValue(accessToken());
    await authenticate(validToken, env, db);
    await authenticate(validToken, env, db);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not hide database errors while checking token revocation state', async () => {
    verify.mockResolvedValue(accessToken());
    ddb.on(GetCommand).rejects(new Error('DynamoDB unavailable'));
    await expect(authenticate(validToken, env, db)).rejects.toThrow('DynamoDB unavailable');
    expect(ddb.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({ Key: { PK: 'USER#sub-1', SK: 'AUTH' }, ConsistentRead: true });
  });
});
