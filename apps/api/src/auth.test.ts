import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('aws-jwt-verify', () => ({ CognitoJwtVerifier: { create: () => ({ verify }) } }));
import { authenticate } from './auth';
import { ApiEnvSchema } from './env';

const env = ApiEnvSchema.parse({USER_POOL_ID: 'pool', USER_POOL_CLIENT_ID: 'client', TABLE_NAME: 'table', STAGE_PRODUCTION_ARN: 'prod', STAGE_SLIDE_ARN: 'slide', STAGE_BROADCAST_ARN: 'broadcast', CHAT_ROOM_ARN: 'room', CONTENT_BUCKET: 'content', RECORDING_BUCKET: 'recording', RECORDING_STORAGE_CONFIGURATION_ARN: 'storage', ENCODER_CONFIGURATION_ARN: 'encoder', CLOUDFRONT_KEY_PAIR_ID: 'key', CLOUDFRONT_PRIVATE_KEY_PARAMETER: 'parameter'});

describe('authenticate', () => {
  beforeEach(() => verify.mockReset());
  it('requires a token', async () => await expect(authenticate(undefined, env)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' }));
  it('requires refresh when initial federation has no group', async () => {
    verify.mockResolvedValue({ sub: 'sub', email: 'x@example.test' });
    await expect(authenticate('token', env)).rejects.toMatchObject({ statusCode: 401, code: 'TOKEN_REFRESH_REQUIRED' });
  });
  it('rejects empty, multiple and unknown groups', async () => {
    for (const groups of [[], ['camera', 'audio'], ['invalid']]) {
      verify.mockResolvedValue({ sub: 'sub', 'cognito:groups': groups });
      await expect(authenticate('token', env)).rejects.toMatchObject({ statusCode: 403, code: 'INVALID_ROLE' });
    }
  });
  it('returns the validated Cognito role and subject', async () => {
    verify.mockResolvedValue({ sub: 'sub', email: 'x@example.test', 'cognito:groups': ['camera'], identities: [{ providerName: 'Okta' }] });
    await expect(authenticate('token', env)).resolves.toEqual({ userId: 'sub', role: 'camera', email: 'x@example.test', loginMethod: 'Okta' });
  });
});
