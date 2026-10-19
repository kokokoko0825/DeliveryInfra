import { randomUUID } from 'node:crypto';
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand,
  AdminEnableUserCommand, AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand, ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CreateParticipantTokenCommand, GetStageCommand, ListParticipantsCommand, ListStageSessionsCommand,
  type ParticipantTokenCapability,
  StartCompositionCommand, StopCompositionCommand,
} from '@aws-sdk/client-ivs-realtime';
import { CreateChatTokenCommand, DeleteMessageCommand, DisconnectUserCommand, GetRoomCommand, SendEventCommand, type ChatTokenCapability } from '@aws-sdk/client-ivschat';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  ArchiveIdParamsSchema, ArchiveUpdateRequestSchema, BroadcastStartRequestSchema, canAccess, canRequestPurpose,
  ChatCustomEventSchema, CommentSuspensionRequestSchema, containsNgWord, DeviceIdParamsSchema,
  DisplayNameRequestSchema, InviteUsersRequestSchema, MessageIdParamsSchema, NgWordSchema,
  NgWordRequestSchema, RecentCommentsResponseSchema, RoleSchema, SlideIdParamsSchema, SlideOrderRequestSchema,
  SlideUploadSchema, SlideUpdateRequestSchema, StageTokenRequestSchema, UserIdParamsSchema,
  UpdateRoleRequestSchema, SLIDE_MAX_BYTES, STAGE_LIMITS, TOKEN_TTL_SECONDS,
  type Feature, type Role, type StagePurpose,
} from '@delivery/shared';
import { authenticate, type Principal } from './auth';
import { createClients, type Clients } from './aws';
import { Database, makeDatabase, type Entity } from './database';
import { getEnv, type Env } from './env';
import { badRequest, conflict, forbidden, HttpError, notFound } from './errors';

export interface FunctionUrlEvent {
  version?: string;
  routeKey?: string;
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string; path: string; sourceIp?: string; userAgent?: string } };
}
export interface LambdaResponse { statusCode: number; headers: Record<string, string>; body: string; cookies?: string[] }
interface ApiDependencies { env: Env; clients: Clients; authenticate?: typeof authenticate; now?: () => number }
type JsonRecord = Record<string, unknown>;

const PK = {
  user: (id: string) => `USER#${id}`,
  device: (purpose: string, slot: number) => `DEVICE#${purpose}#${slot}`,
  comment: (id: string) => `COMMENT#${id}`,
  slide: (id: string) => `SLIDE#${id}`,
  archive: (id: string) => `ARCHIVE#${id}`,
} as const;
const roles: readonly Role[] = ['admin', 'camera', 'audio', 'presenter', 'viewer'];
let signingKeyCache: { value: string; expiresAt: number } | undefined;
const adminFeature = (principal: Principal, feature: Feature) => { if (!canAccess(principal.role, feature)) throw forbidden(); };
const audit = (principal: Principal, action: string, target?: string) => console.info(JSON.stringify({ audit: true, userId: principal.userId, action, target, at: new Date().toISOString() }));
const json = (statusCode: number, data: unknown, headers: Record<string, string> = {}): LambdaResponse => ({
  statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(data),
});
const success = (data: unknown = { success: true }) => json(200, data);
const valid = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { issues: { message: string }[] } } }, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(result.error?.issues.map((issue) => issue.message).join('、') || '入力内容を確認してください');
  return result.data as T;
};
const objectBody = (event: FunctionUrlEvent): unknown => {
  if (!event.body) return {};
  try { return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body); }
  catch { throw badRequest('JSON の形式が不正です'); }
};
const pathParts = (path: string) => path.split('/').filter(Boolean).map(decodeURIComponent);
const iso = (ms: number) => new Date(ms).toISOString();
const entity = (pk: string, sk: string, extra: JsonRecord = {}): Entity => ({ PK: pk, SK: sk, ...extra });
const failureResponse = (error: unknown): LambdaResponse => {
  const err = error instanceof HttpError ? error : new HttpError(500, 'INTERNAL_ERROR', '処理に失敗しました');
  if (err.statusCode >= 500) console.error(JSON.stringify({ error: err.code, message: error instanceof Error ? error.message : String(error) }));
  return json(err.statusCode, { error: { code: err.code, message: err.message } });
};

export function createApiHandler(dependencies?: Partial<ApiDependencies>) {
  let envValue = dependencies?.env;
  let clientsValue = dependencies?.clients;
  let dbValue: Database | undefined;
  const getEnvValue = () => envValue ??= getEnv();
  const getClients = () => clientsValue ??= createClients(getEnvValue());
  const getDb = () => dbValue ??= makeDatabase(getClients().ddb, getEnvValue());
  const now = dependencies?.now ?? Date.now;
  const auth = dependencies?.authenticate ?? authenticate;

  async function sendChatEvent(eventName: string, attributes: Record<string, string> = {}) {
    const validated = valid(ChatCustomEventSchema, { eventName, attributes });
    await getClients().chat.send(new SendEventCommand({
      roomIdentifier: getEnvValue().CHAT_ROOM_ARN,
      eventName: validated.eventName,
      attributes: validated.attributes,
    }));
  }

  async function storeDevice(principal: Principal, purpose: StagePurpose, deviceName: string): Promise<{ deviceId: string; slot: number }> {
    const limit = purpose === 'camera' ? STAGE_LIMITS.camera : purpose === 'mic' ? STAGE_LIMITS.mic : purpose === 'switcher' ? STAGE_LIMITS.switcher : STAGE_LIMITS.slide;
    const deviceId = randomUUID();
    const ttl = Math.floor(now() / 1000) + 45;
    for (let slot = 1; slot <= limit; slot += 1) {
      try {
        await getClients().ddb.send(new PutCommand({
          TableName: getEnvValue().TABLE_NAME,
          Item: entity(PK.device(purpose, slot), 'LEASE', { deviceId, purpose, deviceName, userId: principal.userId, ttl, createdAt: iso(now()) }),
          ConditionExpression: 'attribute_not_exists(PK) OR #ttl < :now',
          ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':now': Math.floor(now() / 1000) },
        }));
        return { deviceId, slot };
      } catch (error) {
        if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
      }
    }
    throw conflict('DEVICE_LIMIT', '送信端末の上限に達しています');
  }

  async function issueStageToken(principal: Principal, purpose: StagePurpose, deviceName?: string) {
    if (!canRequestPurpose(principal.role, purpose)) throw forbidden();
    const capabilitiesByPurpose: Record<StagePurpose, { stages: [string, string, ParticipantTokenCapability][]; deviceKind?: string }> = {
      viewer: { stages: [['broadcast', getEnvValue().STAGE_BROADCAST_ARN, 'SUBSCRIBE']] },
      camera: { stages: [['production', getEnvValue().STAGE_PRODUCTION_ARN, 'PUBLISH']], deviceKind: 'camera' },
      mic: { stages: [['production', getEnvValue().STAGE_PRODUCTION_ARN, 'PUBLISH']], deviceKind: 'mic' },
      slide: { stages: [['slide', getEnvValue().STAGE_SLIDE_ARN, 'PUBLISH']], deviceKind: 'slide' },
      switcher: { stages: [['production', getEnvValue().STAGE_PRODUCTION_ARN, 'SUBSCRIBE'], ['slide', getEnvValue().STAGE_SLIDE_ARN, 'SUBSCRIBE'], ['broadcast', getEnvValue().STAGE_BROADCAST_ARN, 'PUBLISH']], deviceKind: 'switcher' },
    };
    const config = capabilitiesByPurpose[purpose];
    const resolvedDeviceName = purpose === 'slide' ? 'SLIDE' : deviceName ?? purpose.toUpperCase();
    const device = config.deviceKind ? await storeDevice(principal, purpose, resolvedDeviceName) : undefined;
    try {
      const tokens = await Promise.all(config.stages.map(async ([stageName, stageArn, capability]) => {
        const attributes = config.deviceKind ? { kind: config.deviceKind, deviceName: resolvedDeviceName } : undefined;
        const result = await getClients().ivs.send(new CreateParticipantTokenCommand({
          stageArn, duration: TOKEN_TTL_SECONDS / 60, userId: principal.userId,
          capabilities: [capability], attributes,
        }));
        const token = result.participantToken;
        if (!token?.token || !token.participantId || !token.expirationTime) throw new HttpError(502, 'TOKEN_ISSUE_FAILED', '参加トークンを発行できませんでした');
        return { stage: stageName, token: token.token, participantId: token.participantId, capabilities: token.capabilities ?? [capability], expiresAt: token.expirationTime.toISOString() };
      }));
      return { tokens, ...(device ? { deviceId: device.deviceId } : {}) };
    } catch (error) {
      if (device) await getDb().delete(PK.device(purpose, device.slot), 'LEASE', 'deviceId = :deviceId', { ':deviceId': device.deviceId }).catch(() => undefined);
      throw error;
    }
  }

  async function getProfile(principal: Principal): Promise<JsonRecord> {
    const profile = await getDb().get<Entity & { displayName?: string; commentSuspended?: boolean }>(PK.user(principal.userId), 'PROFILE');
    return { userId: principal.userId, email: principal.email, role: principal.role, loginMethod: principal.loginMethod, displayName: profile?.displayName ?? null, commentSuspended: profile?.commentSuspended ?? false };
  }

  async function handle(event: FunctionUrlEvent): Promise<LambdaResponse> {
    const path = event.rawPath || event.requestContext.http.path;
    const method = event.requestContext.http.method.toUpperCase();
    const parts = pathParts(path);
    if (parts[0] !== 'api') return json(404, { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } });
    let principal: Principal;
    try {
      const headers = event.headers ?? {};
      const token = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-auth-token')?.[1];
      principal = await auth(token, getEnvValue());
      return await route(parts.slice(1), method, event, principal);
    } catch (error) { return failureResponse(error); }
  }

  async function route(parts: string[], method: string, event: FunctionUrlEvent, principal: Principal): Promise<LambdaResponse> {
    const path = `/${parts.join('/')}`;
    const body = objectBody(event);
    const db = getDb();
    const clients = getClients();

    if (path === '/me' && method === 'GET') return success(await getProfile(principal));
    if (path === '/me/display-name' && method === 'PUT') {
      const { displayName } = valid(DisplayNameRequestSchema, body);
      const words = await db.scan<Entity & { word: string }>('begins_with(PK, :pk)', { ':pk': 'NGWORD#' });
      if (containsNgWord(displayName, words.map((item) => item.word))) throw new HttpError(400, 'NG_WORD', '使用できない単語が含まれています');
      await db.update(PK.user(principal.userId), 'PROFILE', 'SET displayName = :name, updatedAt = :updatedAt', { ':name': displayName, ':updatedAt': iso(now()) });
      return success({ displayName });
    }
    if (path === '/broadcast' && method === 'GET') {
      const item = await db.get<Entity & JsonRecord>('BROADCAST', 'CURRENT');
      return success(item ? { id: item.id, title: item.title, status: item.status === 'starting' ? 'idle' : item.status, startedAt: item.startedAt ?? null, endedAt: item.endedAt ?? null } : null);
    }
    if (path === '/broadcast/start' && method === 'POST') {
      adminFeature(principal, 'broadcastManage');
      const { title } = valid(BroadcastStartRequestSchema, body);
      const startedAt = iso(now());
      const broadcastId = randomUUID();
      try {
        await db.put(entity('BROADCAST', 'CURRENT', { id: broadcastId, title, status: 'starting', startedAt }), 'attribute_not_exists(PK) OR #status = :ended', { ':ended': 'ended' }, { '#status': 'status' });
      } catch (error) {
        if ((error as { name?: string }).name === 'ConditionalCheckFailedException') throw conflict('BROADCAST_LIVE', '配信はすでに開始しています');
        throw error;
      }
      try {
        const start = await clients.ivs.send(new StartCompositionCommand({
          stageArn: getEnvValue().STAGE_BROADCAST_ARN,
          idempotencyToken: broadcastId,
          destinations: [{
            name: 'recording',
            s3: { storageConfigurationArn: getEnvValue().RECORDING_STORAGE_CONFIGURATION_ARN, encoderConfigurationArns: [getEnvValue().ENCODER_CONFIGURATION_ARN], recordingConfiguration: { hlsConfiguration: { targetSegmentDurationSeconds: 10 }, format: 'HLS' } },
          }],
        }));
        const compositionArn = start.composition?.arn;
        const recordingPrefix = start.composition?.destinations?.find((destination) => destination.detail?.s3?.recordingPrefix)?.detail?.s3?.recordingPrefix;
        await db.update('BROADCAST', 'CURRENT', 'SET #status = :live, compositionArn = :compositionArn, recordingPrefix = :recordingPrefix', { ':live': 'live', ':compositionArn': compositionArn ?? '', ':recordingPrefix': recordingPrefix ?? '', ':id': broadcastId }, 'id = :id', { '#status': 'status' });
        if (compositionArn) await db.put(entity(`COMPOSITION#${compositionArn}`, 'META', { broadcastId, title, startedAt, recordingPrefix }));
      } catch (error) {
        await db.delete('BROADCAST', 'CURRENT', 'id = :id', { ':id': broadcastId }).catch(() => undefined);
        throw error;
      }
      await sendChatEvent('broadcast-started');
      audit(principal, 'broadcast.start');
      return success({ id: broadcastId, title, status: 'live', startedAt, endedAt: null });
    }
    if (path === '/broadcast/stop' && method === 'POST') {
      adminFeature(principal, 'broadcastManage');
      const broadcast = await db.get<Entity & { status?: string; compositionArn?: string; id?: string; title?: string; startedAt?: string }>('BROADCAST', 'CURRENT');
      if (!broadcast || broadcast.status !== 'live') throw conflict('BROADCAST_NOT_LIVE', '配信中ではありません');
      if (broadcast.compositionArn) await clients.ivs.send(new StopCompositionCommand({ arn: broadcast.compositionArn }));
      const endedAt = iso(now());
      await db.update('BROADCAST', 'CURRENT', 'SET #status = :status, endedAt = :endedAt', { ':status': 'ended', ':endedAt': endedAt }, 'attribute_exists(PK)', { '#status': 'status' });
      await sendChatEvent('broadcast-ended');
      audit(principal, 'broadcast.stop', broadcast.id);
      return success({ id: broadcast.id, title: broadcast.title, status: 'ended', startedAt: broadcast.startedAt, endedAt });
    }
    if (path === '/broadcast/stats' && method === 'GET') {
      adminFeature(principal, 'broadcastManage');
      const activeStage = await clients.ivs.send(new GetStageCommand({ arn: getEnvValue().STAGE_BROADCAST_ARN }));
      const sessionId = activeStage.stage?.activeSessionId;
      if (!sessionId) return success({ viewerCount: 0 });
      let viewerCount = 0;
      let nextToken: string | undefined;
      do {
        const page = await clients.ivs.send(new ListParticipantsCommand({ stageArn: getEnvValue().STAGE_BROADCAST_ARN, sessionId, filterByState: 'CONNECTED', maxResults: 50, nextToken }));
        viewerCount += (page.participants ?? []).filter((participant) => !participant.published).length;
        nextToken = page.nextToken;
      } while (nextToken);
      return success({ viewerCount });
    }
    if (path === '/status' && method === 'GET') {
      adminFeature(principal, 'broadcastManage');
      const arns = [['production', getEnvValue().STAGE_PRODUCTION_ARN], ['slide', getEnvValue().STAGE_SLIDE_ARN], ['broadcast', getEnvValue().STAGE_BROADCAST_ARN]] as const;
      const stages = await Promise.all(arns.map(async ([name, stageArn]) => {
        try {
          const [stage, sessions] = await Promise.all([
            clients.ivs.send(new GetStageCommand({ arn: stageArn })),
            clients.ivs.send(new ListStageSessionsCommand({ stageArn, maxResults: 1 })),
          ]);
          return { name, exists: Boolean(stage.stage), status: stage.stage?.activeSessionId || sessions.stageSessions?.[0]?.sessionId ? 'ACTIVE' : 'IDLE' };
        }
        catch { return { name, exists: false }; }
      }));
      let chatRoom: { exists: boolean; status?: string };
      try { chatRoom = { exists: Boolean((await clients.chat.send(new GetRoomCommand({ identifier: getEnvValue().CHAT_ROOM_ARN }))).arn), status: 'ACTIVE' }; }
      catch { chatRoom = { exists: false }; }
      return success({ stages, chatRoom });
    }
    if (path === '/tokens/stage' && method === 'POST') {
      const request = valid(StageTokenRequestSchema, body);
      return success(await issueStageToken(principal, request.purpose, request.deviceName));
    }
    if (parts[0] === 'devices') {
      if (parts.length === 1 && method === 'GET') {
        adminFeature(principal, 'switcher');
        const devices = await db.scan<Entity & JsonRecord>('begins_with(PK, :prefix)', { ':prefix': 'DEVICE#' });
        const nowSeconds = Math.floor(now() / 1000);
        return success(devices.filter((d) => Number(d.ttl) > nowSeconds).map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, kind: d.purpose, userId: d.userId, connected: true })));
      }
      if (parts.length === 3 && parts[2] === 'heartbeat' && method === 'POST') {
        const { deviceId } = valid(DeviceIdParamsSchema, { deviceId: parts[1] });
        const [device] = await db.scan<Entity & JsonRecord>('deviceId = :id', { ':id': deviceId });
        if (!device || (device.userId !== principal.userId && principal.role !== 'admin')) throw notFound();
        await db.update(device.PK, device.SK, 'SET #ttl = :ttl', { ':ttl': Math.floor(now() / 1000) + 45, ':deviceId': deviceId }, 'deviceId = :deviceId', { '#ttl': 'ttl' });
        return success({ expiresAt: iso((Math.floor(now() / 1000) + 45) * 1000) });
      }
      if (parts.length === 2 && method === 'DELETE') {
        const { deviceId } = valid(DeviceIdParamsSchema, { deviceId: parts[1] });
        const [device] = await db.scan<Entity & JsonRecord>('deviceId = :id', { ':id': deviceId });
        if (!device) throw notFound();
        if (device.userId !== principal.userId && principal.role !== 'admin') throw forbidden();
        await db.delete(device.PK, device.SK, 'deviceId = :deviceId', { ':deviceId': deviceId });
        if (principal.role === 'admin') audit(principal, 'device.release', deviceId);
        return success();
      }
    }
    if (path === '/tokens/chat' && method === 'POST') {
      const profile = await db.get<Entity & { commentSuspended?: boolean; displayName?: string }>(PK.user(principal.userId), 'PROFILE');
      const capabilities: ChatTokenCapability[] = principal.role === 'admin' ? ['SEND_MESSAGE', 'DELETE_MESSAGE', 'DISCONNECT_USER'] : profile?.commentSuspended ? [] : ['SEND_MESSAGE'];
      const token = await clients.chat.send(new CreateChatTokenCommand({ roomIdentifier: getEnvValue().CHAT_ROOM_ARN, userId: principal.userId, capabilities, sessionDurationInMinutes: 60, attributes: { displayName: profile?.displayName ?? '' } }));
      return success({ token: token.token, capabilities });
    }
    if (path === '/comments/recent' && method === 'GET') {
      const comments = await db.scan<Entity & JsonRecord>('begins_with(PK, :prefix)', { ':prefix': 'COMMENT#' });
      const items = comments.filter((comment) => !comment.deleted).sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt))).slice(0, 100);
      return success(valid(RecentCommentsResponseSchema, items.map((comment) => ({ messageId: comment.messageId, userId: comment.userId, displayName: comment.displayName, comment: comment.comment, sentAt: comment.sentAt, deleted: false }))));
    }
    if (parts[0] === 'comments' && parts.length === 2 && method === 'DELETE') {
      adminFeature(principal, 'commentModeration');
      const { messageId } = valid(MessageIdParamsSchema, { messageId: parts[1] });
      const item = await db.get<Entity & JsonRecord>(PK.comment(messageId), 'ITEM');
      if (!item) throw notFound();
      await clients.chat.send(new DeleteMessageCommand({ roomIdentifier: getEnvValue().CHAT_ROOM_ARN, id: messageId, reason: '管理者による削除' }));
      await db.update(item.PK, item.SK, 'SET deleted = :deleted', { ':deleted': true });
      audit(principal, 'comment.delete', messageId);
      return success();
    }
    if (parts[0] === 'users' && parts[1] && parts[2] === 'comment-suspension' && method === 'PUT') {
      adminFeature(principal, 'commentModeration');
      const { userId } = valid(UserIdParamsSchema, { userId: parts[1] });
      const { suspended } = valid(CommentSuspensionRequestSchema, body);
      await db.update(PK.user(userId), 'PROFILE', 'SET commentSuspended = :suspended, updatedAt = :updatedAt', { ':suspended': suspended, ':updatedAt': iso(now()) });
      if (suspended) await clients.chat.send(new DisconnectUserCommand({ roomIdentifier: getEnvValue().CHAT_ROOM_ARN, userId, reason: 'コメント送信停止' }));
      audit(principal, 'comment.suspension', userId);
      return success();
    }
    if (path === '/comments/export' && method === 'GET') {
      adminFeature(principal, 'commentModeration');
      const comments = await db.scan<Entity & JsonRecord>('begins_with(PK, :prefix)', { ':prefix': 'COMMENT#' });
      const rows = comments.sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt))).map((c) => [c.sentAt, c.userId, c.displayName, c.comment].map(csvCell).join(','));
      return { statusCode: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="comments.csv"', 'cache-control': 'no-store' }, body: `\uFEFF日時,ユーザーID,表示名,コメント\r\n${rows.join('\r\n')}` };
    }
    if (path === '/ng-words' && method === 'GET') {
      adminFeature(principal, 'commentModeration');
      const words = await db.scan<Entity & { word: string }>('begins_with(PK, :prefix)', { ':prefix': 'NGWORD#' });
      return success(words.map((word) => word.word).sort());
    }
    if (path === '/ng-words' && method === 'POST') {
      adminFeature(principal, 'commentModeration');
      const { word } = valid(NgWordRequestSchema, body);
      await db.put(entity(`NGWORD#${word}`, 'ITEM', { word, createdAt: iso(now()) }));
      audit(principal, 'ng-word.create', word);
      return success({ word });
    }
    if (parts[0] === 'ng-words' && parts.length === 2 && method === 'DELETE') {
      adminFeature(principal, 'commentModeration');
      const word = valid(NgWordSchema, parts[1]);
      await db.delete(`NGWORD#${word}`, 'ITEM');
      audit(principal, 'ng-word.delete', word);
      return success();
    }
    if (path === '/slides' && method === 'GET') {
      const slides = await db.scan<Entity & JsonRecord>('begins_with(PK, :prefix)', { ':prefix': 'SLIDE#' });
      return success(slides.filter((slide) => slide.published).sort((a, b) => Number(a.order) - Number(b.order)).map(toSlide));
    }
    if (path === '/slides/upload-url' && method === 'POST') {
      adminFeature(principal, 'slideManage');
      const request = valid(SlideUploadSchema, body);
      const id = randomUUID();
      const key = `slides/${id}.pdf`;
      const post = await createPresignedPost(clients.s3, { Bucket: getEnvValue().CONTENT_BUCKET, Key: key, Expires: 300, Fields: { 'Content-Type': 'application/pdf' }, Conditions: [['content-length-range', 1, SLIDE_MAX_BYTES], ['eq', '$Content-Type', 'application/pdf']] });
      await db.put(entity(PK.slide(id), 'ITEM', { id, key, title: request.title, fileName: request.fileName, size: request.size, createdAt: iso(now()), createdBy: principal.userId, status: 'pending' }));
      audit(principal, 'slide.upload-url', id);
      return success({ slideId: id, url: post.url, fields: post.fields });
    }
    if (parts[0] === 'slides' && parts[1] && parts[2] === 'complete' && method === 'POST') {
      adminFeature(principal, 'slideManage');
      const { id } = valid(SlideIdParamsSchema, { id: parts[1] });
      const item = await db.get<Entity & JsonRecord>(PK.slide(id), 'ITEM');
      if (!item) throw notFound();
      const head = await clients.s3.send(new HeadObjectCommand({ Bucket: getEnvValue().CONTENT_BUCKET, Key: String(item.key) }));
      if (!head.ContentLength || head.ContentLength > SLIDE_MAX_BYTES || head.ContentLength !== item.size || head.ContentType !== 'application/pdf') throw badRequest('PDF のサイズまたは MIME タイプが一致しません');
      const object = await clients.s3.send(new GetObjectCommand({ Bucket: getEnvValue().CONTENT_BUCKET, Key: String(item.key), Range: 'bytes=0-4' }));
      const prefix = await object.Body?.transformToByteArray();
      if (!prefix || Buffer.from(prefix).toString('ascii') !== '%PDF-') throw badRequest('PDF ファイルとして読み取れません');
      await db.update(PK.slide(id), 'ITEM', 'SET published = :published, #status = :status, #order = :order', { ':published': true, ':status': 'ready', ':order': (await db.scan<Entity>('begins_with(PK, :prefix)', { ':prefix': 'SLIDE#' })).length }, undefined, { '#status': 'status', '#order': 'order' });
      await sendChatEvent('slides-updated');
      audit(principal, 'slide.complete', id);
      const updated = await db.get<Entity & JsonRecord>(PK.slide(id), 'ITEM');
      return success(toSlide(updated!));
    }
    if (parts[0] === 'slides' && parts[1] && method === 'PATCH') {
      adminFeature(principal, 'slideManage');
      const { id } = valid(SlideIdParamsSchema, { id: parts[1] });
      const { title } = valid(SlideUpdateRequestSchema, body);
      await db.update(PK.slide(id), 'ITEM', 'SET title = :title', { ':title': title }, 'attribute_exists(PK)');
      audit(principal, 'slide.update', id);
      const updated = await db.get<Entity & JsonRecord>(PK.slide(id), 'ITEM');
      return updated ? success(toSlide(updated)) : notFoundResponse();
    }
    if (path === '/slides/order' && method === 'PUT') {
      adminFeature(principal, 'slideManage');
      const { ids } = valid(SlideOrderRequestSchema, body);
      await Promise.all(ids.map((id, order) => db.update(PK.slide(id), 'ITEM', 'SET #order = :order', { ':order': order }, 'attribute_exists(PK)', { '#order': 'order' })));
      await sendChatEvent('slides-updated');
      audit(principal, 'slide.order');
      return success();
    }
    if (parts[0] === 'slides' && parts[1] && method === 'DELETE') {
      adminFeature(principal, 'slideManage');
      const { id } = valid(SlideIdParamsSchema, { id: parts[1] });
      const item = await db.get<Entity & JsonRecord>(PK.slide(id), 'ITEM');
      if (!item) throw notFound();
      await clients.s3.send(new DeleteObjectsCommand({ Bucket: getEnvValue().CONTENT_BUCKET, Delete: { Objects: [{ Key: String(item.key) }] } }));
      await db.delete(PK.slide(id), 'ITEM');
      await sendChatEvent('slides-updated');
      audit(principal, 'slide.delete', id);
      return success();
    }
    if (path === '/archives' && method === 'GET') {
      const archives = await db.scan<Entity & JsonRecord>('begins_with(PK, :prefix)', { ':prefix': 'ARCHIVE#' });
      return success(archives.filter((archive) => principal.role === 'admin' || archive.published === true).map(toArchive));
    }
    if (parts[0] === 'archives' && parts[1] && method === 'PATCH') {
      adminFeature(principal, 'broadcastManage');
      const { id } = valid(ArchiveIdParamsSchema, { id: parts[1] });
      const patch = valid(ArchiveUpdateRequestSchema, body);
      const setters: string[] = [];
      const values: Record<string, unknown> = {};
      if (patch.title !== undefined) { setters.push('title = :title'); values[':title'] = patch.title; }
      if (patch.published !== undefined) { setters.push('published = :published'); values[':published'] = patch.published; }
      await db.update(PK.archive(id), 'ITEM', `SET ${setters.join(', ')}`, values, 'attribute_exists(PK)');
      await sendChatEvent('archives-updated');
      audit(principal, 'archive.update', id);
      return success(toArchive((await db.get<Entity & JsonRecord>(PK.archive(id), 'ITEM'))!));
    }
    if (parts[0] === 'archives' && parts[1] && method === 'DELETE') {
      adminFeature(principal, 'broadcastManage');
      const { id } = valid(ArchiveIdParamsSchema, { id: parts[1] });
      const item = await db.get<Entity & JsonRecord>(PK.archive(id), 'ITEM');
      if (!item) throw notFound();
      await deletePrefix(clients, getEnvValue().RECORDING_BUCKET, String(item.s3Prefix ?? item.s3Path));
      await db.delete(PK.archive(id), 'ITEM');
      await sendChatEvent('archives-updated');
      audit(principal, 'archive.delete', id);
      return success();
    }
    if (path === '/files/cookies' && method === 'POST') {
      const key = await getSigningKey(clients, getEnvValue(), now());
      const host = event.headers?.['x-forwarded-host'] ?? event.headers?.['X-Forwarded-Host'];
      if (!host || !/^[a-z0-9]+\.cloudfront\.net$/u.test(host)) {
        console.error(JSON.stringify({ level: 'error', event: 'invalid_cloudfront_forwarded_host', host: host ?? null }));
        throw new Error('Invalid CloudFront forwarded host');
      }
      const cookies = getSignedCookies({ url: `https://${host}/files/*`, keyPairId: getEnvValue().CLOUDFRONT_KEY_PAIR_ID, privateKey: key, dateLessThan: new Date(now() + 60 * 60 * 1000) });
      return { statusCode: 204, headers: { 'cache-control': 'no-store' }, body: '', cookies: Object.entries(cookies).map(([name, value]) => `${name}=${value}; Path=/files/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax`) };
    }
    if (path === '/users' && method === 'GET') {
      adminFeature(principal, 'userManage');
      return success(await listUsers(clients, getEnvValue()));
    }
    if (path === '/users/invite' && method === 'POST') {
      adminFeature(principal, 'userManage');
      const request = valid(InviteUsersRequestSchema, body);
      const invited: string[] = [];
      for (const email of request.emails) {
        const created = await clients.cognito.send(new AdminCreateUserCommand({ UserPoolId: getEnvValue().USER_POOL_ID, Username: email, UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }], DesiredDeliveryMediums: ['EMAIL'] }));
        const username = created.User?.Username;
        if (!username) throw new HttpError(502, 'INVITE_FAILED', 'ユーザーを作成できませんでした');
        await clients.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: getEnvValue().USER_POOL_ID, Username: username, GroupName: request.role }));
        invited.push(email);
      }
      audit(principal, 'user.invite', `${invited.length}`);
      return success({ invited });
    }
    if (parts[0] === 'users' && parts[1] && parts[2] === 'role' && method === 'PUT') {
      adminFeature(principal, 'userManage');
      const { userId } = valid(UserIdParamsSchema, { userId: parts[1] });
      const { role } = valid(UpdateRoleRequestSchema, body);
      await setUserRole(clients, getEnvValue(), await resolveUsername(clients, getEnvValue(), userId), role);
      audit(principal, 'user.role', userId);
      return success({ userId, role, enabled: true });
    }
    if (parts[0] === 'users' && parts[1] && parts[2] === 'disable' && method === 'POST') {
      adminFeature(principal, 'userManage');
      const { userId } = valid(UserIdParamsSchema, { userId: parts[1] });
      const username = await resolveUsername(clients, getEnvValue(), userId);
      await clients.cognito.send(new AdminDisableUserCommand({ UserPoolId: getEnvValue().USER_POOL_ID, Username: username }));
      await clients.cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: getEnvValue().USER_POOL_ID, Username: username }));
      audit(principal, 'user.disable', userId);
      return success();
    }
    if (parts[0] === 'users' && parts[1] && parts[2] === 'enable' && method === 'POST') {
      adminFeature(principal, 'userManage');
      const { userId } = valid(UserIdParamsSchema, { userId: parts[1] });
      const username = await resolveUsername(clients, getEnvValue(), userId);
      await clients.cognito.send(new AdminEnableUserCommand({ UserPoolId: getEnvValue().USER_POOL_ID, Username: username }));
      audit(principal, 'user.enable', userId);
      return success();
    }
    if (parts[0] === 'users' && parts[1] && parts.length === 2 && method === 'DELETE') {
      adminFeature(principal, 'userManage');
      const { userId } = valid(UserIdParamsSchema, { userId: parts[1] });
      const username = await resolveUsername(clients, getEnvValue(), userId);
      await clients.cognito.send(new AdminDeleteUserCommand({ UserPoolId: getEnvValue().USER_POOL_ID, Username: username }));
      audit(principal, 'user.delete', userId);
      return success();
    }
    return json(404, { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } });
  }

  return async (event: FunctionUrlEvent): Promise<LambdaResponse> => {
    try { return await handle(event); } catch (error) { return failureResponse(error); }
  };
}

function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function toSlide(item: JsonRecord) { return { id: item.id, title: item.title, fileName: item.fileName, size: item.size, order: item.order, filePath: `/files/slides/${item.id}.pdf` }; }
function toArchive(item: JsonRecord) { return { id: item.id, title: item.title, published: item.published === true, durationSeconds: Number(item.durationSeconds ?? 0), playbackPath: `/files/archives/${item.s3Prefix ?? item.s3Path}/media/hls/multivariant.m3u8` }; }
function notFoundResponse(): LambdaResponse { throw notFound(); }

async function deletePrefix(clients: Clients, bucket: string, prefix: string): Promise<void> {
  let ContinuationToken: string | undefined;
  do {
    const page = await clients.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    const keys = page.Contents?.flatMap((item) => item.Key ? [{ Key: item.Key }] : []) ?? [];
    if (keys.length) await clients.s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
}

async function resolveUsername(clients: Clients, env: Env, userId: string): Promise<string> {
  const response = await clients.cognito.send(new ListUsersCommand({ UserPoolId: env.USER_POOL_ID, Filter: `sub = "${userId}"`, Limit: 1 }));
  const user = response.Users?.[0];
  if (!user?.Username) throw notFound();
  return user.Username;
}

async function setUserRole(clients: Clients, env: Env, username: string, role: Role): Promise<void> {
  const groups = await clients.cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: env.USER_POOL_ID, Username: username }));
  for (const group of groups.Groups ?? []) if (group.GroupName && roles.includes(group.GroupName as Role)) {
    await clients.cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: env.USER_POOL_ID, Username: username, GroupName: group.GroupName }));
  }
  await clients.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: env.USER_POOL_ID, Username: username, GroupName: role }));
}

async function listUsers(clients: Clients, env: Env): Promise<JsonRecord[]> {
  const result: JsonRecord[] = [];
  let PaginationToken: string | undefined;
  do {
    const page = await clients.cognito.send(new ListUsersCommand({ UserPoolId: env.USER_POOL_ID, PaginationToken, Limit: 60 }));
    for (const user of page.Users ?? []) {
      const userId = user.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value ?? '';
      const email = user.Attributes?.find((attribute) => attribute.Name === 'email')?.Value ?? '';
      const [profileResult, loginResult] = userId ? await Promise.all([
        clients.ddb.send(new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: `USER#${userId}`, SK: 'PROFILE' } })),
        clients.ddb.send(new GetCommand({ TableName: env.TABLE_NAME, Key: { PK: `USER#${userId}`, SK: 'LOGIN' } })),
      ]) : [{}, {}];
      const groups = user.Username ? await clients.cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: env.USER_POOL_ID, Username: user.Username })) : undefined;
      const groupNames = (groups?.Groups ?? []).map((group) => group.GroupName).filter((name): name is string => Boolean(name));
      const role = RoleSchema.safeParse(groupNames[0]);
      const profile = profileResult.Item as { commentSuspended?: boolean } | undefined;
      const login = loginResult.Item as { lastLoginAt?: string; loginMethod?: string } | undefined;
      result.push({ userId, email, loginMethod: login?.loginMethod ?? (user.Attributes?.some((a) => a.Name === 'identities') ? 'Okta' : 'email'), role: role.success && groupNames.length === 1 ? role.data : 'viewer', enabled: user.Enabled === true, commentSuspended: profile?.commentSuspended === true, lastLoginAt: login?.lastLoginAt ?? null });
    }
    PaginationToken = page.PaginationToken;
  } while (PaginationToken);
  return result;
}

async function getSigningKey(clients: Clients, env: Env, now: number): Promise<string> {
  if (signingKeyCache && signingKeyCache.expiresAt > now) return signingKeyCache.value;
  const parameter = await clients.ssm.send(new GetParameterCommand({ Name: env.CLOUDFRONT_PRIVATE_KEY_PARAMETER, WithDecryption: true }));
  if (parameter.Parameter?.Type !== 'SecureString' || !parameter.Parameter.Value) throw new HttpError(500, 'SIGNING_KEY_MISSING', 'SSM SecureString の署名鍵を取得できません');
  signingKeyCache = { value: parameter.Parameter.Value, expiresAt: now + 55 * 60 * 1000 };
  return signingKeyCache.value;
}

const defaultApiHandler = createApiHandler();
export const apiLambdaHandler = (event: FunctionUrlEvent) => defaultApiHandler(event);
