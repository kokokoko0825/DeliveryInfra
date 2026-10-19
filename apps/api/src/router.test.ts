import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { CreateParticipantTokenCommand } from '@aws-sdk/client-ivs-realtime';
vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: vi.fn(async () => ({ url: 'https://upload.example.test', fields: { key: 'slide.pdf' } })) }));
import { createClients } from './aws';
import { ApiEnvSchema } from './env';
import { createApiHandler, type FunctionUrlEvent } from './router';
import { HttpError } from './errors';

const env = ApiEnvSchema.parse({ USER_POOL_ID: 'pool', USER_POOL_CLIENT_ID: 'client', TABLE_NAME: 'table', STAGE_PRODUCTION_ARN: 'prod', STAGE_SLIDE_ARN: 'slide', STAGE_BROADCAST_ARN: 'broadcast', CHAT_ROOM_ARN: 'room', CONTENT_BUCKET: 'content', RECORDING_BUCKET: 'recording', RECORDING_STORAGE_CONFIGURATION_ARN: 'storage', ENCODER_CONFIGURATION_ARN: 'encoder', CLOUDFRONT_KEY_PAIR_ID: 'key', CLOUDFRONT_PRIVATE_KEY_PARAMETER: 'parameter' });
const clients = createClients(env);
const ddb = mockClient(clients.ddb);
const ivs = mockClient(clients.ivs);
const chat = mockClient(clients.chat);
const s3 = mockClient(clients.s3);
const cognito = mockClient(clients.cognito);
const ssm = mockClient(clients.ssm);

const makeEvent = (method: string, path: string, body?: unknown): FunctionUrlEvent => ({
  rawPath: `/api${path}`, headers: { 'X-Auth-Token': 'access-token', 'x-forwarded-host': 'example.cloudfront.net' },
  requestContext: { http: { method, path: `/api${path}` } },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const request = (role: 'admin' | 'camera' | 'audio' | 'presenter' | 'viewer', method: string, path: string, body?: unknown) =>
  createApiHandler({ env, clients, authenticate: vi.fn().mockResolvedValue({ userId: 'user-1', email: 'user@example.test', role, loginMethod: 'email' }), now: () => 1_700_000_000_000 })(makeEvent(method, path, body));
const conditionalError = () => Object.assign(new Error('slot busy'), { name: 'ConditionalCheckFailedException' });

beforeEach(() => {
  ddb.reset(); ivs.reset(); chat.reset(); s3.reset(); cognito.reset(); ssm.reset();
  ddb.on(ScanCommand).resolves({ Items: [] });
  ddb.on(PutCommand).resolves({});
  ivs.on(CreateParticipantTokenCommand).resolves({ participantToken: { participantId: 'participant', token: 'signed-token', expirationTime: new Date('2026-01-01T00:00:00.000Z'), capabilities: ['PUBLISH'] } });
});

describe('API router', () => {
  it('rejects unauthenticated calls before routing', async () => {
    const handler = createApiHandler({ env, clients, authenticate: vi.fn().mockRejectedValue(new HttpError(401, 'UNAUTHORIZED', 'login')) });
    await expect(handler(makeEvent('GET', '/me'))).resolves.toMatchObject({ statusCode: 401 });
  });
  it('returns 404 for unknown routes and requires administrator roles', async () => {
    await expect(request('viewer', 'GET', '/users')).resolves.toMatchObject({ statusCode: 403, body: expect.stringContaining('FORBIDDEN') });
    await expect(request('admin', 'GET', '/missing')).resolves.toMatchObject({ statusCode: 404 });
  });
  it.each([
    { name: '0 chars', displayName: '', statusCode: 400 },
    { name: '1 char', displayName: 'a', statusCode: 200 },
    { name: '20 chars', displayName: 'x'.repeat(20), statusCode: 200 },
    { name: '21 chars', displayName: 'x'.repeat(21), statusCode: 400 },
  ])('validates display name boundary $name', async ({ displayName, statusCode }) => {
    await expect(request('viewer', 'PUT', '/me/display-name', { displayName })).resolves.toMatchObject({ statusCode });
  });
  it('validates slide extension, MIME and 50 MB boundary before generating uploads', async () => {
    const base = { title: '資料', fileName: 'slide.pdf', contentType: 'application/pdf' };
    await expect(request('admin', 'POST', '/slides/upload-url', { ...base, size: 52_428_800 })).resolves.toMatchObject({ statusCode: 200 });
    await expect(request('admin', 'POST', '/slides/upload-url', { ...base, fileName: 'slide.txt', size: 10 })).resolves.toMatchObject({ statusCode: 400 });
    await expect(request('admin', 'POST', '/slides/upload-url', { ...base, contentType: 'text/plain', size: 10 })).resolves.toMatchObject({ statusCode: 400 });
    await expect(request('admin', 'POST', '/slides/upload-url', { ...base, size: 52_428_801 })).resolves.toMatchObject({ statusCode: 400 });
  });
  it('rejects a role that cannot request a camera stage token', async () => {
    await expect(request('viewer', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM1' })).resolves.toMatchObject({ statusCode: 403 });
    expect(ivs.commandCalls(CreateParticipantTokenCommand)).toHaveLength(0);
  });
  it.each([
    { role: 'camera', purpose: 'camera', limit: 6 },
    { role: 'audio', purpose: 'mic', limit: 5 },
    { role: 'presenter', purpose: 'slide', limit: 1 },
    { role: 'admin', purpose: 'switcher', limit: 1 },
  ] as const)('enforces the concurrent $purpose slot cap of $limit', async ({ role, purpose, limit }) => {
    const occupied = new Set<string>();
    ddb.on(PutCommand).callsFake(async (input) => {
      const key = String(input.Item?.PK);
      if (occupied.has(key)) throw conditionalError();
      occupied.add(key);
      return {};
    });
    for (let index = 0; index < limit; index += 1) {
      await expect(request(role, 'POST', '/tokens/stage', { purpose, deviceName: `${purpose}-${index + 1}` })).resolves.toMatchObject({ statusCode: 200 });
    }
    await expect(request(role, 'POST', '/tokens/stage', { purpose, deviceName: 'overflow' })).resolves.toMatchObject({ statusCode: 409, body: expect.stringContaining('DEVICE_LIMIT') });
    expect(occupied.size).toBe(limit);
  });
  it('issues viewer tokens without consuming a sending slot', async () => {
    await expect(request('viewer', 'POST', '/tokens/stage', { purpose: 'viewer' })).resolves.toMatchObject({ statusCode: 200, body: expect.stringContaining('signed-token') });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});
