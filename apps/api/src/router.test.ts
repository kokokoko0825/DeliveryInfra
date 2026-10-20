import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CreateParticipantTokenCommand, DisconnectParticipantCommand, GetStageCommand, ListParticipantsCommand, ListStageSessionsCommand, ListStorageConfigurationsCommand, StartCompositionCommand, StopCompositionCommand } from '@aws-sdk/client-ivs-realtime';
import { CreateChatTokenCommand, DeleteMessageCommand, DisconnectUserCommand, GetRoomCommand, ListRoomsCommand, SendEventCommand } from '@aws-sdk/client-ivschat';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand, AdminEnableUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand, AdminUserGlobalSignOutCommand, ListUsersCommand, ListUsersInGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: vi.fn(async () => ({ url: 'https://upload.example.test', fields: { key: 'slide.pdf' } })) }));
vi.mock('@aws-sdk/cloudfront-signer', () => ({ getSignedCookies: vi.fn(() => ({ 'CloudFront-Policy': 'policy', 'CloudFront-Signature': 'signature', 'CloudFront-Key-Pair-Id': 'pair' })) }));
import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import { ArchivesResponseSchema, MeResponseSchema, UserInviteResponseSchema, UsersResponseSchema } from '@delivery/shared';
import { createClients } from './aws';
import { ApiEnvSchema } from './env';
import { createApiHandler, type FunctionUrlEvent } from './router';
import { HttpError } from './errors';
import { resetResourceArnCache } from './resources';

const env = ApiEnvSchema.parse({ USER_POOL_ID: 'pool', USER_POOL_CLIENT_ID: 'client', TABLE_NAME: 'table', STAGE_PRODUCTION_ARN: 'prod', STAGE_SLIDE_ARN: 'slide', STAGE_BROADCAST_ARN: 'broadcast', CHAT_ROOM_NAME: 'room-name', CONTENT_BUCKET: 'content', RECORDING_BUCKET: 'recording', RECORDING_STORAGE_CONFIGURATION_NAME: 'storage-name', ENCODER_CONFIGURATION_ARN: 'encoder', CLOUDFRONT_KEY_PAIR_ID: 'key', CLOUDFRONT_PRIVATE_KEY_PARAMETER: 'parameter' });
const clients = createClients(env);
const ddb = mockClient(clients.ddb);
const ivs = mockClient(clients.ivs);
const chat = mockClient(clients.chat);
const s3 = mockClient(clients.s3);
const cognito = mockClient(clients.cognito);
const ssm = mockClient(clients.ssm);
const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;
const UUID = '0b6c2a52-1111-4222-8333-444455556666';

type RoleName = 'admin' | 'camera' | 'audio' | 'presenter' | 'viewer';
const makeEvent = (method: string, path: string, body?: unknown, rawQueryString?: string): FunctionUrlEvent => ({
  rawPath: `/api${path}`, ...(rawQueryString === undefined ? {} : { rawQueryString }), headers: { 'X-Auth-Token': 'access-token', 'x-forwarded-host': 'example.cloudfront.net' },
  requestContext: { http: { method, path: `/api${path}` } },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const request = (role: RoleName, method: string, path: string, body?: unknown, userId = 'user-1', rawQueryString?: string) =>
  createApiHandler({ env, clients, authenticate: vi.fn().mockResolvedValue({ userId, username: `${userId}-name`, role }), now: () => NOW_MS })(makeEvent(method, path, body, rawQueryString));
const awsError = (name: string) => Object.assign(new Error(name), { name });
const conditionalError = () => awsError('ConditionalCheckFailedException');
interface Payload { error?: { code: string; message: string }; [key: string]: unknown }
const data = (response: { body: string }): Payload => JSON.parse(response.body) as Payload;
const lease = (sk: string, extra: Record<string, unknown> = {}) => ({ PK: 'DEVICE', SK: sk, deviceId: `${sk.replace('#', '.')}.${UUID}`, deviceName: 'CAM1', purpose: sk.split('#')[0], userId: 'user-1', ttl: NOW_S + 10, ...extra });

beforeEach(() => {
  ddb.reset(); ivs.reset(); chat.reset(); s3.reset(); cognito.reset(); ssm.reset();
  resetResourceArnCache();
  chat.on(ListRoomsCommand).resolves({ rooms: [{ name: 'room-name', arn: 'room' }] });
  ivs.on(ListStorageConfigurationsCommand).resolves({ storageConfigurations: [{ name: 'storage-name', arn: 'storage' }] });
  vi.mocked(getSignedCookies).mockClear();
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(GetCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
  ddb.on(DeleteCommand).resolves({});
  ddb.on(PutCommand).resolves({});
  ddb.on(BatchGetCommand).resolves({ Responses: { table: [] } });
  ivs.on(StartCompositionCommand).resolves({ composition: { arn: 'composition-arn', stageArn: 'broadcast', state: 'ACTIVE', layout: {}, destinations: [{ id: 'destination-id', state: 'ACTIVE', configuration: {}, detail: { s3: { recordingPrefix: 'stage/session/destination/composite' } } } as never] } });
  ivs.on(GetStageCommand).resolves({ stage: { arn: 'broadcast', activeSessionId: 'session-1' } });
  ivs.on(ListParticipantsCommand).resolves({ participants: [] });
  ivs.on(ListStageSessionsCommand).resolves({ stageSessions: [] });
  ivs.on(StopCompositionCommand).resolves({});
  ivs.on(DisconnectParticipantCommand).resolves({});
  chat.on(SendEventCommand).resolves({});
  chat.on(CreateChatTokenCommand).resolves({ token: 'chat-token' });
  chat.on(GetRoomCommand).resolves({ arn: 'room' });
  chat.on(DeleteMessageCommand).resolves({});
  chat.on(DisconnectUserCommand).resolves({});
  s3.on(HeadObjectCommand).resolves({ ContentLength: 100, ContentType: 'application/pdf' });
  s3.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => Buffer.from('%PDF-') } as never });
  s3.on(ListObjectsV2Command).resolves({ Contents: [] });
  s3.on(DeleteObjectsCommand).resolves({});
  ssm.on(GetParameterCommand).resolves({ Parameter: { Type: 'SecureString', Value: 'private-key' } });
  cognito.on(AdminCreateUserCommand).resolves({ User: { Username: 'new-user' } });
  cognito.on(AdminAddUserToGroupCommand).resolves({});
  cognito.on(AdminGetUserCommand).resolves({ Username: 'user-1-name', UserAttributes: [{ Name: 'email', Value: 'user@example.test' }] });
  cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
  cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
  cognito.on(AdminDisableUserCommand).resolves({});
  cognito.on(AdminEnableUserCommand).resolves({});
  cognito.on(AdminUserGlobalSignOutCommand).resolves({});
  cognito.on(AdminDeleteUserCommand).resolves({});
  cognito.on(ListUsersCommand).resolves({ Users: [] });
  cognito.on(ListUsersInGroupCommand).resolves({ Users: [] });
  ivs.on(CreateParticipantTokenCommand).resolves({ participantToken: { participantId: 'participant', token: 'signed-token', expirationTime: new Date('2026-01-01T00:00:00.000Z'), capabilities: ['PUBLISH'] } });
});
// R1-10: どの経路もテーブル全体の Scan をしない
afterEach(() => {
  vi.useRealTimers();
  expect(ddb.commandCalls(ScanCommand)).toHaveLength(0);
});

describe('API router', () => {
  it.each([
    ['POST', '/me'], ['GET', '/me/display-name'], ['PUT', '/broadcast'],
    ['GET', '/broadcast/start'], ['GET', '/broadcast/stop'], ['POST', '/broadcast/stats'], ['POST', '/status'],
    ['GET', '/tokens/stage'], ['POST', '/devices'], ['POST', '/devices/names'],
    ['GET', `/devices/camera.1.${UUID}/heartbeat`], ['POST', `/devices/camera.1.${UUID}`],
    ['GET', '/tokens/chat'], ['POST', '/comments/recent'], ['GET', '/comments/m-1'],
    ['GET', '/users/u-2/comment-suspension'], ['POST', '/comments/export'],
    ['PUT', '/ng-words'], ['POST', '/ng-words/blocked'], ['POST', '/slides'],
    ['GET', '/slides/upload-url'], ['GET', '/slides/s-1/complete'], ['POST', '/slides/order'],
    ['POST', '/slides/s-1'], ['POST', '/archives'], ['GET', '/archives/a-1/cookies'],
    ['GET', '/archives/a-1'], ['GET', '/files/cookies'], ['POST', '/users'],
    ['GET', '/users/invite'], ['GET', '/users/u-2/resend-invite'], ['POST', '/users/u-2/role'],
    ['GET', '/users/u-2/disable'], ['GET', '/users/u-2/enable'], ['POST', '/users/u-2'],
  ] as const)('returns exact 404 for unsupported method %s %s', async (method, path) => {
    const response = await request('admin', method, path);
    expect(response.statusCode).toBe(404);
    expect(data(response)).toEqual({ error: { code: 'NOT_FOUND', message: '対象が見つかりません' } });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(0);
    expect(ivs.calls()).toHaveLength(0);
    expect(chat.calls()).toHaveLength(0);
    expect(cognito.calls()).toHaveLength(0);
    expect(s3.calls()).toHaveLength(0);
  });
  it('rejects unauthenticated calls before routing', async () => {
    const handler = createApiHandler({ env, clients, authenticate: vi.fn().mockRejectedValue(new HttpError(401, 'UNAUTHORIZED', 'login')) });
    await expect(handler(makeEvent('GET', '/me'))).resolves.toMatchObject({ statusCode: 401 });
  });
  it('returns 404 for unknown routes and requires administrator roles', async () => {
    await expect(request('viewer', 'GET', '/users')).resolves.toMatchObject({ statusCode: 403, body: expect.stringContaining('FORBIDDEN') });
    await expect(request('admin', 'GET', '/missing')).resolves.toMatchObject({ statusCode: 404 });
  });
  it('normalizes auth header names, falls back to the HTTP path, and rejects paths outside the API', async () => {
    const auth = vi.fn().mockRejectedValue(new HttpError(401, 'UNAUTHORIZED', 'login'));
    const handler = createApiHandler({ env, clients, authenticate: auth });
    const fallback = makeEvent('GET', '/me');
    fallback.rawPath = '';
    fallback.requestContext.http.path = '/api/me';
    fallback.headers = { 'x-auth-token': 'lowercase-token' };
    expect((await handler(fallback)).statusCode).toBe(401);
    expect(auth).toHaveBeenCalledWith('lowercase-token', env, expect.anything());
    const outside = await handler({ ...makeEvent('GET', '/me'), rawPath: '/elsewhere', headers: {} });
    expect(outside.statusCode).toBe(404);
    expect(auth).toHaveBeenCalledTimes(1);
  });
  it('returns validation errors for malformed JSON and accepts base64 encoded JSON', async () => {
    const malformed = { ...makeEvent('POST', '/ng-words'), body: '{' };
    const invalid = await createApiHandler({ env, clients, authenticate: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'name', role: 'admin' }), now: () => NOW_MS })(malformed);
    expect(invalid.statusCode).toBe(400);
    expect(data(invalid).error?.code).toBe('VALIDATION_ERROR');
    const encoded = Buffer.from(JSON.stringify({ word: 'blocked' })).toString('base64');
    const event = { ...makeEvent('POST', '/ng-words'), body: encoded, isBase64Encoded: true };
    expect((await createApiHandler({ env, clients, authenticate: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'name', role: 'admin' }), now: () => NOW_MS })(event)).statusCode).toBe(200);
    expect(ddb.commandCalls(PutCommand).at(-1)?.args[0].input.Item).toMatchObject({ PK: 'NGWORD', SK: 'blocked', word: 'blocked' });
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
    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({ PK: 'SLIDE', status: 'pending' });
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
  ] as const)('enforces the concurrent $purpose slot cap of $limit', async ({ role, purpose, limit }) => {
    const occupied = new Set<string>();
    ddb.on(PutCommand).callsFake(async (input) => {
      const key = `${String(input.Item?.PK)}|${String(input.Item?.SK)}`;
      if (occupied.has(key)) throw conditionalError();
      occupied.add(key);
      return {};
    });
    for (let index = 0; index < limit; index += 1) {
      await expect(request(role, 'POST', '/tokens/stage', { purpose, deviceName: `${purpose}-${index + 1}` })).resolves.toMatchObject({ statusCode: 200 });
    }
    await expect(request(role, 'POST', '/tokens/stage', { purpose, deviceName: 'overflow' })).resolves.toMatchObject({ statusCode: 409, body: expect.stringContaining('DEVICE_LIMIT') });
    expect(occupied.size).toBe(limit);
    expect([...occupied].every((key) => key.startsWith(`DEVICE|${purpose}#`))).toBe(true);
  });
  it.each([
    ['missing token', { participantId: 'participant', expirationTime: new Date('2026-01-01T00:00:00Z') }],
    ['missing participant ID', { token: 'signed-token', expirationTime: new Date('2026-01-01T00:00:00Z') }],
    ['missing expiration', { token: 'signed-token', participantId: 'participant' }],
  ] as const)('returns TOKEN_ISSUE_FAILED and releases its reserved slot when IVS returns a token without %s', async (_caseName, participantToken) => {
    ivs.on(CreateParticipantTokenCommand).resolves({ participantToken: participantToken as never });
    const response = await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM1' });
    expect(response.statusCode).toBe(502);
    expect(data(response).error).toEqual({ code: 'TOKEN_ISSUE_FAILED', message: '参加トークンを発行できませんでした' });
    expect(ddb.commandCalls(DeleteCommand).map((call) => call.args[0].input)).toEqual([{
      TableName: 'table', Key: { PK: 'DEVICE', SK: 'camera#1' }, ConditionExpression: 'deviceId = :deviceId',
      ExpressionAttributeValues: { ':deviceId': expect.stringMatching(/^camera\.1\.[0-9a-f-]{36}$/u) },
    }]);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('issues viewer tokens without consuming a sending slot', async () => {
    const response = await request('viewer', 'POST', '/tokens/stage', { purpose: 'viewer' });
    expect(response.statusCode).toBe(200);
    expect(data(response).tokens).toEqual([{ stage: 'broadcast', token: 'signed-token', participantId: 'participant', capabilities: ['PUBLISH'], expiresAt: '2026-01-01T00:00:00.000Z' }]);
    expect(ivs.commandCalls(CreateParticipantTokenCommand).map((call) => call.args[0].input)).toEqual([{
      stageArn: 'broadcast', duration: 10, userId: 'user-1', capabilities: ['SUBSCRIBE'], attributes: undefined,
    }]);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe('stage tokens and device slots', () => {
  it('lets the switcher fetch tokens repeatedly without device slots (R1-02)', async () => {
    for (let index = 0; index < 3; index += 1) {
      const response = await request('admin', 'POST', '/tokens/stage', { purpose: 'switcher' });
      expect(response.statusCode).toBe(200);
      expect(data(response).deviceId).toBeUndefined();
      expect((data(response).tokens as { stage: string }[]).map((token) => token.stage)).toEqual(['production', 'slide', 'broadcast']);
    }
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
    expect(ivs.commandCalls(CreateParticipantTokenCommand).map((call) => call.args[0].input.capabilities)).toEqual(Array.from({ length: 3 }, () => [['SUBSCRIBE'], ['SUBSCRIBE'], ['PUBLISH']]).flat());
    expect(ivs.commandCalls(CreateParticipantTokenCommand)[0]?.args[0].input.attributes).toEqual({ kind: 'switcher', deviceName: 'SWITCHER' });
  });

  it('embeds the slot in the device id and stores the participant id on the lease (R1-07/R1-10)', async () => {
    const response = await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM1' });
    expect(data(response).deviceId).toMatch(/^camera\.1\.[0-9a-f-]{36}$/u);
    expect(data(response).tokens).toEqual([{ stage: 'production', token: 'signed-token', participantId: 'participant', capabilities: ['PUBLISH'], expiresAt: '2026-01-01T00:00:00.000Z' }]);
    const put = ddb.commandCalls(PutCommand)[0]?.args[0].input;
    expect(put).toMatchObject({ Item: { PK: 'DEVICE', SK: 'camera#1', deviceName: 'CAM1', userId: 'user-1', ttl: NOW_S + 45 }, ConditionExpression: 'attribute_not_exists(PK) OR #ttl <= :now', ExpressionAttributeValues: { ':now': NOW_S }, ReturnValues: 'ALL_OLD' });
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({ Key: { PK: 'DEVICE', SK: 'camera#1' }, ExpressionAttributeValues: { ':participantId': 'participant', ':stageArn': 'prod', ':deviceId': data(response).deviceId } });
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({ KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)', ExpressionAttributeValues: { ':pk': 'DEVICE', ':sk': 'camera#' }, ConsistentRead: true });
  });

  it('disconnects the participant of an expired lease before reusing its slot (R1-07)', async () => {
    ddb.on(PutCommand).resolves({ Attributes: lease('camera#1', { participantId: 'stale-participant', stageArn: 'prod', ttl: NOW_S - 1, deviceName: 'CAM3' }) });
    expect((await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM7' })).statusCode).toBe(200);
    expect(ivs.commandCalls(DisconnectParticipantCommand).map((call) => call.args[0].input)).toEqual([{ stageArn: 'prod', participantId: 'stale-participant', reason: '送信枠が失効しました' }]);
  });

  it('treats an already-gone participant as disconnected but rolls back on other disconnect errors (R1-07)', async () => {
    ddb.on(PutCommand).resolves({ Attributes: lease('camera#1', { participantId: 'stale', stageArn: 'prod' }) });
    ivs.on(DisconnectParticipantCommand).rejects(awsError('ResourceNotFoundException'));
    expect((await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM7' })).statusCode).toBe(200);
    ivs.on(DisconnectParticipantCommand).rejects(awsError('AccessDeniedException'));
    const failed = await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM7' });
    expect(failed.statusCode).toBe(500);
    const newDeviceId = ddb.commandCalls(PutCommand)[1]?.args[0].input.Item?.deviceId;
    expect(ddb.commandCalls(PutCommand)[2]?.args[0].input).toMatchObject({ Item: lease('camera#1', { participantId: 'stale', stageArn: 'prod' }), ConditionExpression: 'deviceId = :deviceId', ExpressionAttributeValues: { ':deviceId': newDeviceId } });
    expect(ivs.commandCalls(CreateParticipantTokenCommand)).toHaveLength(1);
  });

  it('keeps the still-connected old lease when its disconnect fails so another device cannot take the slot (R2-01)', async () => {
    // DynamoDB の枠行を条件式どおりに再現する
    const table = new Map<string, Record<string, unknown>>([['camera#1', lease('camera#1', { participantId: 'stale', stageArn: 'prod', ttl: NOW_S - 1, deviceName: 'CAM3', userId: 'other' })]]);
    ddb.on(PutCommand).callsFake(async (input: { Item: Record<string, unknown>; ConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown>; ExpressionAttributeNames?: Record<string, string> }) => {
      const sk = String(input.Item.SK);
      const current = table.get(sk);
      const values = input.ExpressionAttributeValues ?? {};
      const ok = input.ConditionExpression === 'deviceId = :deviceId' ? current?.deviceId === values[':deviceId']
        : input.ConditionExpression === 'deviceId = :previous' ? current?.deviceId === values[':previous']
          : !current || Number(current.ttl) <= Number(values[':now']);
      if (!ok) throw conditionalError();
      table.set(sk, input.Item);
      return { Attributes: current };
    });
    ddb.on(DeleteCommand).callsFake(async (input: { Key: { SK: string }; ExpressionAttributeValues?: Record<string, unknown> }) => {
      if (table.get(input.Key.SK)?.deviceId !== input.ExpressionAttributeValues?.[':deviceId']) throw conditionalError();
      table.delete(input.Key.SK);
      return {};
    });
    ivs.on(DisconnectParticipantCommand).rejects(awsError('ThrottlingException'));
    expect((await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM7' })).statusCode).toBe(500);
    expect(table.get('camera#1')).toMatchObject({ participantId: 'stale', deviceName: 'CAM3', userId: 'other' });
    // 旧枠は ttl 切れのままなので次の端末は再度切断を試み、成功するまで枠を確定できない
    const other = await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM8' }, 'user-2');
    expect(other.statusCode).toBe(500);
    expect(ivs.commandCalls(DisconnectParticipantCommand).map((call) => call.args[0].input.participantId)).toEqual(['stale', 'stale']);
    expect(table.get('camera#1')).toMatchObject({ participantId: 'stale' });
    expect(ivs.commandCalls(CreateParticipantTokenCommand)).toHaveLength(0);
  });

  it('does not overwrite a slot taken by another device while rolling back (R2-01)', async () => {
    ddb.on(PutCommand).resolvesOnce({ Attributes: lease('camera#1', { participantId: 'stale', stageArn: 'prod' }) }).rejects(conditionalError());
    ivs.on(DisconnectParticipantCommand).rejects(awsError('AccessDeniedException'));
    expect((await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM7' })).statusCode).toBe(500);
    expect(ddb.commandCalls(PutCommand)[1]?.args[0].input.ConditionExpression).toBe('deviceId = :deviceId');
  });

  it('rejects an active duplicate device name owned by someone else (R1-18)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [lease('camera#2', { userId: 'other', deviceName: 'CAM1' })] });
    const response = await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM1' });
    expect(response.statusCode).toBe(409);
    expect(data(response).error).toEqual({ code: 'DEVICE_NAME_IN_USE', message: 'この端末名は使用中です' });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('ignores an expired duplicate name and lets the same user take over their own slot only when asked (R1-18, R3-02)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [lease('camera#2', { userId: 'other', deviceName: 'CAM1', ttl: NOW_S })] });
    expect((await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM1' })).statusCode).toBe(200);
    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.Item?.SK).toBe('camera#1');
    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.Item).not.toHaveProperty('replacedDeviceId');

    ddb.on(QueryCommand).resolves({ Items: [lease('camera#2', { deviceName: 'CAM1', participantId: 'old', stageArn: 'prod' })] });
    ddb.on(PutCommand).resolves({ Attributes: lease('camera#2', { deviceName: 'CAM1', participantId: 'old', stageArn: 'prod' }) });
    // 明示しない同名の取得は、本人の別端末を切断せずに拒否する（相互切断ループの防止）
    const implicit = await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM1' });
    expect(implicit.statusCode).toBe(409);
    expect(data(implicit).error).toEqual({ code: 'DEVICE_NAME_IN_USE_SELF', message: 'この端末名はあなたの別の端末で使用中です' });
    expect(ddb.commandCalls(PutCommand)).toHaveLength(1);
    expect(ivs.commandCalls(DisconnectParticipantCommand)).toHaveLength(0);

    expect((await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM1', takeover: true })).statusCode).toBe(200);
    expect(ddb.commandCalls(PutCommand).at(-1)?.args[0].input).toMatchObject({ Item: { SK: 'camera#2', replacedDeviceId: `camera.2.${UUID}` }, ConditionExpression: 'deviceId = :previous', ExpressionAttributeValues: { ':previous': `camera.2.${UUID}` } });
    expect(ivs.commandCalls(DisconnectParticipantCommand).at(-1)?.args[0].input).toEqual({ stageArn: 'prod', participantId: 'old', reason: '同じ端末名の別の端末に引き継がれました' });
  });

  it('still rejects another user\'s name even with takeover (R3-02)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [lease('camera#2', { userId: 'other', deviceName: 'CAM1' })] });
    const response = await request('camera', 'POST', '/tokens/stage', { purpose: 'camera', deviceName: 'CAM1', takeover: true });
    expect(data(response).error?.code).toBe('DEVICE_NAME_IN_USE');
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('tells a replaced device apart from an expired one on heartbeat (R3-02)', async () => {
    const oldId = `camera.1.${UUID}`;
    const newId = `camera.1.${UUID.replace('0b6c', '1111')}`;
    ddb.on(GetCommand, { Key: { PK: 'DEVICE', SK: 'camera#1' } }).resolves({ Item: lease('camera#1', { deviceId: newId, replacedDeviceId: oldId }) });
    const replaced = await request('camera', 'POST', `/devices/${oldId}/heartbeat`);
    expect(replaced.statusCode).toBe(409);
    expect(data(replaced).error).toEqual({ code: 'DEVICE_REPLACED', message: '同じ端末名の別の端末に引き継がれました' });
    expect((await request('camera', 'POST', `/devices/${oldId}/heartbeat`, undefined, 'other')).statusCode).toBe(404);
    // 別の端末 ID の失効（引き継ぎ元が自分でない）は従来どおり 404
    expect((await request('camera', 'POST', `/devices/camera.1.${UUID.replace('0b6c', '2222')}/heartbeat`)).statusCode).toBe(404);
    // 引き継いだ側も失効していれば 404（再接続の対象）
    ddb.on(GetCommand, { Key: { PK: 'DEVICE', SK: 'camera#1' } }).resolves({ Item: lease('camera#1', { deviceId: newId, replacedDeviceId: oldId, ttl: NOW_S }) });
    expect((await request('camera', 'POST', `/devices/${oldId}/heartbeat`)).statusCode).toBe(404);
    ddb.on(GetCommand, { Key: { PK: 'DEVICE', SK: 'camera#1' } }).resolves({});
    expect((await request('camera', 'POST', `/devices/${oldId}/heartbeat`)).statusCode).toBe(404);
  });

  it('lists device names used by other users so the client can preselect a free one (R3-01)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [
      lease('camera#1', { userId: 'other', deviceName: 'CAM1' }),
      lease('camera#2', { deviceName: 'CAM2' }),
      lease('camera#3', { userId: 'other', deviceName: 'CAM3', ttl: NOW_S }),
    ] });
    const response = await request('camera', 'GET', '/devices/names', undefined, 'user-1', 'purpose=camera');
    expect(data(response)).toEqual({ inUse: ['CAM1'] });
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({ ConsistentRead: true, ExpressionAttributeValues: { ':pk': 'DEVICE', ':sk': 'camera#' } });
    expect((await request('viewer', 'GET', '/devices/names', undefined, 'user-1', 'purpose=camera')).statusCode).toBe(403);
    expect((await request('camera', 'GET', '/devices/names', undefined, 'user-1', 'purpose=slide')).statusCode).toBe(400);
    expect((await request('camera', 'GET', '/devices/names')).statusCode).toBe(400);
  });

  it('lists active devices with a single partition query', async () => {
    ddb.on(QueryCommand).resolves({ Items: [lease('camera#1'), lease('mic#1', { deviceId: 'old', ttl: NOW_S })] });
    expect(data(await request('admin', 'GET', '/devices'))).toEqual([{ deviceId: `camera.1.${UUID}`, deviceName: 'CAM1', kind: 'camera', userId: 'user-1', connected: true }]);
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({ KeyConditionExpression: '#pk = :pk', ExpressionAttributeValues: { ':pk': 'DEVICE' } });
  });

  it('looks up heartbeats by the slot embedded in the device id and enforces ownership', async () => {
    const deviceId = `camera.1.${UUID}`;
    ddb.on(GetCommand, { Key: { PK: 'DEVICE', SK: 'camera#1' } }).resolves({ Item: lease('camera#1') });
    const ok = await request('camera', 'POST', `/devices/${deviceId}/heartbeat`);
    expect(data(ok)).toEqual({ expiresAt: new Date((NOW_S + 45) * 1000).toISOString() });
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({ Key: { PK: 'DEVICE', SK: 'camera#1' }, ConditionExpression: 'deviceId = :deviceId', ExpressionAttributeValues: { ':ttl': NOW_S + 45, ':deviceId': deviceId } });
    expect(data(await request('viewer', 'POST', `/devices/${deviceId}/heartbeat`, undefined, 'other')).error).toMatchObject({ code: 'NOT_FOUND', message: '対象が見つかりません' });
    expect(data(await request('camera', 'POST', '/devices/not-a-device-id/heartbeat')).error?.code).toBe('NOT_FOUND');
    expect(data(await request('camera', 'POST', `/devices/camera.1.${UUID.replace('0b6c', '9999')}/heartbeat`)).error?.code).toBe('NOT_FOUND');
  });

  it('returns 404 when the lease is taken over during a heartbeat (R1-14)', async () => {
    ddb.on(GetCommand, { Key: { PK: 'DEVICE', SK: 'camera#1' } }).resolves({ Item: lease('camera#1') });
    ddb.on(UpdateCommand).rejects(conditionalError());
    const response = await request('camera', 'POST', `/devices/camera.1.${UUID}/heartbeat`);
    expect(response.statusCode).toBe(404);
  });

  it('disconnects the participant when a device is released and enforces release ownership', async () => {
    ddb.on(GetCommand, { Key: { PK: 'DEVICE', SK: 'camera#1' } }).resolves({ Item: lease('camera#1', { userId: 'other', participantId: 'p-1', stageArn: 'prod' }) });
    expect(data(await request('camera', 'DELETE', `/devices/camera.1.${UUID}`)).error).toMatchObject({ code: 'FORBIDDEN', message: 'この操作を行う権限がありません' });
    expect(ivs.commandCalls(DisconnectParticipantCommand)).toHaveLength(0);
    expect((await request('admin', 'DELETE', `/devices/camera.1.${UUID}`)).statusCode).toBe(200);
    expect(ivs.commandCalls(DisconnectParticipantCommand)[0]?.args[0].input).toMatchObject({ stageArn: 'prod', participantId: 'p-1' });
    expect(ddb.commandCalls(DeleteCommand)[0]?.args[0].input).toMatchObject({ Key: { PK: 'DEVICE', SK: 'camera#1' }, ExpressionAttributeValues: { ':deviceId': `camera.1.${UUID}` } });
  });
});

describe('room scoped venue speaker signaling', () => {
  const base = '/venue-speaker/rooms/room-a';
  it.each(['viewer', 'camera', 'audio', 'presenter', 'admin'] as const)('allows authenticated role %s to register in a room', async (role) => {
    const response = await request(role, 'POST', `${base}/participants`, { side: 'mic', slot: 1 });
    expect(response.statusCode).toBe(200);
    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({ Item: { PK: 'VENUE_ROOM#room-a', SK: 'participant#mic#1', userId: 'user-1', ttl: NOW_S + 300 }, ConditionExpression: 'attribute_not_exists(PK) OR #ttl <= :now' });
  });
  it.each([{ side: 'mic', max: 3 }, { side: 'speaker', max: 5 }] as const)('enforces $max collision safe $side slots', async ({ side, max }) => {
    const slots = new Map<string, number>();
    ddb.on(PutCommand).callsFake(async (input) => {
      const key = String(input.Item?.SK); if ((slots.get(key) ?? 0) === 1 && Number(input.ExpressionAttributeValues?.[':now']) < NOW_S + 300) throw conditionalError(); slots.set(key, 1); return {};
    });
    for (let i = 1; i <= max; i++) expect((await request('viewer', 'POST', `${base}/participants`, { side, slot: i })).statusCode).toBe(200);
    expect((await request('viewer', 'POST', `${base}/participants`, { side, slot: 1 })).statusCode).toBe(409);
    expect(slots.size).toBe(max);
  });
  it('allows only one of two concurrent reservations for the same slot', async () => {
    let occupied = false;
    ddb.on(PutCommand).callsFake(async () => { if (occupied) throw conditionalError(); occupied = true; return {}; });
    const responses = await Promise.all([
      request('viewer', 'POST', `${base}/participants`, { side: 'speaker', slot: 3 }, 'first'),
      request('viewer', 'POST', `${base}/participants`, { side: 'speaker', slot: 3 }, 'second'),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  });
  it('rejects invalid registration payloads and invalid methods', async () => {
    expect((await request('viewer', 'POST', `${base}/participants`, { side: 'mic', slot: 4 })).statusCode).toBe(400);
    expect((await request('viewer', 'POST', `${base}/participants`, { side: 'speaker', slot: 6 })).statusCode).toBe(400);
    expect((await request('viewer', 'POST', `${base}/offers/1/1`, {})).statusCode).toBe(404);
  });
  it('lists only unexpired room participants', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'VENUE_ROOM#room-a', SK: 'participant#mic#1', participantId: 'active', userId: 'u1', side: 'mic', slot: 1, ttl: NOW_S + 1 }, { PK: 'VENUE_ROOM#room-a', SK: 'participant#mic#2', participantId: 'expired', ttl: NOW_S }] });
    expect(data(await request('viewer', 'GET', `${base}/participants`))).toEqual([{ participantId: 'active', side: 'mic', slot: 1 }]);
  });
  it('isolates offer/answer exchange by room and mic-speaker pair, enforcing owners and TTL', async () => {
    ddb.on(GetCommand).callsFake(async (input) => input.Key?.SK === 'participant#mic#2' ? { Item: { participantId: 'mic-id', userId: 'user-1', ttl: NOW_S + 30 } } : {});
    const put = await request('audio', 'PUT', `${base}/offers/2/4`, { type: 'offer', sdp: 'offer-sdp' });
    expect(put.statusCode).toBe(200);
    expect(ddb.commandCalls(PutCommand).at(-1)?.args[0].input.Item).toMatchObject({ PK: 'VENUE_ROOM#room-a', SK: 'offers#2#4', participantId: 'mic-id', ttl: NOW_S + 90 });
    ddb.on(GetCommand).callsFake(async (input) => {
      if (input.Key?.SK === 'participant#speaker#4') return { Item: { participantId: 'speaker-id', userId: 'speaker', ttl: NOW_S + 30 } };
      if (input.Key?.SK === 'participant#mic#2') return { Item: { participantId: 'mic-id', userId: 'user-1', ttl: NOW_S + 30 } };
      return { Item: { type: 'offer', sdp: 'offer-sdp', participantId: 'mic-id', ttl: NOW_S + 30 } };
    });
    expect(data(await request('viewer', 'GET', `${base}/offers/2/4`))).toEqual({ type: 'offer', sdp: 'offer-sdp' });
    expect(ddb.commandCalls(GetCommand).at(-1)?.args[0].input.Key).toEqual({ PK: 'VENUE_ROOM#room-a', SK: 'offers#2#4' });
    const answerPut = await request('viewer', 'PUT', `${base}/answers/2/4`, { type: 'answer', sdp: 'answer-sdp' }, 'speaker');
    expect(answerPut.statusCode).toBe(200);
    expect(ddb.commandCalls(PutCommand).at(-1)?.args[0].input.Item).toMatchObject({ SK: 'answers#2#4', participantId: 'speaker-id' });
    ddb.on(GetCommand).callsFake(async (input) => {
      if (input.Key?.SK === 'participant#mic#2') return { Item: { participantId: 'mic-id', userId: 'user-1', ttl: NOW_S + 30 } };
      if (input.Key?.SK === 'participant#speaker#4') return { Item: { participantId: 'speaker-id', userId: 'speaker', ttl: NOW_S + 30 } };
      return { Item: { type: 'answer', sdp: 'answer-sdp', participantId: 'speaker-id', ttl: NOW_S + 30 } };
    });
    expect(data(await request('viewer', 'GET', `${base}/answers/2/4`))).toEqual({ type: 'answer', sdp: 'answer-sdp' });
    ddb.on(GetCommand).callsFake(async (input) => {
      if (input.Key?.SK === 'participant#mic#2') return { Item: { participantId: 'mic-id', ttl: NOW_S + 30 } };
      if (input.Key?.SK === 'participant#speaker#4') return { Item: { participantId: 'speaker-id', ttl: NOW_S + 30 } };
      return { Item: { type: 'answer', sdp: 'old', participantId: 'speaker-id', ttl: NOW_S } };
    });
    expect(data(await request('viewer', 'GET', `${base}/answers/2/4`))).toBeNull();
    ddb.on(GetCommand).resolves({ Item: { participantId: 'mic-id', userId: 'other', ttl: NOW_S + 30 } });
    expect((await request('audio', 'PUT', `${base}/offers/2/4`, { type: 'offer', sdp: 'x' })).statusCode).toBe(404);
  });
  it('restricts participant leave and signal cleanup to the owner', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'VENUE_ROOM#room-a', SK: 'participant#mic#1', participantId: 'p1', userId: 'owner', ttl: NOW_S + 10 }] });
    expect((await request('viewer', 'DELETE', `${base}/participants/p1`)).statusCode).toBe(404);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(0);
    expect((await request('viewer', 'DELETE', `${base}/participants/p1`, undefined, 'owner')).statusCode).toBe(200);
    expect(ddb.commandCalls(DeleteCommand).at(-1)?.args[0].input.ConditionExpression).toContain('userId = :userId');
  });
  it('renews only an active participant lease owned by the caller', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'VENUE_ROOM#room-a', SK: 'participant#mic#1', participantId: 'p1', userId: 'user-1', ttl: NOW_S + 10 }] });
    const renewed = await request('viewer', 'PATCH', `${base}/participants/p1`);
    expect(renewed.statusCode).toBe(200);
    expect(data(renewed)).toEqual({ expiresAt: new Date((NOW_S + 300) * 1000).toISOString() });
    expect(ddb.commandCalls(UpdateCommand).at(-1)?.args[0].input).toMatchObject({
      Key: { PK: 'VENUE_ROOM#room-a', SK: 'participant#mic#1' },
      UpdateExpression: 'SET #ttl = :ttl',
      ConditionExpression: 'participantId = :id AND userId = :userId AND #ttl > :now',
    });
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'VENUE_ROOM#room-a', SK: 'participant#mic#1', participantId: 'p1', userId: 'someone-else', ttl: NOW_S + 10 }] });
    expect((await request('viewer', 'PATCH', `${base}/participants/p1`, undefined, 'owner')).statusCode).toBe(404);
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'VENUE_ROOM#room-a', SK: 'participant#mic#1', participantId: 'p1', userId: 'user-1', ttl: NOW_S }] });
    expect((await request('viewer', 'PATCH', `${base}/participants/p1`)).statusCode).toBe(404);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(1);
  });
  it('deliberately retires the global legacy endpoints', async () => {
    expect((await request('audio', 'PUT', '/venue-speaker/mic', { type: 'offer', sdp: 'legacy' })).statusCode).toBe(404);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});

describe('API router endpoint behavior', () => {
  it('returns email and login method from Cognito because access tokens lack them (R1-01)', async () => {
    ddb.on(GetCommand).resolves({ Item: { displayName: 'Kos', commentSuspended: true } });
    cognito.on(AdminGetUserCommand).resolves({ Username: 'okta_user', UserAttributes: [{ Name: 'email', Value: 'okta@example.test' }, { Name: 'identities', Value: '[{"providerName":"Okta"}]' }] });
    const response = await request('viewer', 'GET', '/me');
    expect(MeResponseSchema.parse(data(response))).toEqual({ userId: 'user-1', email: 'okta@example.test', role: 'viewer', loginMethod: 'Okta', displayName: 'Kos', commentSuspended: true });
    expect(cognito.commandCalls(AdminGetUserCommand)[0]?.args[0].input).toEqual({ UserPoolId: 'pool', Username: 'user-1-name' });
    cognito.on(AdminGetUserCommand).resolves({ Username: 'user-1-name', UserAttributes: [{ Name: 'email', Value: 'user@example.test' }] });
    ddb.on(GetCommand).resolves({});
    expect(MeResponseSchema.parse(data(await request('viewer', 'GET', '/me')))).toEqual({ userId: 'user-1', email: 'user@example.test', role: 'viewer', loginMethod: 'email', displayName: null, commentSuspended: false });
  });

  it('detects normalized NG display names from the NGWORD partition', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ PK: 'NGWORD', SK: 'bad', word: 'bad' }] });
    const blocked = await request('viewer', 'PUT', '/me/display-name', { displayName: 'ＢＡＤ' });
    expect(blocked.statusCode).toBe(400);
    expect(data(blocked).error).toMatchObject({ code: 'NG_WORD', message: '使用できない単語が含まれています' });
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'NGWORD' });
  });

  it('returns missing and starting broadcast states as idle', async () => {
    await expect(request('viewer', 'GET', '/broadcast')).resolves.toMatchObject({ statusCode: 200, body: 'null' });
    ddb.on(GetCommand).resolves({ Item: { id: 'b-1', title: 'event', status: 'starting' } });
    const result = await request('viewer', 'GET', '/broadcast');
    expect(data(result)).toEqual({ id: 'b-1', title: 'event', status: 'idle', startedAt: null, endedAt: null });
  });

  it('starts composition with HLS configuration, saves its prefix, and emits an event', async () => {
    const response = await request('admin', 'POST', '/broadcast/start', { title: '大会' });
    expect(response.statusCode).toBe(200);
    expect(ivs.commandCalls(StartCompositionCommand)[0]?.args[0].input.destinations?.[0]?.s3?.recordingConfiguration).toEqual({ hlsConfiguration: { targetSegmentDurationSeconds: 10 }, format: 'HLS' });
    expect(ddb.commandCalls(PutCommand).map((call) => call.args[0].input.Item?.PK)).toContain('COMPOSITION#composition-arn');
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues).toMatchObject({ ':outputPrefix': 'stage/session/destination/composite' });
    expect(ddb.commandCalls(PutCommand).find((call) => call.args[0].input.Item?.SK === 'META')?.args[0].input.Item).toMatchObject({ outputPrefix: 'stage/session/destination/composite' });
    expect(ddb.commandCalls(PutCommand).every((call) => !('recordingPrefix' in (call.args[0].input.Item ?? {})))).toBe(true);
    expect(chat.commandCalls(SendEventCommand)[0]?.args[0].input.eventName).toBe('broadcast-started');
    expect(data(response)).toMatchObject({ title: '大会', status: 'live', endedAt: null });
  });

  it('reports a live broadcast conflict and rolls back when composition startup fails', async () => {
    ddb.on(PutCommand).rejects(conditionalError());
    const conflict = await request('admin', 'POST', '/broadcast/start', { title: '大会' });
    expect(data(conflict).error).toMatchObject({ code: 'BROADCAST_LIVE', message: '配信はすでに開始しています' });
    ddb.on(PutCommand).resolves({});
    ivs.on(StartCompositionCommand).rejects(new Error('stage unavailable'));
    const failed = await request('admin', 'POST', '/broadcast/start', { title: '大会' });
    expect(failed.statusCode).toBe(500);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(ivs.commandCalls(StopCompositionCommand)).toHaveLength(0);
  });

  it('stops the started composition when saving the live state fails (R3-11)', async () => {
    ddb.on(UpdateCommand).rejects(awsError('ProvisionedThroughputExceededException'));
    const failed = await request('admin', 'POST', '/broadcast/start', { title: '大会' });
    expect(failed.statusCode).toBe(500);
    expect(ivs.commandCalls(StopCompositionCommand).map((call) => call.args[0].input)).toEqual([{ arn: 'composition-arn' }]);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(chat.commandCalls(SendEventCommand)).toHaveLength(0);
    // 補償の StopComposition が失敗しても元のエラーで応答し、行は消す
    ddb.reset(); ddb.on(PutCommand).resolves({}); ddb.on(DeleteCommand).resolves({});
    ddb.on(UpdateCommand).rejects(awsError('ProvisionedThroughputExceededException'));
    ivs.on(StopCompositionCommand).rejects(awsError('ThrottlingException'));
    expect((await request('admin', 'POST', '/broadcast/start', { title: '大会' })).statusCode).toBe(500);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it('stops only a live broadcast and reports the stopped record', async () => {
    ddb.on(GetCommand).resolves({ Item: { id: 'b-1', title: '大会', status: 'live', compositionArn: 'composition-arn', startedAt: '2026-01-01T00:00:00.000Z' } });
    const stopped = await request('admin', 'POST', '/broadcast/stop');
    expect(ivs.commandCalls(StopCompositionCommand)[0]?.args[0].input.arn).toBe('composition-arn');
    expect(data(stopped)).toEqual({ id: 'b-1', title: '大会', status: 'ended', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2023-11-14T22:13:20.000Z' });
    ddb.on(GetCommand).resolves({});
    expect(data(await request('admin', 'POST', '/broadcast/stop')).error).toMatchObject({ code: 'BROADCAST_NOT_LIVE', message: '配信中ではありません' });
    ddb.on(GetCommand).resolves({ Item: { id: 'b-1', status: 'idle' } });
    expect(data(await request('admin', 'POST', '/broadcast/stop')).error).toMatchObject({ code: 'BROADCAST_NOT_LIVE' });
  });

  it('reports the stop as done when SendEvent keeps failing, and resends broadcast-ended on a second stop (R4-01 / R2-03)', async () => {
    const live = { id: 'b-1', title: '大会', status: 'live', compositionArn: 'composition-arn', startedAt: '2026-01-01T00:00:00.000Z' };
    const ended = { id: 'b-1', title: '大会', status: 'ended', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2023-11-14T22:13:20.000Z' };
    ddb.on(GetCommand).resolvesOnce({ Item: live }).resolves({ Item: ended });
    chat.on(SendEventCommand).rejects(awsError('ThrottlingException'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const first = await request('admin', 'POST', '/broadcast/stop');
    expect(first.statusCode).toBe(200);
    expect(data(first)).toEqual(ended);
    // 初回 + 再試行3回で諦め、警告ログを残す
    expect(chat.commandCalls(SendEventCommand)).toHaveLength(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ warning: 'CHAT_EVENT_FAILED', eventName: 'broadcast-ended', name: 'ThrottlingException' });
    // 監査ログは SendEvent の成否に関係なく残る（R3-14）
    expect(info.mock.calls.map((call) => JSON.parse(String(call[0])) as { action: string; target?: string })).toEqual([expect.objectContaining({ action: 'broadcast.stop', target: 'b-1' })]);
    chat.on(SendEventCommand).resolves({});
    const retried = await request('admin', 'POST', '/broadcast/stop');
    expect(retried.statusCode).toBe(200);
    expect(data(retried)).toEqual(ended);
    expect(chat.commandCalls(SendEventCommand).map((call) => call.args[0].input.eventName)).toEqual(Array(5).fill('broadcast-ended'));
    expect(info.mock.calls.at(-1)?.[0]).toContain('"action":"broadcast.stop.retry"');
    expect(ivs.commandCalls(StopCompositionCommand)).toHaveLength(1);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(1);
    warn.mockRestore(); info.mockRestore();
  });

  it('retries a transient SendEvent failure without warning (R4-01)', async () => {
    chat.on(SendEventCommand).rejectsOnce(awsError('ThrottlingException')).resolves({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await request('admin', 'POST', '/broadcast/start', { title: '大会' })).statusCode).toBe(200);
    expect(chat.commandCalls(SendEventCommand).map((call) => call.args[0].input.eventName)).toEqual(['broadcast-started', 'broadcast-started']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('gives up on a SendEvent that never answers within 3 seconds and still reports the start as done (R5-01)', async () => {
    chat.on(SendEventCommand).callsFake(() => new Promise(() => undefined));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    let settled = false;
    const pending = request('admin', 'POST', '/broadcast/start', { title: '大会' }).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(chat.commandCalls(SendEventCommand)).toHaveLength(1);
    expect(((chat.commandCalls(SendEventCommand)[0]?.args as unknown[])[1] as { abortSignal?: AbortSignal }).abortSignal?.aborted).toBe(true);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({ warning: 'CHAT_EVENT_FAILED', eventName: 'broadcast-started', name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    warn.mockRestore();
  });

  it.each([
    ['POST', '/broadcast/start', { title: '大会' }, 'broadcast.start'],
    ['PUT', '/slides/order', { ids: ['s-1'] }, 'slide.order'],
    ['DELETE', '/slides/s-1', undefined, 'slide.delete'],
    ['PATCH', '/archives/a-1', { title: '新しい題' }, 'archive.update'],
    ['DELETE', '/archives/a-1', undefined, 'archive.delete'],
  ] as const)('%s %s succeeds and audits even when SendEvent keeps failing (R4-01)', async (method, path, body, action) => {
    ddb.on(GetCommand, { Key: { PK: 'SLIDE', SK: 's-1' } }).resolves({ Item: { PK: 'SLIDE', SK: 's-1', id: 's-1', key: 'slides/s-1.pdf' } });
    ddb.on(GetCommand, { Key: { PK: 'ARCHIVE', SK: 'a-1' } }).resolves({ Item: { PK: 'ARCHIVE', SK: 'a-1', id: 'a-1', title: '題', published: false, durationSeconds: 1, recordingPrefix: 'p/a-1', retainUntil: '2040-01-01T00:00:00.000Z' } });
    chat.on(SendEventCommand).rejects(awsError('ThrottlingException'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const response = await request('admin', method, path, body);
    expect(response.statusCode).toBe(200);
    expect(info.mock.calls.some((call) => String(call[0]).includes(`"action":"${action}"`))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore(); info.mockRestore();
  });

  it('ends the broadcast when the composition already stopped by itself (R1-03)', async () => {
    ddb.on(GetCommand).resolves({ Item: { id: 'b-1', title: '大会', status: 'live', compositionArn: 'composition-arn', startedAt: '2026-01-01T00:00:00.000Z' } });
    ivs.on(StopCompositionCommand).rejects(awsError('ResourceNotFoundException'));
    const stopped = await request('admin', 'POST', '/broadcast/stop');
    expect(stopped.statusCode).toBe(200);
    expect(data(stopped).status).toBe('ended');
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues).toMatchObject({ ':status': 'ended' });
    expect(chat.commandCalls(SendEventCommand).map((call) => call.args[0].input.eventName)).toEqual(['broadcast-ended']);
  });

  it('keeps the broadcast live when stopping fails for another reason', async () => {
    ddb.on(GetCommand).resolves({ Item: { id: 'b-1', status: 'live', compositionArn: 'composition-arn' } });
    ivs.on(StopCompositionCommand).rejects(awsError('ConflictException'));
    expect((await request('admin', 'POST', '/broadcast/stop')).statusCode).toBe(500);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(chat.commandCalls(SendEventCommand)).toHaveLength(0);
  });

  it('counts connected subscribers across participant pages and returns zero without a session', async () => {
    let participantPage = 0;
    ivs.on(ListParticipantsCommand).callsFake(async () => { participantPage += 1; return participantPage === 1 ? { participants: [{ published: false }, { published: true }], nextToken: 'next' } : { participants: [{ published: false }] }; });
    expect(data(await request('admin', 'GET', '/broadcast/stats'))).toEqual({ viewerCount: 2 });
    expect(ivs.commandCalls(ListParticipantsCommand)[1]?.args[0].input.nextToken).toBe('next');
    ivs.on(GetStageCommand).resolves({ stage: { arn: 'broadcast' } });
    expect(data(await request('admin', 'GET', '/broadcast/stats'))).toEqual({ viewerCount: 0 });
  });

  it('uses any live stage session to report an active stage', async () => {
    ivs.on(GetStageCommand).resolves({ stage: { arn: 'stage', activeSessionId: undefined } });
    ivs.on(ListStageSessionsCommand).resolves({ stageSessions: [
      { sessionId: 'active-session' },
      { sessionId: 'ended-session', endTime: new Date('2026-01-01T00:00:00Z') },
    ] });
    chat.on(GetRoomCommand).resolves({ arn: 'room' });
    const result = data(await request('admin', 'GET', '/status'));
    expect(result.stages).toEqual(['production', 'slide', 'broadcast'].map((name) => ({ name, exists: true, status: 'ACTIVE' })));
    expect(ivs.commandCalls(ListStageSessionsCommand).map((call) => call.args[0].input)).toEqual([
      { stageArn: 'prod', maxResults: 1 }, { stageArn: 'slide', maxResults: 1 }, { stageArn: 'broadcast', maxResults: 1 },
    ]);
  });

  it('reports missing stages and chat rooms as not existing', async () => {
    ivs.on(GetStageCommand).callsFake(async ({ arn }) => arn === 'slide' ? Promise.reject(awsError('ResourceNotFoundException')) : ({ stage: { activeSessionId: arn === 'prod' ? 'active' : undefined } }));
    ivs.on(ListStageSessionsCommand).callsFake(async ({ stageArn }) => ({ stageSessions: stageArn === 'broadcast' ? [{ sessionId: 'live-session' }] : [] }));
    chat.on(GetRoomCommand).rejects(awsError('ResourceNotFoundException'));
    const status = data(await request('admin', 'GET', '/status'));
    expect(status.stages).toEqual([{ name: 'production', exists: true, status: 'ACTIVE' }, { name: 'slide', exists: false }, { name: 'broadcast', exists: true, status: 'ACTIVE' }]);
    expect(status.chatRoom).toEqual({ exists: false });
    ivs.on(GetStageCommand).resolves({ stage: { arn: 'x' } });
    ivs.on(ListStageSessionsCommand).resolves({ stageSessions: [{ sessionId: 'old', endTime: new Date('2026-01-01T00:00:00Z') }] });
    chat.on(GetRoomCommand).resolves({ arn: 'room' });
    expect(data(await request('admin', 'GET', '/status'))).toEqual({ stages: ['production', 'slide', 'broadcast'].map((name) => ({ name, exists: true, status: 'IDLE' })), chatRoom: { exists: true, status: 'ACTIVE' } });
  });

  it('resolves the chat room by name and reports a room missing from ListRooms as not existing', async () => {
    ivs.on(GetStageCommand).resolves({ stage: { arn: 'x' } });
    ivs.on(ListStageSessionsCommand).resolves({ stageSessions: [] });
    chat.on(GetRoomCommand).resolves({ arn: 'room' });
    chat.on(ListRoomsCommand).resolves({ rooms: [{ name: 'room-name-old', arn: 'old' }] });
    expect(data(await request('admin', 'GET', '/status')).chatRoom).toEqual({ exists: false });
    expect(chat.commandCalls(GetRoomCommand)).toHaveLength(0);
    chat.on(ListRoomsCommand).resolves({ rooms: [{ name: 'room-name', arn: 'room' }] });
    expect(data(await request('admin', 'GET', '/status')).chatRoom).toEqual({ exists: true, status: 'ACTIVE' });
    expect(data(await request('admin', 'GET', '/status')).chatRoom).toEqual({ exists: true, status: 'ACTIVE' });
    expect(chat.commandCalls(ListRoomsCommand).map((call) => call.args[0].input)).toEqual([{ name: 'room-name' }, { name: 'room-name' }]);
    expect(chat.commandCalls(GetRoomCommand).map((call) => call.args[0].input)).toEqual([{ identifier: 'room' }, { identifier: 'room' }]);
  });

  it('fails the broadcast start when the storage configuration cannot be resolved by name', async () => {
    ivs.on(ListStorageConfigurationsCommand).resolves({ storageConfigurations: [{ name: 'storage-name', arn: 'a' }, { name: 'storage-name', arn: 'b' }] });
    const response = await request('admin', 'POST', '/broadcast/start', { title: '配信' });
    expect(response.statusCode).toBe(500);
    expect(ivs.commandCalls(StartCompositionCommand)).toHaveLength(0);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it.each([
    ['ListStageSessions', () => ivs.on(ListStageSessionsCommand).rejects(awsError('AccessDeniedException'))],
    ['GetStage', () => ivs.on(GetStageCommand).rejects(awsError('AccessDeniedException'))],
    ['GetRoom', () => chat.on(GetRoomCommand).rejects(awsError('AccessDeniedException'))],
  ])('surfaces %s permission errors instead of reporting a missing resource (R1-06)', async (_name, arrange) => {
    arrange();
    const response = await request('admin', 'GET', '/status');
    expect(response.statusCode).toBe(500);
    expect(data(response).error?.code).toBe('INTERNAL_ERROR');
  });

  it('issues chat tokens according to suspension and admin capabilities', async () => {
    ddb.on(GetCommand).resolves({ Item: { displayName: 'Kos', commentSuspended: true } });
    expect(data(await request('viewer', 'POST', '/tokens/chat'))).toEqual({ token: 'chat-token', capabilities: [] });
    expect(data(await request('admin', 'POST', '/tokens/chat'))).toEqual({ token: 'chat-token', capabilities: ['SEND_MESSAGE', 'DELETE_MESSAGE', 'DISCONNECT_USER'] });
  });

  it('reads recent comments newest first from the COMMENT partition without deleted records', async () => {
    const comment = (id: string, sentAt: string) => ({ messageId: id, userId: 'u', displayName: 'A', comment: id, sentAt, deleted: false });
    ddb.on(QueryCommand).resolves({ Items: [comment('new', '2026-01-02T00:00:00.000Z'), comment('old', '2026-01-01T00:00:00.000Z')] });
    expect(data(await request('viewer', 'GET', '/comments/recent'))).toEqual([comment('new', '2026-01-02T00:00:00.000Z'), comment('old', '2026-01-01T00:00:00.000Z')]);
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'PK', '#deleted': 'deleted' },
      ExpressionAttributeValues: { ':pk': 'COMMENT', ':deleted': true }, FilterExpression: '#deleted <> :deleted', ScanIndexForward: false, Limit: 100,
    });
  });

  it('pages the COMMENT partition until 100 visible comments and stops there', async () => {
    const page = (offset: number) => Array.from({ length: 60 }, (_, index) => ({ messageId: `m${offset + index}`, userId: 'u', displayName: 'A', comment: 'c', sentAt: '2026-01-01T00:00:00.000Z', deleted: false }));
    ddb.on(QueryCommand).resolvesOnce({ Items: page(0), LastEvaluatedKey: { PK: 'a' } }).resolvesOnce({ Items: page(60), LastEvaluatedKey: { PK: 'b' } }).resolves({ Items: page(120) });
    const comments = data(await request('viewer', 'GET', '/comments/recent')) as unknown as { messageId: string }[];
    expect(comments).toHaveLength(100);
    expect(comments.at(-1)?.messageId).toBe('m99');
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(2);
    expect(ddb.commandCalls(QueryCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual({ PK: 'a' });
  });

  it('moderates and suspends chat users with the matching IVS commands', async () => {
    ddb.on(GetCommand, { Key: { PK: 'COMMENT#m-1', SK: 'REF' } }).resolves({ Item: { PK: 'COMMENT#m-1', SK: 'REF', commentSk: '2026-01-01T00:00:00.000Z#m-1' } });
    expect((await request('admin', 'DELETE', '/comments/m-1')).statusCode).toBe(200);
    expect(chat.commandCalls(DeleteMessageCommand)[0]?.args[0].input).toMatchObject({ id: 'm-1', reason: '管理者による削除' });
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({ Key: { PK: 'COMMENT', SK: '2026-01-01T00:00:00.000Z#m-1' }, ExpressionAttributeValues: { ':deleted': true }, ConditionExpression: 'attribute_exists(PK)' });
    expect(data(await request('admin', 'DELETE', '/comments/unknown')).error?.code).toBe('NOT_FOUND');
    expect(chat.commandCalls(DeleteMessageCommand)).toHaveLength(1);
    expect((await request('admin', 'PUT', '/users/u-2/comment-suspension', { suspended: true })).statusCode).toBe(200);
    expect(chat.commandCalls(DisconnectUserCommand)[0]?.args[0].input).toMatchObject({ userId: 'u-2', reason: 'コメント送信停止' });
    expect((await request('admin', 'PUT', '/users/u-2/comment-suspension', { suspended: false })).statusCode).toBe(200);
    // 解除でも切断し、本人のクライアントに /me とトークンを取り直させる（R4-02）
    expect(chat.commandCalls(DisconnectUserCommand).map((call) => call.args[0].input)).toEqual([
      { roomIdentifier: 'room', userId: 'u-2', reason: 'コメント送信停止' },
      { roomIdentifier: 'room', userId: 'u-2', reason: 'コメント送信停止の解除' },
    ]);
  });

  it('exports CSV with message id, deleted flag, BOM, quotes and formula-injection escaping (R1-15)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [
      { messageId: 'm-1', sentAt: '2026-01-01T00:00:00Z', userId: 'u', displayName: '=HYPERLINK("x")', comment: '+1', deleted: false },
      { messageId: 'm-2', sentAt: '2026-01-02T00:00:00Z', userId: 'u2', displayName: '\tA', comment: '\rcmd', deleted: true },
      { messageId: 'm-3', sentAt: '2026-01-03T00:00:00Z', userId: 'u3', displayName: '-x', comment: '@sum' },
    ] });
    const response = await request('admin', 'GET', '/comments/export');
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.body).toBe(`﻿メッセージID,日時,ユーザーID,表示名,コメント,削除済み\r\n"m-1","2026-01-01T00:00:00Z","u","'=HYPERLINK(""x"")","'+1","false"\r\n"m-2","2026-01-02T00:00:00Z","u2","'\tA","'\rcmd","true"\r\n"m-3","2026-01-03T00:00:00Z","u3","'-x","'@sum","false"`);
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({ ExpressionAttributeValues: { ':pk': 'COMMENT' } });
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input.ScanIndexForward).toBeUndefined();
  });

  it('lists and mutates NG words with validation and exact keys', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ word: 'zeta' }, { word: 'alpha' }] });
    expect(data(await request('admin', 'GET', '/ng-words'))).toEqual(['alpha', 'zeta']);
    expect((await request('admin', 'POST', '/ng-words', { word: ' blocked ' })).statusCode).toBe(200);
    expect(ddb.commandCalls(PutCommand).at(-1)?.args[0].input.Item).toMatchObject({ PK: 'NGWORD', SK: 'blocked', word: 'blocked' });
    expect((await request('admin', 'DELETE', '/ng-words/blocked')).statusCode).toBe(200);
    expect(ddb.commandCalls(DeleteCommand).at(-1)?.args[0].input.Key).toEqual({ PK: 'NGWORD', SK: 'blocked' });
    const invalid = await request('admin', 'POST', '/ng-words', { word: '' });
    expect(data(invalid).error?.code).toBe('VALIDATION_ERROR');
    expect(data(invalid).error?.message).toContain('String must contain at least 1 character(s)');
  });

  it('lists published slides and completes only a valid uploaded PDF', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ id: 's-2', title: 'second', fileName: 'b.pdf', size: 100, order: 2, published: true }, { id: 's-1', title: 'first', fileName: 'a.pdf', size: 100, order: 1, published: true }, { id: 'hidden', published: false }] });
    expect(data(await request('viewer', 'GET', '/slides'))).toEqual([{ id: 's-1', title: 'first', fileName: 'a.pdf', size: 100, order: 1, filePath: '/files/slides/s-1.pdf' }, { id: 's-2', title: 'second', fileName: 'b.pdf', size: 100, order: 2, filePath: '/files/slides/s-2.pdf' }]);
    ddb.on(GetCommand).resolves({ Item: { id: 's-3', key: 'slides/s-3.pdf', title: 'third', fileName: 'c.pdf', size: 100 } });
    const completed = await request('admin', 'POST', '/slides/s-3/complete');
    expect(data(completed)).toEqual({ id: 's-3', title: 'third', fileName: 'c.pdf', size: 100, order: 2, filePath: '/files/slides/s-3.pdf' });
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({ Key: { PK: 'SLIDE', SK: 's-3' }, ExpressionAttributeValues: { ':published': true, ':order': 2 }, ConditionExpression: 'attribute_exists(PK)' });
    expect(s3.commandCalls(GetObjectCommand)[0]?.args[0].input.Range).toBe('bytes=0-4');
    expect(chat.commandCalls(SendEventCommand).at(-1)?.args[0].input.eventName).toBe('slides-updated');
  });

  it('rejects mismatched and malformed completed slide bytes with exact validation errors', async () => {
    ddb.on(GetCommand).resolves({ Item: { id: 's-1', key: 'slides/s-1.pdf', size: 100 } });
    s3.on(HeadObjectCommand).resolves({ ContentLength: 101, ContentType: 'application/pdf' });
    let response = await request('admin', 'POST', '/slides/s-1/complete');
    expect(data(response).error).toEqual({ code: 'VALIDATION_ERROR', message: 'PDF のサイズまたは MIME タイプが一致しません' });
    s3.on(HeadObjectCommand).resolves({ ContentLength: 100, ContentType: 'application/pdf' });
    s3.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => Buffer.from('nope!') } as never });
    response = await request('admin', 'POST', '/slides/s-1/complete');
    expect(data(response).error).toEqual({ code: 'VALIDATION_ERROR', message: 'PDF ファイルとして読み取れません' });
    ddb.on(GetCommand).resolves({});
    expect(data(await request('admin', 'POST', '/slides/missing/complete')).error?.code).toBe('NOT_FOUND');
  });

  it('updates, reorders and deletes slides and emits the custom update event', async () => {
    ddb.on(GetCommand).resolves({ Item: { id: 's-1', key: 'slides/s-1.pdf', title: 'before', fileName: 'x.pdf', size: 100, order: 0 } });
    expect((await request('admin', 'PATCH', '/slides/s-1', { title: 'after' })).statusCode).toBe(200);
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({ Key: { PK: 'SLIDE', SK: 's-1' }, ExpressionAttributeValues: { ':title': 'after' } });
    expect((await request('admin', 'PUT', '/slides/order', { ids: ['s-1', 's-2'] })).statusCode).toBe(200);
    expect(ddb.commandCalls(UpdateCommand).slice(1).map((call) => call.args[0].input.ExpressionAttributeValues?.[':order'])).toEqual([0, 1]);
    expect((await request('admin', 'DELETE', '/slides/s-1')).statusCode).toBe(200);
    expect(s3.commandCalls(DeleteObjectsCommand).at(-1)?.args[0].input.Delete?.Objects).toEqual([{ Key: 'slides/s-1.pdf' }]);
    expect(ddb.commandCalls(DeleteCommand).at(-1)?.args[0].input.Key).toEqual({ PK: 'SLIDE', SK: 's-1' });
    expect(chat.commandCalls(SendEventCommand).map((call) => call.args[0].input.eventName)).toEqual(['slides-updated', 'slides-updated']);
  });

  it.each([
    ['PATCH', '/slides/missing', { title: 'x' }],
    ['PUT', '/slides/order', { ids: ['s-1', 'unknown'] }],
    ['PATCH', '/archives/missing', { title: 'x' }],
  ] as const)('maps a failed existence condition on %s %s to 404 (R1-14)', async (method, path, body) => {
    ddb.on(UpdateCommand).rejects(conditionalError());
    const response = await request('admin', method, path, body);
    expect(response.statusCode).toBe(404);
    expect(data(response).error).toEqual({ code: 'NOT_FOUND', message: '対象が見つかりません' });
    expect(chat.commandCalls(SendEventCommand)).toHaveLength(0);
  });
});

describe('archives and signed cookies', () => {
  const archive = (id: string, extra: Record<string, unknown> = {}) => ({ PK: 'ARCHIVE', SK: id, id, title: id, published: true, durationSeconds: 30, recordingPrefix: `stage/${id}/d/composite`, createdAt: '2023-11-01T00:00:00.000Z', retainUntil: '2024-11-01T00:00:00.000Z', ...extra });

  it('filters private and expired archives for viewers and includes retainUntil (R1-22)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [
      archive('a-1', { published: false }),
      archive('a-2', { createdAt: '2023-11-02T00:00:00.000Z' }),
      archive('expired', { retainUntil: '2023-11-14T22:13:20.000Z' }),
      archive('legacy', { retainUntil: undefined, createdAt: '2023-01-01T00:00:00.000Z' }),
    ] });
    const viewer = ArchivesResponseSchema.parse(data(await request('viewer', 'GET', '/archives')));
    expect(viewer).toEqual([
      { id: 'a-2', title: 'a-2', published: true, durationSeconds: 30, playbackPath: '/files/archives/stage/a-2/d/composite/media/hls/multivariant.m3u8', retainUntil: '2024-11-01T00:00:00.000Z' },
      { id: 'legacy', title: 'legacy', published: true, durationSeconds: 30, playbackPath: '/files/archives/stage/legacy/d/composite/media/hls/multivariant.m3u8', retainUntil: '2024-01-01T00:00:00.000Z' },
    ]);
    expect((data(await request('admin', 'GET', '/archives')) as unknown as { id: string }[]).map((item) => item.id)).toEqual(['a-2', 'a-1', 'legacy']);
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'ARCHIVE' });
  });

  it('updates title and publication of an archive', async () => {
    ddb.on(GetCommand).resolves({ Item: archive('a-1', { title: 'old', published: false }) });
    const updated = await request('admin', 'PATCH', '/archives/a-1', { title: 'new', published: true });
    expect(data(updated)).toMatchObject({ id: 'a-1', title: 'old', published: false });
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({ Key: { PK: 'ARCHIVE', SK: 'a-1' }, UpdateExpression: 'SET title = :title, published = :published', ConditionExpression: 'attribute_exists(PK)' });
    expect(chat.commandCalls(SendEventCommand)[0]?.args[0].input.eventName).toBe('archives-updated');
  });

  it.each([
    { name: 'now', retainUntil: '2023-11-14T22:13:20.000Z', statusCode: 400 },
    { name: 'past', retainUntil: '2023-01-01T00:00:00.000Z', statusCode: 400 },
    { name: 'now + 1ms', retainUntil: '2023-11-14T22:13:20.001Z', statusCode: 200 },
  ])('extends retainUntil together with the TTL attribute only into the future ($name)', async ({ retainUntil, statusCode }) => {
    ddb.on(GetCommand).resolves({ Item: archive('a-1', { retainUntil: '2025-01-01T00:00:00.000Z' }) });
    const response = await request('admin', 'PATCH', '/archives/a-1', { retainUntil });
    expect(response.statusCode).toBe(statusCode);
    if (statusCode === 400) {
      expect(data(response).error).toEqual({ code: 'VALIDATION_ERROR', message: '保存期限は現在より後の日時を指定してください' });
      expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    } else {
      expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({ UpdateExpression: 'SET retainUntil = :retainUntil, #ttl = :ttl', ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':retainUntil': retainUntil, ':ttl': NOW_S } });
    }
  });

  it('rejects an unsafe archive recording prefix before deleting S3 content', async () => {
    ddb.on(GetCommand, { Key: { PK: 'ARCHIVE', SK: 'unsafe' } }).resolves({ Item: archive('unsafe', { recordingPrefix: '../private' }) });
    const response = await request('admin', 'DELETE', '/archives/unsafe');
    expect(response.statusCode).toBe(500);
    expect(data(response).error).toEqual({ code: 'INTERNAL_ERROR', message: '処理に失敗しました' });
    expect(s3.commandCalls(ListObjectsV2Command)).toHaveLength(0);
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(0);
  });

  it('deletes an archive under its exact recording prefix', async () => {
    ddb.on(GetCommand).resolves({ Item: archive('a-1') });
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'stage/a-1/d/composite/file.m3u8' }] });
    expect((await request('admin', 'DELETE', '/archives/a-1')).statusCode).toBe(200);
    expect(s3.commandCalls(ListObjectsV2Command)[0]?.args[0].input).toMatchObject({ Bucket: 'recording', Prefix: 'stage/a-1/d/composite/' });
    expect(s3.commandCalls(DeleteObjectsCommand)[0]?.args[0].input.Delete?.Objects).toEqual([{ Key: 'stage/a-1/d/composite/file.m3u8' }]);
    expect(ddb.commandCalls(DeleteCommand)[0]?.args[0].input.Key).toEqual({ PK: 'ARCHIVE', SK: 'a-1' });
  });

  it('signs slide cookies with a custom wildcard policy limited to /files/slides/ (R1-08)', async () => {
    const response = await request('viewer', 'POST', '/files/cookies');
    expect(response.statusCode).toBe(204);
    expect(response.cookies).toEqual(['CloudFront-Policy=policy; Path=/files/slides/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict', 'CloudFront-Signature=signature; Path=/files/slides/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict', 'CloudFront-Key-Pair-Id=pair; Path=/files/slides/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict']);
    const args = vi.mocked(getSignedCookies).mock.calls[0]?.[0] as { policy: string; keyPairId: string; privateKey: string };
    expect(JSON.parse(args.policy)).toEqual({ Statement: [{ Resource: 'https://example.cloudfront.net/files/slides/*', Condition: { DateLessThan: { 'AWS:EpochTime': NOW_S + 3600 } } }] });
    expect(args).toMatchObject({ keyPairId: 'key', privateKey: 'private-key' });
  });

  it('rejects cookie requests from unvalidated forwarded hosts', async () => {
    const invalidHost = makeEvent('POST', '/files/cookies');
    invalidHost.headers = { 'X-Auth-Token': 'token', 'x-forwarded-host': 'attacker.example.test' };
    const failure = await createApiHandler({ env, clients, authenticate: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'u', role: 'viewer' }) })(invalidHost);
    expect(failure.statusCode).toBe(500);
    expect(data(failure).error?.code).toBe('INTERNAL_ERROR');
    expect(getSignedCookies).not.toHaveBeenCalled();
  });

  it('rejects a cookie request without a forwarded CloudFront host', async () => {
    const noHost = makeEvent('POST', '/files/cookies');
    noHost.headers = { 'X-Auth-Token': 'access-token' };
    const handler = createApiHandler({ env, clients, authenticate: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'name', role: 'viewer' }) });
    const response = await handler(noHost);
    expect(response.statusCode).toBe(500);
    expect(data(response).error).toEqual({ code: 'INTERNAL_ERROR', message: '処理に失敗しました' });
    expect(getSignedCookies).not.toHaveBeenCalled();
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(0);
  });

  it('signs per-archive cookies for published archives only, except for admins (R1-08)', async () => {
    ddb.on(GetCommand, { Key: { PK: 'ARCHIVE', SK: 'pub' } }).resolves({ Item: archive('pub') });
    ddb.on(GetCommand, { Key: { PK: 'ARCHIVE', SK: 'priv' } }).resolves({ Item: archive('priv', { published: false }) });
    ddb.on(GetCommand, { Key: { PK: 'ARCHIVE', SK: 'old' } }).resolves({ Item: archive('old', { retainUntil: '2023-01-01T00:00:00.000Z' }) });
    const published = await request('viewer', 'POST', '/archives/pub/cookies');
    expect(published.statusCode).toBe(204);
    expect(published.cookies?.[0]).toBe('CloudFront-Policy=policy; Path=/files/archives/stage/pub/d/composite/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict');
    expect(JSON.parse((vi.mocked(getSignedCookies).mock.calls[0]?.[0] as { policy: string }).policy).Statement[0].Resource).toBe('https://example.cloudfront.net/files/archives/stage/pub/d/composite/*');
    expect((await request('viewer', 'POST', '/archives/priv/cookies')).statusCode).toBe(404);
    expect((await request('admin', 'POST', '/archives/priv/cookies')).statusCode).toBe(204);
    expect((await request('viewer', 'POST', '/archives/missing/cookies')).statusCode).toBe(404);
    expect((await request('admin', 'POST', '/archives/old/cookies')).statusCode).toBe(404);
    expect(getSignedCookies).toHaveBeenCalledTimes(2);
  });

  it.each([
    { Type: 'String', Value: 'not-secure' },
    { Type: 'SecureString', Value: undefined },
  ] as const)('rejects missing or non-SecureString CloudFront key parameters', async (Parameter) => {
    ssm.on(GetParameterCommand).resolves({ Parameter });
    const noCacheRequest = createApiHandler({ env, clients, authenticate: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'name', role: 'admin' }), now: () => Date.parse('2030-01-01T02:00:00Z') });
    const response = await noCacheRequest(makeEvent('POST', '/files/cookies'));
    expect(response.statusCode).toBe(500);
    expect(data(response).error).toEqual({ code: 'SIGNING_KEY_MISSING', message: 'SSM SecureString の署名鍵を取得できません' });
    expect(getSignedCookies).not.toHaveBeenCalled();
  });

  it('reuses the SecureString key before its 55-minute expiry and refreshes exactly at expiry', async () => {
    ddb.on(GetCommand, { Key: { PK: 'ARCHIVE', SK: 'pub' } }).resolves({ Item: archive('pub', { retainUntil: '2040-01-01T00:00:00.000Z' }) });
    const base = Date.parse('2030-01-01T00:00:00.000Z');
    const at = (now: number) => createApiHandler({
      env,
      clients,
      authenticate: vi.fn().mockResolvedValue({ userId: 'user-1', username: 'name', role: 'viewer' }),
      now: () => now,
    })(makeEvent('POST', '/archives/pub/cookies'));
    expect((await at(base)).statusCode).toBe(204);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect((await at(base + 10_000)).statusCode).toBe(204);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect((await at(base + 55 * 60 * 1000)).statusCode).toBe(204);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(2);
  });
});

describe('user management', () => {
  it('reports partial invite results and keeps going after failures (R1-11)', async () => {
    cognito.on(AdminCreateUserCommand)
      .resolvesOnce({ User: { Username: 'a' } })
      .rejectsOnce(awsError('UsernameExistsException'))
      .resolvesOnce({ User: {} })
      .rejectsOnce(awsError('InvalidParameterException'))
      .resolves({ User: { Username: 'e' } });
    const emails = ['a@example.test', 'b@example.test', 'c@example.test', 'd@example.test', 'e@example.test'];
    const response = await request('admin', 'POST', '/users/invite', { emails, role: 'viewer' });
    expect(response.statusCode).toBe(200);
    expect(UserInviteResponseSchema.parse(data(response))).toEqual({
      invited: ['a@example.test', 'e@example.test'],
      failed: [{ email: 'b@example.test', reason: 'ALREADY_EXISTS' }, { email: 'c@example.test', reason: 'FAILED' }, { email: 'd@example.test', reason: 'INVALID_PARAMETER' }],
    });
    expect(cognito.commandCalls(AdminAddUserToGroupCommand).map((call) => call.args[0].input.Username)).toEqual(['a', 'e']);
    const invalid = await request('admin', 'POST', '/users/invite', { emails: [], role: 'viewer' });
    expect(data(invalid).error?.code).toBe('VALIDATION_ERROR');
  });

  it('reports a failed group assignment as a failed invite', async () => {
    cognito.on(AdminAddUserToGroupCommand).rejects(awsError('InternalErrorException'));
    expect(data(await request('admin', 'POST', '/users/invite', { emails: ['a@example.test'], role: 'camera' }))).toEqual({ invited: [], failed: [{ email: 'a@example.test', reason: 'FAILED' }] });
  });

  it('deletes the created user when the group assignment fails so the address can be invited again (R2-02)', async () => {
    cognito.on(AdminAddUserToGroupCommand).rejectsOnce(awsError('InternalErrorException')).resolves({});
    const first = UserInviteResponseSchema.parse(data(await request('admin', 'POST', '/users/invite', { emails: ['a@example.test', 'b@example.test'], role: 'camera' })));
    expect(first).toEqual({ invited: ['b@example.test'], failed: [{ email: 'a@example.test', reason: 'FAILED' }] });
    expect(cognito.commandCalls(AdminDeleteUserCommand).map((call) => call.args[0].input)).toEqual([{ UserPoolId: 'pool', Username: 'new-user' }]);
  });

  it('reports CREATED_WITHOUT_ROLE and audits it when the compensation delete also fails (R2-02)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cognito.on(AdminAddUserToGroupCommand).rejects(awsError('InternalErrorException'));
    cognito.on(AdminDeleteUserCommand).rejects(awsError('TooManyRequestsException'));
    const response = UserInviteResponseSchema.parse(data(await request('admin', 'POST', '/users/invite', { emails: ['a@example.test'], role: 'camera' })));
    expect(response).toEqual({ invited: [], failed: [{ email: 'a@example.test', reason: 'CREATED_WITHOUT_ROLE' }] });
    expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
    const audits = info.mock.calls.map(([line]) => JSON.parse(String(line)) as { action: string; target?: string });
    expect(audits).toContainEqual(expect.objectContaining({ action: 'user.invite.created_without_role', target: 'new-user' }));
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)).error)).toContain('INVITE_COMPENSATION_FAILED');
    info.mockRestore(); error.mockRestore();
  });

  it('changes roles, signs the user out and invalidates issued access tokens (R1-09)', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'cognito-user', Attributes: [{ Name: 'sub', Value: 'target' }] }] });
    cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: 'admin' }, { GroupName: 'viewer' }] });
    expect(data(await request('admin', 'PUT', '/users/target/role', { role: 'viewer' }))).toEqual({ userId: 'target', role: 'viewer', enabled: true });
    expect(cognito.commandCalls(AdminRemoveUserFromGroupCommand).map((call) => call.args[0].input.GroupName)).toEqual(['admin', 'viewer']);
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)[0]?.args[0].input).toMatchObject({ Username: 'cognito-user', GroupName: 'viewer' });
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand)[0]?.args[0].input).toEqual({ UserPoolId: 'pool', Username: 'cognito-user' });
    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.Item).toEqual({ PK: 'USER#target', SK: 'AUTH', tokenValidAfter: NOW_S });
  });

  it('disables, enables and deletes users and revokes tokens on disable and delete', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'cognito-user', Attributes: [{ Name: 'sub', Value: 'target' }] }] });
    expect((await request('admin', 'POST', '/users/target/disable')).statusCode).toBe(200);
    expect(cognito.commandCalls(AdminDisableUserCommand)).toHaveLength(1);
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(1);
    expect((await request('admin', 'POST', '/users/target/enable')).statusCode).toBe(200);
    expect(cognito.commandCalls(AdminEnableUserCommand)).toHaveLength(1);
    expect((await request('admin', 'DELETE', '/users/target')).statusCode).toBe(200);
    expect(cognito.commandCalls(AdminDeleteUserCommand)[0]?.args[0].input.Username).toBe('cognito-user');
    expect(ddb.commandCalls(PutCommand).map((call) => call.args[0].input.Item)).toEqual([
      { PK: 'USER#target', SK: 'AUTH', tokenValidAfter: NOW_S },
      { PK: 'USER#target', SK: 'AUTH', tokenValidAfter: NOW_S },
    ]);
  });

  it('resends the invitation only to users who have not set their first password (R3-13)', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'cognito-user', Attributes: [{ Name: 'sub', Value: 'target' }] }] });
    cognito.on(AdminGetUserCommand).resolves({ Username: 'cognito-user', UserStatus: 'FORCE_CHANGE_PASSWORD' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const resent = await request('admin', 'POST', '/users/target/resend-invite');
    expect(resent.statusCode).toBe(200);
    expect(data(resent)).toEqual({ success: true });
    expect(cognito.commandCalls(AdminCreateUserCommand).map((call) => call.args[0].input)).toEqual([{ UserPoolId: 'pool', Username: 'cognito-user', MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }]);
    expect(info.mock.calls.at(-1)?.[0]).toContain('"action":"user.invite.resend"');
    cognito.on(AdminGetUserCommand).resolves({ Username: 'cognito-user', UserStatus: 'CONFIRMED' });
    const confirmed = await request('admin', 'POST', '/users/target/resend-invite');
    expect(confirmed.statusCode).toBe(409);
    expect(data(confirmed).error).toEqual({ code: 'INVITE_NOT_PENDING', message: 'このユーザーはすでにパスワードを設定済みです' });
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(1);
    expect((await request('viewer', 'POST', '/users/target/resend-invite')).statusCode).toBe(403);
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    expect((await request('admin', 'POST', '/users/unknown/resend-invite')).statusCode).toBe(404);
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(1);
    info.mockRestore();
  });

  it.each([
    ['PUT', '/users/user-1/role', { role: 'viewer' }],
    ['POST', '/users/user-1/disable', undefined],
    ['DELETE', '/users/user-1', undefined],
  ] as const)('refuses %s %s on the caller itself (R1-19)', async (method, path, body) => {
    const response = await request('admin', method, path, body);
    expect(response.statusCode).toBe(400);
    expect(data(response).error).toEqual({ code: 'CANNOT_MODIFY_SELF', message: '自分自身のアカウントは変更できません' });
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(0);
    expect(cognito.commandCalls(AdminDisableUserCommand)).toHaveLength(0);
    expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
  });

  it('lists users with one group listing per role and batched DynamoDB reads (R1-24)', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [
      { Username: 'c-user', Enabled: true, UserStatus: 'FORCE_CHANGE_PASSWORD', Attributes: [{ Name: 'sub', Value: 'target' }, { Name: 'email', Value: 'target@example.test' }] },
      { Username: 'okta_x', Enabled: false, Attributes: [{ Name: 'sub', Value: 'okta' }, { Name: 'email', Value: 'okta@example.test' }, { Name: 'identities', Value: '[{"providerName":"Okta"}]' }] },
      { Username: 'multi', Enabled: true, Attributes: [{ Name: 'sub', Value: 'multi' }, { Name: 'email', Value: 'multi@example.test' }] },
    ] });
    cognito.on(ListUsersInGroupCommand).callsFake(async ({ GroupName }) => ({ Users: GroupName === 'admin' ? [{ Username: 'c-user' }, { Username: 'multi' }] : GroupName === 'camera' ? [{ Username: 'okta_x' }, { Username: 'multi' }] : [] }));
    ddb.on(BatchGetCommand).resolves({ Responses: { table: [{ PK: 'USER#target', SK: 'PROFILE', commentSuspended: true }, { PK: 'USER#target', SK: 'LOGIN', lastLoginAt: '2026-01-01T00:00:00.000Z', loginMethod: 'email' }] } });
    const users = UsersResponseSchema.parse(data(await request('admin', 'GET', '/users')));
    expect(users).toEqual([
      { userId: 'target', email: 'target@example.test', loginMethod: 'email', role: 'admin', enabled: true, commentSuspended: true, lastLoginAt: '2026-01-01T00:00:00.000Z', invitePending: true },
      { userId: 'okta', email: 'okta@example.test', loginMethod: 'Okta', role: 'camera', enabled: false, commentSuspended: false, lastLoginAt: null, invitePending: false },
      // 複数ロールは viewer と偽らず要修復（null）として返す（R2-04）
      { userId: 'multi', email: 'multi@example.test', loginMethod: 'email', role: null, enabled: true, commentSuspended: false, lastLoginAt: null, invitePending: false },
    ]);
    expect(cognito.commandCalls(ListUsersInGroupCommand).map((call) => call.args[0].input.GroupName)).toEqual(['admin', 'camera', 'audio', 'presenter', 'viewer']);
    expect(cognito.commandCalls(AdminListGroupsForUserCommand)).toHaveLength(0);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddb.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.table?.Keys).toHaveLength(6);
  });

  it('follows Cognito user and group pagination using exact request tokens', async () => {
    cognito.on(ListUsersCommand)
      .resolvesOnce({ Users: [{ Username: 'first', Attributes: [{ Name: 'sub', Value: 'u1' }, { Name: 'email', Value: 'one@example.test' }] }], PaginationToken: 'users-next' })
      .resolves({ Users: [{ Username: 'second', Attributes: [{ Name: 'sub', Value: 'u2' }, { Name: 'email', Value: 'two@example.test' }] }] });
    cognito.on(ListUsersInGroupCommand).callsFake(async ({ GroupName, NextToken }) => {
      if (GroupName === 'admin' && !NextToken) return { Users: [{ Username: 'first' }], NextToken: 'admin-next' };
      if (GroupName === 'admin' && NextToken === 'admin-next') return { Users: [{ Username: 'second' }] };
      return { Users: [] };
    });
    const result = UsersResponseSchema.parse(data(await request('admin', 'GET', '/users')));
    expect(result.map(({ userId, role }) => ({ userId, role }))).toEqual([{ userId: 'u1', role: 'admin' }, { userId: 'u2', role: 'admin' }]);
    expect(cognito.commandCalls(ListUsersCommand).map((call) => call.args[0].input)).toEqual([
      { UserPoolId: 'pool', PaginationToken: undefined, Limit: 60 },
      { UserPoolId: 'pool', PaginationToken: 'users-next', Limit: 60 },
    ]);
    expect(cognito.commandCalls(ListUsersInGroupCommand).map((call) => call.args[0].input)).toEqual([
      { UserPoolId: 'pool', GroupName: 'admin', NextToken: undefined, Limit: 60 },
      { UserPoolId: 'pool', GroupName: 'admin', NextToken: 'admin-next', Limit: 60 },
      ...['camera', 'audio', 'presenter', 'viewer'].map((GroupName) => ({ UserPoolId: 'pool', GroupName, NextToken: undefined, Limit: 60 })),
    ]);
  });

  it('returns a null role for users without any role group (R2-04)', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'none', Enabled: true, Attributes: [{ Name: 'sub', Value: 'none' }, { Name: 'email', Value: 'none@example.test' }] }] });
    const users = UsersResponseSchema.parse(data(await request('admin', 'GET', '/users')));
    expect(users.map((item) => item.role)).toEqual([null]);
  });

  it('sends exactly one BatchGet request for exactly 100 profile records', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: Array.from({ length: 50 }, (_, index) => ({ Username: `u${index}`, Attributes: [{ Name: 'sub', Value: `s${index}` }] })) });
    ddb.on(BatchGetCommand).resolves({ Responses: { table: [] } });
    const response = await request('admin', 'GET', '/users');
    expect(response.statusCode).toBe(200);
    expect(ddb.commandCalls(BatchGetCommand).map((call) => call.args[0].input.RequestItems?.table?.Keys)).toEqual([
      Array.from({ length: 100 }, (_, index) => ({ PK: `USER#s${Math.floor(index / 2)}`, SK: index % 2 === 0 ? 'PROFILE' : 'LOGIN' })),
    ]);
  });

  it('chunks BatchGet requests at 100 keys and retries unprocessed keys', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: Array.from({ length: 51 }, (_, index) => ({ Username: `u${index}`, Attributes: [{ Name: 'sub', Value: `s${index}` }, { Name: 'email', Value: `u${index}@example.test` }] })) });
    ddb.on(BatchGetCommand).resolvesOnce({ Responses: { table: [] }, UnprocessedKeys: { table: { Keys: [{ PK: 'USER#s0', SK: 'PROFILE' }] } } }).resolves({ Responses: { table: [] } });
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const pending = request('admin', 'GET', '/users');
    await vi.runAllTimersAsync();
    expect((await pending).statusCode).toBe(200);
    expect(ddb.commandCalls(BatchGetCommand).map((call) => call.args[0].input.RequestItems?.table?.Keys?.length)).toEqual([100, 1, 2]);
    expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([100]);
    expect(vi.getTimerCount()).toBe(0);
    timers.mockRestore();
    vi.useRealTimers();
  });

  it('fails after five BatchGet attempts and reports an internal error', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'u0', Attributes: [{ Name: 'sub', Value: 's0' }] }] });
    ddb.on(BatchGetCommand).callsFake(async (input) => ({ UnprocessedKeys: input.RequestItems }));
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const pending = request('admin', 'GET', '/users');
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response.statusCode).toBe(500);
    expect(data(response).error).toEqual({ code: 'INTERNAL_ERROR', message: '処理に失敗しました' });
    expect(ddb.commandCalls(BatchGetCommand)).toHaveLength(5);
    expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([100, 200, 400, 800]);
    timers.mockRestore();
    vi.useRealTimers();
  });
});
