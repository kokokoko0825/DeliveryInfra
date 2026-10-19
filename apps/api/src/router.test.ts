import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CreateParticipantTokenCommand, GetStageCommand, ListParticipantsCommand, ListStageSessionsCommand, StartCompositionCommand, StopCompositionCommand } from '@aws-sdk/client-ivs-realtime';
import { CreateChatTokenCommand, DeleteMessageCommand, DisconnectUserCommand, GetRoomCommand, SendEventCommand } from '@aws-sdk/client-ivschat';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand, AdminEnableUserCommand, AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand, AdminUserGlobalSignOutCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
vi.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: vi.fn(async () => ({ url: 'https://upload.example.test', fields: { key: 'slide.pdf' } })) }));
vi.mock('@aws-sdk/cloudfront-signer', () => ({ getSignedCookies: vi.fn(() => ({ 'CloudFront-Policy': 'policy', 'CloudFront-Signature': 'signature', 'CloudFront-Key-Pair-Id': 'pair' })) }));
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
  ddb.on(GetCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
  ddb.on(DeleteCommand).resolves({});
  ddb.on(PutCommand).resolves({});
  ivs.on(StartCompositionCommand).resolves({ composition: { arn: 'composition-arn', stageArn: 'broadcast', state: 'ACTIVE', layout: {}, destinations: [{ id: 'destination-id', state: 'ACTIVE', configuration: {}, detail: { s3: { recordingPrefix: 'stage/session/destination/composite' } } } as never] } });
  ivs.on(GetStageCommand).resolves({ stage: { arn: 'broadcast', activeSessionId: 'session-1' } });
  ivs.on(ListParticipantsCommand).resolves({ participants: [] });
  ivs.on(ListStageSessionsCommand).resolves({ stageSessions: [] });
  ivs.on(StopCompositionCommand).resolves({});
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
  cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [] });
  cognito.on(AdminRemoveUserFromGroupCommand).resolves({});
  cognito.on(AdminDisableUserCommand).resolves({});
  cognito.on(AdminEnableUserCommand).resolves({});
  cognito.on(AdminUserGlobalSignOutCommand).resolves({});
  cognito.on(AdminDeleteUserCommand).resolves({});
  cognito.on(ListUsersCommand).resolves({ Users: [] });
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

describe('API router endpoint behavior', () => {
  interface Payload { error?: { code: string; message: string }; [key: string]: unknown }
  const data = (response: { body: string }): Payload => JSON.parse(response.body) as Payload;

  it('returns a complete profile and detects normalized NG display names', async () => {
    ddb.on(GetCommand).resolves({ Item: { displayName: 'Kos', commentSuspended: true } });
    await expect(request('viewer', 'GET', '/me')).resolves.toMatchObject({ statusCode: 200, body: JSON.stringify({ userId: 'user-1', email: 'user@example.test', role: 'viewer', loginMethod: 'email', displayName: 'Kos', commentSuspended: true }) });
    ddb.on(ScanCommand).resolves({ Items: [{ word: 'bad' }] });
    const blocked = await request('viewer', 'PUT', '/me/display-name', { displayName: 'ＢＡＤ' });
    expect(blocked.statusCode).toBe(400);
    expect(data(blocked).error).toMatchObject({ code: 'NG_WORD', message: '使用できない単語が含まれています' });
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
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues).toMatchObject({ ':recordingPrefix': 'stage/session/destination/composite' });
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
  });

  it('stops only a live broadcast and reports the stopped record', async () => {
    ddb.on(GetCommand).resolves({ Item: { id: 'b-1', title: '大会', status: 'live', compositionArn: 'composition-arn', startedAt: '2026-01-01T00:00:00.000Z' } });
    const stopped = await request('admin', 'POST', '/broadcast/stop');
    expect(ivs.commandCalls(StopCompositionCommand)[0]?.args[0].input.arn).toBe('composition-arn');
    expect(data(stopped)).toEqual({ id: 'b-1', title: '大会', status: 'ended', startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2023-11-14T22:13:20.000Z' });
    ddb.on(GetCommand).resolves({});
    expect(data(await request('admin', 'POST', '/broadcast/stop')).error).toMatchObject({ code: 'BROADCAST_NOT_LIVE', message: '配信中ではありません' });
  });

  it('counts connected subscribers across participant pages and returns zero without a session', async () => {
    let participantPage = 0;
    ivs.on(ListParticipantsCommand).callsFake(async () => { participantPage += 1; return participantPage === 1 ? { participants: [{ published: false }, { published: true }], nextToken: 'next' } : { participants: [{ published: false }] }; });
    expect(data(await request('admin', 'GET', '/broadcast/stats'))).toEqual({ viewerCount: 2 });
    expect(ivs.commandCalls(ListParticipantsCommand)[1]?.args[0].input.nextToken).toBe('next');
    ivs.on(GetStageCommand).resolves({ stage: { arn: 'broadcast' } });
    expect(data(await request('admin', 'GET', '/broadcast/stats'))).toEqual({ viewerCount: 0 });
  });

  it('reports operational status for available and failed stages and chat', async () => {
    ivs.on(GetStageCommand).callsFake(async ({ arn }) => arn === 'slide' ? Promise.reject(new Error('missing')) : ({ stage: { activeSessionId: arn === 'prod' ? 'active' : undefined } }));
    ivs.on(ListStageSessionsCommand).resolves({ stageSessions: [{ sessionId: 'idle-session' }] });
    chat.on(GetRoomCommand).rejects(new Error('chat missing'));
    const status = data(await request('admin', 'GET', '/status'));
    expect(status.stages).toEqual([{ name: 'production', exists: true, status: 'ACTIVE' }, { name: 'slide', exists: false }, { name: 'broadcast', exists: true, status: 'ACTIVE' }]);
    expect(status.chatRoom).toEqual({ exists: false });
  });

  it('lists active devices and enforces heartbeat ownership and release rules', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ PK: 'DEVICE#camera#1', SK: 'LEASE', deviceId: 'd-1', deviceName: 'CAM1', purpose: 'camera', userId: 'user-1', ttl: 1_700_000_010 }, { deviceId: 'old', ttl: 1_700_000_000 }] });
    expect(data(await request('admin', 'GET', '/devices'))).toEqual([{ deviceId: 'd-1', deviceName: 'CAM1', kind: 'camera', userId: 'user-1', connected: true }]);
    ddb.on(ScanCommand).resolves({ Items: [{ PK: 'DEVICE#camera#1', SK: 'LEASE', deviceId: 'd-1', userId: 'other' }] });
    expect(data(await request('viewer', 'POST', '/devices/d-1/heartbeat')).error).toMatchObject({ code: 'NOT_FOUND', message: '対象が見つかりません' });
    expect(data(await request('viewer', 'DELETE', '/devices/d-1')).error).toMatchObject({ code: 'FORBIDDEN', message: 'この操作を行う権限がありません' });
    expect((await request('admin', 'DELETE', '/devices/d-1')).statusCode).toBe(200);
  });

  it('issues chat tokens according to suspension and admin capabilities', async () => {
    ddb.on(GetCommand).resolves({ Item: { displayName: 'Kos', commentSuspended: true } });
    expect(data(await request('viewer', 'POST', '/tokens/chat'))).toEqual({ token: 'chat-token', capabilities: [] });
    expect(data(await request('admin', 'POST', '/tokens/chat'))).toEqual({ token: 'chat-token', capabilities: ['SEND_MESSAGE', 'DELETE_MESSAGE', 'DISCONNECT_USER'] });
  });

  it('returns at most 100 recent comments in descending time order and excludes deleted records', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ messageId: 'old', userId: 'u', displayName: 'A', comment: 'old', sentAt: '2026-01-01T00:00:00.000Z', deleted: false }, { messageId: 'new', userId: 'u', displayName: 'A', comment: 'new', sentAt: '2026-01-02T00:00:00.000Z', deleted: false }, { messageId: 'gone', userId: 'u', displayName: 'A', comment: 'gone', sentAt: '2026-01-03T00:00:00.000Z', deleted: true }] });
    expect(data(await request('viewer', 'GET', '/comments/recent'))).toEqual([{ messageId: 'new', userId: 'u', displayName: 'A', comment: 'new', sentAt: '2026-01-02T00:00:00.000Z', deleted: false }, { messageId: 'old', userId: 'u', displayName: 'A', comment: 'old', sentAt: '2026-01-01T00:00:00.000Z', deleted: false }]);
  });

  it('moderates and suspends chat users with the matching IVS commands', async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: 'COMMENT#m-1', SK: 'ITEM', messageId: 'm-1' } });
    expect((await request('admin', 'DELETE', '/comments/m-1')).statusCode).toBe(200);
    expect(chat.commandCalls(DeleteMessageCommand)[0]?.args[0].input).toMatchObject({ id: 'm-1', reason: '管理者による削除' });
    expect((await request('admin', 'PUT', '/users/u-2/comment-suspension', { suspended: true })).statusCode).toBe(200);
    expect(chat.commandCalls(DisconnectUserCommand)[0]?.args[0].input).toMatchObject({ userId: 'u-2', reason: 'コメント送信停止' });
    expect((await request('admin', 'PUT', '/users/u-2/comment-suspension', { suspended: false })).statusCode).toBe(200);
  });

  it('exports CSV with BOM, quotes and formula-injection escaping', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ sentAt: '2026-01-01T00:00:00Z', userId: 'u', displayName: '=HYPERLINK("x")', comment: '+1' }, { sentAt: '2026-01-02T00:00:00Z', userId: 'u2', displayName: 'A', comment: 'text' }] });
    const response = await request('admin', 'GET', '/comments/export');
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.body).toBe(`\uFEFF日時,ユーザーID,表示名,コメント\r\n"2026-01-01T00:00:00Z","u","'=HYPERLINK(""x"")","'+1"\r\n"2026-01-02T00:00:00Z","u2","A","text"`);
  });

  it('lists and mutates NG words with validation and exact keys', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ word: 'zeta' }, { word: 'alpha' }] });
    expect(data(await request('admin', 'GET', '/ng-words'))).toEqual(['alpha', 'zeta']);
    expect((await request('admin', 'POST', '/ng-words', { word: ' blocked ' })).statusCode).toBe(200);
    expect(ddb.commandCalls(PutCommand).at(-1)?.args[0].input.Item).toMatchObject({ PK: 'NGWORD#blocked', SK: 'ITEM', word: 'blocked' });
    expect((await request('admin', 'DELETE', '/ng-words/blocked')).statusCode).toBe(200);
    expect(ddb.commandCalls(DeleteCommand).at(-1)?.args[0].input.Key).toEqual({ PK: 'NGWORD#blocked', SK: 'ITEM' });
    const invalid = await request('admin', 'POST', '/ng-words', { word: '' });
    expect(data(invalid).error?.code).toBe('VALIDATION_ERROR');
    expect(data(invalid).error?.message).toContain('String must contain at least 1 character(s)');
  });

  it('lists published slides and completes only a valid uploaded PDF', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ id: 's-2', title: 'second', fileName: 'b.pdf', size: 100, order: 2, published: true }, { id: 's-1', title: 'first', fileName: 'a.pdf', size: 100, order: 1, published: true }, { id: 'hidden', published: false }] });
    expect(data(await request('viewer', 'GET', '/slides'))).toEqual([{ id: 's-1', title: 'first', fileName: 'a.pdf', size: 100, order: 1, filePath: '/files/slides/s-1.pdf' }, { id: 's-2', title: 'second', fileName: 'b.pdf', size: 100, order: 2, filePath: '/files/slides/s-2.pdf' }]);
    ddb.on(GetCommand).resolves({ Item: { id: 's-1', key: 'slides/s-1.pdf', size: 100 } });
    const completed = await request('admin', 'POST', '/slides/s-1/complete');
    expect(completed.statusCode).toBe(200);
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
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues).toEqual({ ':title': 'after' });
    expect((await request('admin', 'PUT', '/slides/order', { ids: ['s-1', 's-2'] })).statusCode).toBe(200);
    expect(ddb.commandCalls(UpdateCommand).slice(1).map((call) => call.args[0].input.ExpressionAttributeValues?.[':order'])).toEqual([0, 1]);
    expect((await request('admin', 'DELETE', '/slides/s-1')).statusCode).toBe(200);
    expect(s3.commandCalls(DeleteObjectsCommand).at(-1)?.args[0].input.Delete?.Objects).toEqual([{ Key: 'slides/s-1.pdf' }]);
    expect(chat.commandCalls(SendEventCommand).map((call) => call.args[0].input.eventName)).toEqual(['slides-updated', 'slides-updated']);
  });

  it('filters private archives for viewers and exposes the actual recording prefix to admins', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ id: 'a-1', title: 'private', published: false, durationSeconds: 30, s3Prefix: 'stage/s/d/composite' }, { id: 'a-2', title: 'public', published: true, durationSeconds: 40, s3Prefix: 'stage/s2/d/composite' }] });
    expect(data(await request('viewer', 'GET', '/archives'))).toEqual([{ id: 'a-2', title: 'public', published: true, durationSeconds: 40, playbackPath: '/files/archives/stage/s2/d/composite/media/hls/multivariant.m3u8' }]);
    expect((data(await request('admin', 'GET', '/archives')) as unknown as unknown[]).length).toBe(2);
  });

  it('updates and deletes archives from their original S3 prefix', async () => {
    ddb.on(GetCommand).resolves({ Item: { id: 'a-1', s3Prefix: 'stage/s/d/composite', title: 'old' } });
    const updated = await request('admin', 'PATCH', '/archives/a-1', { title: 'new', published: true });
    expect(data(updated)).toMatchObject({ id: 'a-1', title: 'old', published: false });
    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input.UpdateExpression).toContain('title = :title, published = :published');
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'stage/s/d/composite/file.m3u8' }] });
    expect((await request('admin', 'DELETE', '/archives/a-1')).statusCode).toBe(200);
    expect(s3.commandCalls(ListObjectsV2Command)[0]?.args[0].input).toMatchObject({ Bucket: 'recording', Prefix: 'stage/s/d/composite' });
  });

  it('signs private file cookies only for validated CloudFront hosts', async () => {
    const response = await request('viewer', 'POST', '/files/cookies');
    expect(response.statusCode).toBe(204);
    expect(response.cookies).toEqual(['CloudFront-Policy=policy; Path=/files/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax', 'CloudFront-Signature=signature; Path=/files/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax', 'CloudFront-Key-Pair-Id=pair; Path=/files/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax']);
    const invalidHost = makeEvent('POST', '/files/cookies');
    invalidHost.headers = { 'X-Auth-Token': 'token', 'x-forwarded-host': 'attacker.example.test' };
    const failure = await createApiHandler({ env, clients, authenticate: vi.fn().mockResolvedValue({ userId: 'user-1', email: '', role: 'viewer', loginMethod: 'email' }) })(invalidHost);
    expect(failure.statusCode).toBe(500);
    expect(data(failure).error?.code).toBe('INTERNAL_ERROR');
  });

  it('invites users, requires a returned username, and validates the invite limit', async () => {
    const invited = await request('admin', 'POST', '/users/invite', { emails: ['a@example.test', 'b@example.test'], role: 'viewer' });
    expect(data(invited)).toEqual({ invited: ['a@example.test', 'b@example.test'] });
    expect(cognito.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(2);
    const invalid = await request('admin', 'POST', '/users/invite', { emails: [], role: 'viewer' });
    expect(data(invalid).error?.code).toBe('VALIDATION_ERROR');
    cognito.on(AdminCreateUserCommand).resolves({ User: {} });
    expect(data(await request('admin', 'POST', '/users/invite', { emails: ['c@example.test'], role: 'viewer' })).error).toMatchObject({ code: 'INVITE_FAILED', message: 'ユーザーを作成できませんでした' });
  });

  it('manages roles and account status with Cognito admin operations', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'cognito-user', Attributes: [{ Name: 'sub', Value: 'target' }] }] });
    cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: 'camera' }, { GroupName: 'viewer' }] });
    expect(data(await request('admin', 'PUT', '/users/target/role', { role: 'presenter' }))).toEqual({ userId: 'target', role: 'presenter', enabled: true });
    expect(cognito.commandCalls(AdminRemoveUserFromGroupCommand).map((call) => call.args[0].input.GroupName)).toEqual(['camera', 'viewer']);
    expect((await request('admin', 'POST', '/users/target/disable')).statusCode).toBe(200);
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand)).toHaveLength(1);
    expect((await request('admin', 'POST', '/users/target/enable')).statusCode).toBe(200);
    expect((await request('admin', 'DELETE', '/users/target')).statusCode).toBe(200);
    expect(cognito.commandCalls(AdminDeleteUserCommand)[0]?.args[0].input.Username).toBe('cognito-user');
  });

  it('returns users with roles, status, login metadata, and comment suspension', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'c-user', Enabled: true, Attributes: [{ Name: 'sub', Value: 'target' }, { Name: 'email', Value: 'target@example.test' }] }] });
    cognito.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: 'admin' }] });
    ddb.on(GetCommand).callsFake(async ({ Key }) => Key?.SK === 'PROFILE' ? { Item: { commentSuspended: true } } : { Item: { lastLoginAt: '2026-01-01T00:00:00Z', loginMethod: 'Okta' } });
    expect(data(await request('admin', 'GET', '/users'))).toEqual([{ userId: 'target', email: 'target@example.test', loginMethod: 'Okta', role: 'admin', enabled: true, commentSuspended: true, lastLoginAt: '2026-01-01T00:00:00Z' }]);
  });
});
