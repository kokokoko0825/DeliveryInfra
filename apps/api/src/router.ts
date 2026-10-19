import { randomUUID } from 'node:crypto';
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand,
  AdminEnableUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand, ListUsersCommand, ListUsersInGroupCommand, type AttributeType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CreateParticipantTokenCommand, DisconnectParticipantCommand, GetStageCommand, ListParticipantsCommand, ListStageSessionsCommand,
  type ParticipantTokenCapability,
  StartCompositionCommand, StopCompositionCommand,
} from '@aws-sdk/client-ivs-realtime';
import { CreateChatTokenCommand, DeleteMessageCommand, DisconnectUserCommand, GetRoomCommand, SendEventCommand, type ChatTokenCapability } from '@aws-sdk/client-ivschat';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import { BatchGetCommand, PutCommand, type BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import {
  ARCHIVE_RETENTION_DAYS, ArchiveIdParamsSchema, ArchiveUpdateRequestSchema, BroadcastStartRequestSchema, canAccess, canRequestPurpose,
  ChatCustomEventSchema, CommentSuspensionRequestSchema, containsNgWord, DeviceIdParamsSchema,
  DisplayNameRequestSchema, InviteUsersRequestSchema, MessageIdParamsSchema, NgWordSchema,
  NgWordRequestSchema, RecentCommentsResponseSchema, ROLES, RoleSchema, SlideIdParamsSchema, SlideOrderRequestSchema,
  SlideUploadSchema, SlideUpdateRequestSchema, StageTokenRequestSchema, UserIdParamsSchema,
  UpdateRoleRequestSchema, SLIDE_MAX_BYTES, STAGE_LIMITS, TOKEN_TTL_SECONDS, COMMENT_HISTORY_LIMIT,
  type ChatEventName, type Feature, type Role, type StagePurpose, type UserInviteResponse,
} from '@delivery/shared';
import { authenticate, TOKEN_VALID_AFTER_SK, type Principal } from './auth';
import { createClients, type Clients } from './aws';
import { Database, isConditionalFailure, KEYS, makeDatabase, type Entity } from './database';
import { getApiEnv, type Env } from './env';
import { badRequest, conflict, forbidden, HttpError, notFound } from './errors';
import { deletePrefix } from './storage';

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
type DevicePurpose = keyof typeof STAGE_LIMITS;
interface Lease extends Entity { deviceId: string; userId: string; purpose: DevicePurpose; deviceName: string; ttl: number; participantId?: string; stageArn?: string; replacedDeviceId?: string }

const LEASE_SECONDS = 45;
const COOKIE_SECONDS = 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
/** deviceId は `<purpose>.<slot>.<uuid>`。スロットを埋め込んで Scan せずに引けるようにする（R1-10）。 */
const DEVICE_ID_PATTERN = /^(camera|mic|slide)\.([1-9]\d*)\.([0-9a-f-]{36})$/u;
const SAFE_PREFIX_PATTERN = /^[A-Za-z0-9/_-]+$/u;
/** 確定後の Chat 通知の再試行回数と初回の待ち時間（R4-01）、全体の締め切り（R5-01: API Gateway の 29 秒より十分短くする）。 */
const NOTIFY_RETRIES = 3;
const NOTIFY_BACKOFF_MS = 50;
const NOTIFY_DEADLINE_MS = 3000;
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
const errorName = (error: unknown) => (error as { name?: string }).name;
const isResourceNotFound = (error: unknown) => errorName(error) === 'ResourceNotFoundException';
/** 条件付き更新の失敗（対象なし・競合）を 404 にする（R1-14）。 */
const orNotFound = async <T>(promise: Promise<T>): Promise<T> => {
  try { return await promise; } catch (error) { if (isConditionalFailure(error)) throw notFound(); throw error; }
};
const failureResponse = (error: unknown): LambdaResponse => {
  const err = error instanceof HttpError ? error : new HttpError(500, 'INTERNAL_ERROR', '処理に失敗しました');
  if (err.statusCode >= 500) console.error(JSON.stringify({ error: err.code, name: errorName(error), message: error instanceof Error ? error.message : String(error) }));
  return json(err.statusCode, { error: { code: err.code, message: err.message } });
};
const attribute = (attributes: AttributeType[] | undefined, name: string) => attributes?.find((item) => item.Name === name)?.Value;
const loginMethodOf = (attributes: AttributeType[] | undefined) => {
  const identities = attribute(attributes, 'identities');
  return identities && identities !== '[]' ? 'Okta' : 'email';
};

export function createApiHandler(dependencies?: Partial<ApiDependencies>) {
  let envValue = dependencies?.env;
  let clientsValue = dependencies?.clients;
  let dbValue: Database | undefined;
  const getEnvValue = () => envValue ??= getApiEnv();
  const getClients = () => clientsValue ??= createClients(getEnvValue());
  const getDb = () => dbValue ??= makeDatabase(getClients().ddb, getEnvValue());
  const now = dependencies?.now ?? Date.now;
  const nowSeconds = () => Math.floor(now() / 1000);
  const auth = dependencies?.authenticate ?? authenticate;

  /**
   * 状態を確定した後の Chat 通知。短いバックオフで最大3回まで再試行し、それでも失敗したら警告ログだけ残して成功扱いにする。
   * 確定済みの操作を 500 にすると、画面が失敗と表示し、再試行が 404 になるため（R4-01 / R3-14）。
   * 通知の欠落は、クライアントのポーリングと再取得で回復する。
   * SendEvent が応答しないときも Lambda のタイムアウトで 5xx にならないよう、全体を NOTIFY_DEADLINE_MS で打ち切る（R5-01）。
   */
  async function notify(eventName: ChatEventName) {
    const validated = valid(ChatCustomEventSchema, { eventName });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(Object.assign(new Error('Chat notification deadline exceeded'), { name: 'TimeoutError' })), NOTIFY_DEADLINE_MS);
    const expired = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    expired.catch(() => undefined);
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const command = new SendEventCommand({ roomIdentifier: getEnvValue().CHAT_ROOM_ARN, eventName: validated.eventName });
          await Promise.race([getClients().chat.send(command, { abortSignal: controller.signal }), expired]);
          return;
        } catch (error) {
          if (attempt >= NOTIFY_RETRIES || controller.signal.aborted) {
            console.warn(JSON.stringify({ warning: 'CHAT_EVENT_FAILED', eventName, name: errorName(error), message: error instanceof Error ? error.message : String(error) }));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, NOTIFY_BACKOFF_MS * 2 ** attempt));
        }
      }
    } finally {
      clearTimeout(deadline);
    }
  }

  /** 失効した枠や置き換える枠の参加者を IVS から切断する。既に居ない場合は成功扱い（R1-07）。 */
  async function disconnectLease(lease: Partial<Lease> | undefined, reason: string) {
    if (!lease?.participantId || !lease.stageArn) return;
    try {
      await getClients().ivs.send(new DisconnectParticipantCommand({ stageArn: lease.stageArn, participantId: lease.participantId, reason }));
    } catch (error) {
      if (!isResourceNotFound(error)) throw error;
    }
  }

  async function findLease(deviceId: string): Promise<Lease | undefined> {
    const match = DEVICE_ID_PATTERN.exec(deviceId);
    if (!match) return undefined;
    const lease = await getDb().get<Lease>(KEYS.devicePk, KEYS.deviceSk(match[1]!, Number(match[2])), true);
    return lease?.deviceId === deviceId ? lease : undefined;
  }

  /** 枠が同じ名前の別の稼働中端末に置き換わったか。失効（404・再接続対象）と区別する（R3-02）。 */
  async function wasReplaced(principal: Principal, deviceId: string): Promise<boolean> {
    const match = DEVICE_ID_PATTERN.exec(deviceId);
    if (!match) return false;
    const current = await getDb().get<Lease>(KEYS.devicePk, KEYS.deviceSk(match[1]!, Number(match[2])), true);
    if (!current || current.deviceId === deviceId || current.ttl <= nowSeconds() || current.replacedDeviceId !== deviceId) return false;
    // 引き継ぎは本人だけが行えるので、所有者（または admin）以外には失効と同じ 404 を返す
    return current.userId === principal.userId || principal.role === 'admin';
  }

  async function acquireDevice(principal: Principal, purpose: DevicePurpose, deviceName: string, takeover: boolean): Promise<{ deviceId: string; sk: string }> {
    const nowS = nowSeconds();
    const leases = await getDb().query<Lease>(KEYS.devicePk, { skPrefix: `${purpose}#`, consistentRead: true });
    // 同名の稼働中端末: 他人なら拒否。本人でも takeover を明示したときだけ置き換える（R1-18 / R3-02）。
    // 暗黙に置き換えると、同じ端末名の2端末がハートビートのたびに互いを切断し合うため。
    const sameName = purpose === 'slide' ? undefined : leases.find((lease) => lease.ttl > nowS && lease.deviceName === deviceName);
    if (sameName && sameName.userId !== principal.userId) throw conflict('DEVICE_NAME_IN_USE', 'この端末名は使用中です');
    if (sameName && !takeover) throw conflict('DEVICE_NAME_IN_USE_SELF', 'この端末名はあなたの別の端末で使用中です');
    const slots = sameName ? [sameName.SK] : Array.from({ length: STAGE_LIMITS[purpose] }, (_, index) => KEYS.deviceSk(purpose, index + 1));
    for (const sk of slots) {
      const deviceId = `${sk.replace('#', '.')}.${randomUUID()}`;
      let previous: Partial<Lease> | undefined;
      try {
        const result = await getClients().ddb.send(new PutCommand({
          TableName: getEnvValue().TABLE_NAME,
          // 引き継ぎ元を残し、置き換えられた端末のハートビートに DEVICE_REPLACED を返せるようにする
          Item: entity(KEYS.devicePk, sk, { deviceId, purpose, deviceName, userId: principal.userId, ttl: nowS + LEASE_SECONDS, createdAt: iso(now()), ...(sameName ? { replacedDeviceId: sameName.deviceId } : {}) }),
          ...(sameName
            ? { ConditionExpression: 'deviceId = :previous', ExpressionAttributeValues: { ':previous': sameName.deviceId } }
            : { ConditionExpression: 'attribute_not_exists(PK) OR #ttl <= :now', ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':now': nowS } }),
          ReturnValues: 'ALL_OLD',
        }));
        previous = result.Attributes as Partial<Lease> | undefined;
      } catch (error) {
        if (isConditionalFailure(error)) continue;
        throw error;
      }
      try {
        await disconnectLease(previous, sameName ? '同じ端末名の別の端末に引き継がれました' : '送信枠が失効しました');
      } catch (error) {
        // 旧参加者が接続したままなので旧枠を戻す。条件付きにして、その後の他端末の取得は上書きしない（R2-01）
        // 切断を試みるのは旧枠がある場合だけなので previous は ALL_OLD の完全な行
        await getDb().put(previous as Entity, 'deviceId = :deviceId', { ':deviceId': deviceId }).catch(() => undefined);
        throw error;
      }
      return { deviceId, sk };
    }
    throw conflict('DEVICE_LIMIT', '送信端末の上限に達しています');
  }

  async function issueStageToken(principal: Principal, purpose: StagePurpose, deviceName?: string, takeover = false) {
    if (!canRequestPurpose(principal.role, purpose)) throw forbidden();
    const env = getEnvValue();
    // switcher は端末枠を使わない（R1-02）。1回の応答の3トークンを Web が使い回す。
    const stagesByPurpose: Record<StagePurpose, [string, string, ParticipantTokenCapability][]> = {
      viewer: [['broadcast', env.STAGE_BROADCAST_ARN, 'SUBSCRIBE']],
      camera: [['production', env.STAGE_PRODUCTION_ARN, 'PUBLISH']],
      mic: [['production', env.STAGE_PRODUCTION_ARN, 'PUBLISH']],
      slide: [['slide', env.STAGE_SLIDE_ARN, 'PUBLISH']],
      switcher: [['production', env.STAGE_PRODUCTION_ARN, 'SUBSCRIBE'], ['slide', env.STAGE_SLIDE_ARN, 'SUBSCRIBE'], ['broadcast', env.STAGE_BROADCAST_ARN, 'PUBLISH']],
    };
    const resolvedDeviceName = purpose === 'slide' ? 'SLIDE' : deviceName ?? purpose.toUpperCase();
    const attributes = purpose === 'viewer' ? undefined : { kind: purpose, deviceName: resolvedDeviceName };
    const device = purpose === 'camera' || purpose === 'mic' || purpose === 'slide' ? await acquireDevice(principal, purpose, resolvedDeviceName, takeover) : undefined;
    try {
      const tokens = await Promise.all(stagesByPurpose[purpose].map(async ([stageName, stageArn, capability]) => {
        const result = await getClients().ivs.send(new CreateParticipantTokenCommand({
          stageArn, duration: TOKEN_TTL_SECONDS / 60, userId: principal.userId,
          capabilities: [capability], attributes,
        }));
        const token = result.participantToken;
        if (!token?.token || !token.participantId || !token.expirationTime) throw new HttpError(502, 'TOKEN_ISSUE_FAILED', '参加トークンを発行できませんでした');
        return { stage: stageName, stageArn, token: token.token, participantId: token.participantId, capabilities: token.capabilities ?? [capability], expiresAt: token.expirationTime.toISOString() };
      }));
      if (device) {
        const [published] = tokens;
        await getDb().update(KEYS.devicePk, device.sk, 'SET participantId = :participantId, stageArn = :stageArn', { ':participantId': published!.participantId, ':stageArn': published!.stageArn, ':deviceId': device.deviceId }, 'deviceId = :deviceId');
      }
      return { tokens: tokens.map(({ stage, token, participantId, capabilities, expiresAt }) => ({ stage, token, participantId, capabilities, expiresAt })), ...(device ? { deviceId: device.deviceId } : {}) };
    } catch (error) {
      if (device) await getDb().delete(KEYS.devicePk, device.sk, 'deviceId = :deviceId', { ':deviceId': device.deviceId }).catch(() => undefined);
      throw error;
    }
  }

  async function getMe(principal: Principal): Promise<JsonRecord> {
    const [profile, user] = await Promise.all([
      getDb().get<Entity & { displayName?: string; commentSuspended?: boolean }>(KEYS.user(principal.userId), 'PROFILE'),
      getClients().cognito.send(new AdminGetUserCommand({ UserPoolId: getEnvValue().USER_POOL_ID, Username: principal.username })),
    ]);
    const email = attribute(user.UserAttributes, 'email');
    if (!email) throw new HttpError(500, 'USER_EMAIL_MISSING', 'ユーザーのメールアドレスを取得できません');
    return { userId: principal.userId, email, role: principal.role, loginMethod: loginMethodOf(user.UserAttributes), displayName: profile?.displayName ?? null, commentSuspended: profile?.commentSuspended ?? false };
  }

  async function ngWords(): Promise<string[]> {
    return (await getDb().query<Entity & { word: string }>(KEYS.ngWordPk)).map((item) => item.word);
  }

  async function signedCookies(event: FunctionUrlEvent, resourcePath: string): Promise<LambdaResponse> {
    const env = getEnvValue();
    const host = event.headers?.['x-forwarded-host'] ?? event.headers?.['X-Forwarded-Host'];
    if (!host || !/^[a-z0-9]+\.cloudfront\.net$/u.test(host)) {
      console.error(JSON.stringify({ level: 'error', event: 'invalid_cloudfront_forwarded_host', host: host ?? null }));
      throw new Error('Invalid CloudFront forwarded host');
    }
    const key = await getSigningKey(getClients(), env, now());
    // ワイルドカードはカスタムポリシーでのみ有効（canned policy は単一 URL）
    const policy = JSON.stringify({ Statement: [{ Resource: `https://${host}${resourcePath}*`, Condition: { DateLessThan: { 'AWS:EpochTime': nowSeconds() + COOKIE_SECONDS } } }] });
    const cookies = getSignedCookies({ policy, keyPairId: env.CLOUDFRONT_KEY_PAIR_ID, privateKey: key });
    return { statusCode: 204, headers: { 'cache-control': 'no-store' }, body: '', cookies: Object.entries(cookies).map(([name, value]) => `${name}=${value}; Path=${resourcePath}; Max-Age=${COOKIE_SECONDS}; Secure; HttpOnly; SameSite=Strict`) };
  }

  /** 期限到来後も TTL 削除までは読めてしまうため、retainUntil で除外する。 */
  const archiveAlive = (item: JsonRecord) => Date.parse(retainUntilOf(item)) > now();

  async function getArchive(id: string): Promise<Entity & JsonRecord> {
    const item = await getDb().get<Entity & JsonRecord>(KEYS.archivePk, id);
    if (!item || !archiveAlive(item)) throw notFound();
    return item;
  }

  /** 自分自身の降格・無効化・削除をサーバー側で拒否する（R1-19）。 */
  function rejectSelf(principal: Principal, userId: string) {
    if (userId === principal.userId) throw new HttpError(400, 'CANNOT_MODIFY_SELF', '自分自身のアカウントは変更できません');
  }

  /** 既存の token を無効化する。GlobalSignOut は refresh token を、tokenValidAfter は発行済み access token を止める（R1-09）。 */
  async function revokeTokens(username: string, userId: string, signOut = true) {
    if (signOut) await getClients().cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: getEnvValue().USER_POOL_ID, Username: username }));
    await getDb().put(entity(KEYS.user(userId), TOKEN_VALID_AFTER_SK, { tokenValidAfter: nowSeconds() }));
  }

  async function handle(event: FunctionUrlEvent): Promise<LambdaResponse> {
    const path = event.rawPath || event.requestContext.http.path;
    const method = event.requestContext.http.method.toUpperCase();
    const parts = pathParts(path);
    if (parts[0] !== 'api') return json(404, { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } });
    try {
      const headers = event.headers ?? {};
      const token = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-auth-token')?.[1];
      const principal = await auth(token, getEnvValue(), getDb());
      return await route(parts.slice(1), method, event, principal);
    } catch (error) { return failureResponse(error); }
  }

  async function route(parts: string[], method: string, event: FunctionUrlEvent, principal: Principal): Promise<LambdaResponse> {
    const path = `/${parts.join('/')}`;
    const body = objectBody(event);
    const db = getDb();
    const clients = getClients();
    const env = getEnvValue();

    if (path === '/me' && method === 'GET') return success(await getMe(principal));
    if (path === '/me/display-name' && method === 'PUT') {
      const { displayName } = valid(DisplayNameRequestSchema, body);
      if (containsNgWord(displayName, await ngWords())) throw new HttpError(400, 'NG_WORD', '使用できない単語が含まれています');
      await db.update(KEYS.user(principal.userId), 'PROFILE', 'SET displayName = :name, updatedAt = :updatedAt', { ':name': displayName, ':updatedAt': iso(now()) });
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
        if (isConditionalFailure(error)) throw conflict('BROADCAST_LIVE', '配信はすでに開始しています');
        throw error;
      }
      let compositionArn: string | undefined;
      try {
        const start = await clients.ivs.send(new StartCompositionCommand({
          stageArn: env.STAGE_BROADCAST_ARN,
          idempotencyToken: broadcastId,
          destinations: [{
            name: 'recording',
            s3: { storageConfigurationArn: env.RECORDING_STORAGE_CONFIGURATION_ARN, encoderConfigurationArns: [env.ENCODER_CONFIGURATION_ARN], recordingConfiguration: { hlsConfiguration: { targetSegmentDurationSeconds: 10 }, format: 'HLS' } },
          }],
        }));
        compositionArn = start.composition?.arn;
        // 録画先 prefix は outputPrefix として保存する（recordingPrefix 属性はアーカイブ行専用）
        const outputPrefix = start.composition?.destinations?.find((destination) => destination.detail?.s3?.recordingPrefix)?.detail?.s3?.recordingPrefix;
        await db.update('BROADCAST', 'CURRENT', 'SET #status = :live, compositionArn = :compositionArn, outputPrefix = :outputPrefix', { ':live': 'live', ':compositionArn': compositionArn ?? '', ':outputPrefix': outputPrefix ?? '', ':id': broadcastId }, 'id = :id', { '#status': 'status' });
        if (compositionArn) await db.put(entity(KEYS.compositionPk(compositionArn), 'META', { broadcastId, title, startedAt, outputPrefix }));
      } catch (error) {
        // Composition を開始済みなら止める。残すと録画と課金が続き、META がないためアーカイブにも載らない（R3-11）
        if (compositionArn) await clients.ivs.send(new StopCompositionCommand({ arn: compositionArn })).catch(() => undefined);
        await db.delete('BROADCAST', 'CURRENT', 'id = :id', { ':id': broadcastId }).catch(() => undefined);
        throw error;
      }
      audit(principal, 'broadcast.start');
      await notify('broadcast-started');
      return success({ id: broadcastId, title, status: 'live', startedAt, endedAt: null });
    }
    if (path === '/broadcast/stop' && method === 'POST') {
      adminFeature(principal, 'broadcastManage');
      const broadcast = await db.get<Entity & { status?: string; compositionArn?: string; id?: string; title?: string; startedAt?: string; endedAt?: string }>('BROADCAST', 'CURRENT');
      if (broadcast?.status === 'ended') {
        // 前回の停止で通知が届かなかった場合の再試行。終了通知を再送する（重複はクライアントが許容する、R2-03）
        audit(principal, 'broadcast.stop.retry', broadcast.id);
        await notify('broadcast-ended');
        return success({ id: broadcast.id, title: broadcast.title, status: 'ended', startedAt: broadcast.startedAt, endedAt: broadcast.endedAt ?? null });
      }
      if (!broadcast || broadcast.status !== 'live') throw conflict('BROADCAST_NOT_LIVE', '配信中ではありません');
      if (broadcast.compositionArn) {
        // 全参加者の切断から1分で Composition は自動停止・削除される。その後の停止は成功扱いで ended に進める（R1-03）
        try { await clients.ivs.send(new StopCompositionCommand({ arn: broadcast.compositionArn })); }
        catch (error) { if (!isResourceNotFound(error)) throw error; }
      }
      const endedAt = iso(now());
      await db.update('BROADCAST', 'CURRENT', 'SET #status = :status, endedAt = :endedAt', { ':status': 'ended', ':endedAt': endedAt }, 'attribute_exists(PK)', { '#status': 'status' });
      audit(principal, 'broadcast.stop', broadcast.id);
      await notify('broadcast-ended');
      return success({ id: broadcast.id, title: broadcast.title, status: 'ended', startedAt: broadcast.startedAt, endedAt });
    }
    if (path === '/broadcast/stats' && method === 'GET') {
      adminFeature(principal, 'broadcastManage');
      const activeStage = await clients.ivs.send(new GetStageCommand({ arn: env.STAGE_BROADCAST_ARN }));
      const sessionId = activeStage.stage?.activeSessionId;
      if (!sessionId) return success({ viewerCount: 0 });
      let viewerCount = 0;
      let nextToken: string | undefined;
      do {
        const page = await clients.ivs.send(new ListParticipantsCommand({ stageArn: env.STAGE_BROADCAST_ARN, sessionId, filterByState: 'CONNECTED', maxResults: 50, nextToken }));
        viewerCount += (page.participants ?? []).filter((participant) => !participant.published).length;
        nextToken = page.nextToken;
      } while (nextToken);
      return success({ viewerCount });
    }
    if (path === '/status' && method === 'GET') {
      adminFeature(principal, 'broadcastManage');
      const arns = [['production', env.STAGE_PRODUCTION_ARN], ['slide', env.STAGE_SLIDE_ARN], ['broadcast', env.STAGE_BROADCAST_ARN]] as const;
      // 存在しない場合だけ exists:false。権限不足などは握りつぶさず 500 にしてログに残す（R1-06）
      const stages = await Promise.all(arns.map(async ([name, stageArn]) => {
        let stage;
        try { stage = await clients.ivs.send(new GetStageCommand({ arn: stageArn })); }
        catch (error) { if (isResourceNotFound(error)) return { name, exists: false }; throw error; }
        const sessions = await clients.ivs.send(new ListStageSessionsCommand({ stageArn, maxResults: 1 }));
        const active = Boolean(stage.stage?.activeSessionId) || sessions.stageSessions?.some((session) => !session.endTime) === true;
        return { name, exists: Boolean(stage.stage), status: active ? 'ACTIVE' : 'IDLE' };
      }));
      let chatRoom: { exists: boolean; status?: string };
      try { chatRoom = { exists: Boolean((await clients.chat.send(new GetRoomCommand({ identifier: env.CHAT_ROOM_ARN }))).arn), status: 'ACTIVE' }; }
      catch (error) { if (!isResourceNotFound(error)) throw error; chatRoom = { exists: false }; }
      return success({ stages, chatRoom });
    }
    if (path === '/tokens/stage' && method === 'POST') {
      const request = valid(StageTokenRequestSchema, body);
      return success(await issueStageToken(principal, request.purpose, request.deviceName, request.takeover));
    }
    if (parts[0] === 'devices') {
      if (parts.length === 1 && method === 'GET') {
        adminFeature(principal, 'switcher');
        const devices = await db.query<Lease>(KEYS.devicePk, { consistentRead: true });
        const nowS = nowSeconds();
        return success(devices.filter((d) => Number(d.ttl) > nowS).map((d) => ({ deviceId: d.deviceId, deviceName: d.deviceName, kind: d.purpose, userId: d.userId, connected: true })));
      }
      if (parts.length === 2 && parts[1] === 'names' && method === 'GET') {
        // 端末名の初期値を空いている名前にするため、他人が使用中の名前だけを返す（R3-01）
        const purpose = new URLSearchParams(event.rawQueryString ?? '').get('purpose');
        if (purpose !== 'camera' && purpose !== 'mic') throw badRequest('purpose は camera か mic を指定してください');
        if (!canRequestPurpose(principal.role, purpose)) throw forbidden();
        const nowS = nowSeconds();
        const leases = await db.query<Lease>(KEYS.devicePk, { skPrefix: `${purpose}#`, consistentRead: true });
        return success({ inUse: leases.filter((lease) => lease.ttl > nowS && lease.userId !== principal.userId).map((lease) => lease.deviceName) });
      }
      if (parts.length === 3 && parts[2] === 'heartbeat' && method === 'POST') {
        const { deviceId } = valid(DeviceIdParamsSchema, { deviceId: parts[1] });
        const device = await findLease(deviceId);
        if (!device && await wasReplaced(principal, deviceId)) throw conflict('DEVICE_REPLACED', '同じ端末名の別の端末に引き継がれました');
        if (!device || (device.userId !== principal.userId && principal.role !== 'admin')) throw notFound();
        const ttl = nowSeconds() + LEASE_SECONDS;
        await orNotFound(db.update(device.PK, device.SK, 'SET #ttl = :ttl', { ':ttl': ttl, ':deviceId': deviceId }, 'deviceId = :deviceId', { '#ttl': 'ttl' }));
        return success({ expiresAt: iso(ttl * 1000) });
      }
      if (parts.length === 2 && method === 'DELETE') {
        const { deviceId } = valid(DeviceIdParamsSchema, { deviceId: parts[1] });
        const device = await findLease(deviceId);
        if (!device) throw notFound();
        if (device.userId !== principal.userId && principal.role !== 'admin') throw forbidden();
        await disconnectLease(device, '送信枠を解放しました');
        await orNotFound(db.delete(device.PK, device.SK, 'deviceId = :deviceId', { ':deviceId': deviceId }));
        if (principal.role === 'admin') audit(principal, 'device.release', deviceId);
        return success();
      }
    }
    if (path === '/tokens/chat' && method === 'POST') {
      const profile = await db.get<Entity & { commentSuspended?: boolean; displayName?: string }>(KEYS.user(principal.userId), 'PROFILE');
      const capabilities: ChatTokenCapability[] = principal.role === 'admin' ? ['SEND_MESSAGE', 'DELETE_MESSAGE', 'DISCONNECT_USER'] : profile?.commentSuspended ? [] : ['SEND_MESSAGE'];
      const token = await clients.chat.send(new CreateChatTokenCommand({ roomIdentifier: env.CHAT_ROOM_ARN, userId: principal.userId, capabilities, sessionDurationInMinutes: 60, attributes: { displayName: profile?.displayName ?? '' } }));
      return success({ token: token.token, capabilities });
    }
    if (path === '/comments/recent' && method === 'GET') {
      const comments = await db.query<Entity & JsonRecord>(KEYS.commentPk, {
        descending: true, limit: COMMENT_HISTORY_LIMIT,
        filter: { expression: '#deleted <> :deleted', values: { ':deleted': true }, names: { '#deleted': 'deleted' } },
      });
      return success(valid(RecentCommentsResponseSchema, comments.map((comment) => ({ messageId: comment.messageId, userId: comment.userId, displayName: comment.displayName, comment: comment.comment, sentAt: comment.sentAt, deleted: false }))));
    }
    if (parts[0] === 'comments' && parts.length === 2 && method === 'DELETE') {
      adminFeature(principal, 'commentModeration');
      const { messageId } = valid(MessageIdParamsSchema, { messageId: parts[1] });
      const ref = await db.get<Entity & { commentSk?: string }>(KEYS.commentRef(messageId), 'REF');
      if (!ref?.commentSk) throw notFound();
      await clients.chat.send(new DeleteMessageCommand({ roomIdentifier: env.CHAT_ROOM_ARN, id: messageId, reason: '管理者による削除' }));
      await orNotFound(db.update(KEYS.commentPk, ref.commentSk, 'SET deleted = :deleted', { ':deleted': true }, 'attribute_exists(PK)'));
      audit(principal, 'comment.delete', messageId);
      return success();
    }
    if (parts[0] === 'users' && parts[1] && parts[2] === 'comment-suspension' && method === 'PUT') {
      adminFeature(principal, 'commentModeration');
      const { userId } = valid(UserIdParamsSchema, { userId: parts[1] });
      const { suspended } = valid(CommentSuspensionRequestSchema, body);
      await db.update(KEYS.user(userId), 'PROFILE', 'SET commentSuspended = :suspended, updatedAt = :updatedAt', { ':suspended': suspended, ':updatedAt': iso(now()) });
      audit(principal, 'comment.suspension', userId);
      // 停止・解除とも切断する。本人のクライアントは再接続で /me とトークンの権限を取り直す（R4-02）
      await clients.chat.send(new DisconnectUserCommand({ roomIdentifier: env.CHAT_ROOM_ARN, userId, reason: suspended ? 'コメント送信停止' : 'コメント送信停止の解除' }));
      return success();
    }
    if (path === '/comments/export' && method === 'GET') {
      adminFeature(principal, 'commentModeration');
      const comments = await db.query<Entity & JsonRecord>(KEYS.commentPk);
      const rows = comments.map((c) => [c.messageId, c.sentAt, c.userId, c.displayName, c.comment, c.deleted === true ? 'true' : 'false'].map(csvCell).join(','));
      return { statusCode: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="comments.csv"', 'cache-control': 'no-store' }, body: `﻿メッセージID,日時,ユーザーID,表示名,コメント,削除済み\r\n${rows.join('\r\n')}` };
    }
    if (path === '/ng-words' && method === 'GET') {
      adminFeature(principal, 'commentModeration');
      return success((await ngWords()).sort());
    }
    if (path === '/ng-words' && method === 'POST') {
      adminFeature(principal, 'commentModeration');
      const { word } = valid(NgWordRequestSchema, body);
      await db.put(entity(KEYS.ngWordPk, word, { word, createdAt: iso(now()) }));
      audit(principal, 'ng-word.create', word);
      return success({ word });
    }
    if (parts[0] === 'ng-words' && parts.length === 2 && method === 'DELETE') {
      adminFeature(principal, 'commentModeration');
      const word = valid(NgWordSchema, parts[1]);
      await db.delete(KEYS.ngWordPk, word);
      audit(principal, 'ng-word.delete', word);
      return success();
    }
    if (path === '/slides' && method === 'GET') {
      const slides = await db.query<Entity & JsonRecord>(KEYS.slidePk);
      return success(slides.filter((slide) => slide.published).sort((a, b) => Number(a.order) - Number(b.order)).map(toSlide));
    }
    if (path === '/slides/upload-url' && method === 'POST') {
      adminFeature(principal, 'slideManage');
      const request = valid(SlideUploadSchema, body);
      const id = randomUUID();
      const key = `slides/${id}.pdf`;
      const post = await createPresignedPost(clients.s3, { Bucket: env.CONTENT_BUCKET, Key: key, Expires: 300, Fields: { 'Content-Type': 'application/pdf' }, Conditions: [['content-length-range', 1, SLIDE_MAX_BYTES], ['eq', '$Content-Type', 'application/pdf']] });
      await db.put(entity(KEYS.slidePk, id, { id, key, title: request.title, fileName: request.fileName, size: request.size, createdAt: iso(now()), createdBy: principal.userId, status: 'pending' }));
      audit(principal, 'slide.upload-url', id);
      return success({ slideId: id, url: post.url, fields: post.fields });
    }
    if (parts[0] === 'slides' && parts[1] && parts[2] === 'complete' && method === 'POST') {
      adminFeature(principal, 'slideManage');
      const { id } = valid(SlideIdParamsSchema, { id: parts[1] });
      const item = await db.get<Entity & JsonRecord>(KEYS.slidePk, id);
      if (!item) throw notFound();
      const head = await clients.s3.send(new HeadObjectCommand({ Bucket: env.CONTENT_BUCKET, Key: String(item.key) }));
      if (!head.ContentLength || head.ContentLength > SLIDE_MAX_BYTES || head.ContentLength !== item.size || head.ContentType !== 'application/pdf') throw badRequest('PDF のサイズまたは MIME タイプが一致しません');
      const object = await clients.s3.send(new GetObjectCommand({ Bucket: env.CONTENT_BUCKET, Key: String(item.key), Range: 'bytes=0-4' }));
      const prefix = await object.Body?.transformToByteArray();
      if (!prefix || Buffer.from(prefix).toString('ascii') !== '%PDF-') throw badRequest('PDF ファイルとして読み取れません');
      const order = (await db.query<Entity & JsonRecord>(KEYS.slidePk)).filter((slide) => slide.published).length;
      await orNotFound(db.update(KEYS.slidePk, id, 'SET published = :published, #status = :status, #order = :order', { ':published': true, ':status': 'ready', ':order': order }, 'attribute_exists(PK)', { '#status': 'status', '#order': 'order' }));
      audit(principal, 'slide.complete', id);
      await notify('slides-updated');
      return success(toSlide({ ...item, published: true, status: 'ready', order }));
    }
    if (parts[0] === 'slides' && parts[1] && parts.length === 2 && method === 'PATCH') {
      adminFeature(principal, 'slideManage');
      const { id } = valid(SlideIdParamsSchema, { id: parts[1] });
      const { title } = valid(SlideUpdateRequestSchema, body);
      await orNotFound(db.update(KEYS.slidePk, id, 'SET title = :title', { ':title': title }, 'attribute_exists(PK)'));
      audit(principal, 'slide.update', id);
      const updated = await db.get<Entity & JsonRecord>(KEYS.slidePk, id);
      if (!updated) throw notFound();
      return success(toSlide(updated));
    }
    if (path === '/slides/order' && method === 'PUT') {
      adminFeature(principal, 'slideManage');
      const { ids } = valid(SlideOrderRequestSchema, body);
      await orNotFound(Promise.all(ids.map((id, order) => db.update(KEYS.slidePk, id, 'SET #order = :order', { ':order': order }, 'attribute_exists(PK)', { '#order': 'order' }))));
      audit(principal, 'slide.order');
      await notify('slides-updated');
      return success();
    }
    if (parts[0] === 'slides' && parts[1] && parts.length === 2 && method === 'DELETE') {
      adminFeature(principal, 'slideManage');
      const { id } = valid(SlideIdParamsSchema, { id: parts[1] });
      const item = await db.get<Entity & JsonRecord>(KEYS.slidePk, id);
      if (!item) throw notFound();
      await clients.s3.send(new DeleteObjectsCommand({ Bucket: env.CONTENT_BUCKET, Delete: { Objects: [{ Key: String(item.key) }] } }));
      await db.delete(KEYS.slidePk, id);
      audit(principal, 'slide.delete', id);
      await notify('slides-updated');
      return success();
    }
    if (path === '/archives' && method === 'GET') {
      const archives = await db.query<Entity & JsonRecord>(KEYS.archivePk);
      return success(archives
        .filter((archive) => archiveAlive(archive) && (principal.role === 'admin' || archive.published === true))
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
        .map(toArchive));
    }
    if (parts[0] === 'archives' && parts[1] && parts[2] === 'cookies' && parts.length === 3 && method === 'POST') {
      const { id } = valid(ArchiveIdParamsSchema, { id: parts[1] });
      const item = await getArchive(id);
      // 非公開アーカイブの存在は管理者以外に見せない（R1-08）
      if (item.published !== true && principal.role !== 'admin') throw notFound();
      return signedCookies(event, `/files/archives/${archivePrefix(item)}/`);
    }
    if (parts[0] === 'archives' && parts[1] && parts.length === 2 && method === 'PATCH') {
      adminFeature(principal, 'broadcastManage');
      const { id } = valid(ArchiveIdParamsSchema, { id: parts[1] });
      const patch = valid(ArchiveUpdateRequestSchema, body);
      const setters: string[] = [];
      const values: Record<string, unknown> = {};
      if (patch.title !== undefined) { setters.push('title = :title'); values[':title'] = patch.title; }
      if (patch.published !== undefined) { setters.push('published = :published'); values[':published'] = patch.published; }
      if (patch.retainUntil !== undefined) {
        const retainUntilMs = Date.parse(patch.retainUntil);
        if (retainUntilMs <= now()) throw badRequest('保存期限は現在より後の日時を指定してください');
        // TTL 属性も一緒に更新し、期限到来で DynamoDB TTL → Stream → 録画削除が走るようにする（R1-22）
        setters.push('retainUntil = :retainUntil', '#ttl = :ttl');
        values[':retainUntil'] = iso(retainUntilMs);
        values[':ttl'] = Math.floor(retainUntilMs / 1000);
      }
      await orNotFound(db.update(KEYS.archivePk, id, `SET ${setters.join(', ')}`, values, 'attribute_exists(PK)', patch.retainUntil === undefined ? undefined : { '#ttl': 'ttl' }));
      audit(principal, 'archive.update', id);
      await notify('archives-updated');
      return success(toArchive(await getArchive(id)));
    }
    if (parts[0] === 'archives' && parts[1] && parts.length === 2 && method === 'DELETE') {
      adminFeature(principal, 'broadcastManage');
      const { id } = valid(ArchiveIdParamsSchema, { id: parts[1] });
      const item = await db.get<Entity & JsonRecord>(KEYS.archivePk, id);
      if (!item) throw notFound();
      await deletePrefix(clients.s3, env.RECORDING_BUCKET, archivePrefix(item));
      await db.delete(KEYS.archivePk, id);
      audit(principal, 'archive.delete', id);
      await notify('archives-updated');
      return success();
    }
    if (path === '/files/cookies' && method === 'POST') return signedCookies(event, '/files/slides/');
    if (path === '/users' && method === 'GET') {
      adminFeature(principal, 'userManage');
      return success(await listUsers(clients, env));
    }
    if (path === '/users/invite' && method === 'POST') {
      adminFeature(principal, 'userManage');
      const request = valid(InviteUsersRequestSchema, body);
      const result: UserInviteResponse = { invited: [], failed: [] };
      // 1件ずつ処理し、失敗しても残りを続けて部分成功を返す（R1-11）
      for (const email of request.emails) {
        try {
          const created = await clients.cognito.send(new AdminCreateUserCommand({ UserPoolId: env.USER_POOL_ID, Username: email, UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }], DesiredDeliveryMediums: ['EMAIL'] }));
          const username = created.User?.Username;
          if (!username) throw new Error('AdminCreateUser returned no username');
          try {
            await clients.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: env.USER_POOL_ID, Username: username, GroupName: request.role }));
          } catch (groupError) {
            // ロールなしユーザーを残すと再招待できないため作成を取り消す。取り消しも失敗したら修復対象として返す（R2-02）
            try {
              await clients.cognito.send(new AdminDeleteUserCommand({ UserPoolId: env.USER_POOL_ID, Username: username }));
            } catch (deleteError) {
              console.error(JSON.stringify({ error: 'INVITE_COMPENSATION_FAILED', name: errorName(deleteError), groupError: errorName(groupError) }));
              audit(principal, 'user.invite.created_without_role', username);
              result.failed.push({ email, reason: 'CREATED_WITHOUT_ROLE' });
              continue;
            }
            throw groupError;
          }
          result.invited.push(email);
        } catch (error) {
          const name = errorName(error);
          const reason = name === 'UsernameExistsException' ? 'ALREADY_EXISTS' : name === 'InvalidParameterException' ? 'INVALID_PARAMETER' : 'FAILED';
          if (reason === 'FAILED') console.error(JSON.stringify({ error: 'INVITE_FAILED', name, message: error instanceof Error ? error.message : String(error) }));
          result.failed.push({ email, reason });
        }
      }
      audit(principal, 'user.invite', `${result.invited.length}/${request.emails.length}`);
      return success(result);
    }
    if (parts[0] === 'users' && parts[1] && parts[2] === 'resend-invite' && parts.length === 3 && method === 'POST') {
      adminFeature(principal, 'userManage');
      const { userId } = valid(UserIdParamsSchema, { userId: parts[1] });
      const username = await resolveUsername(clients, env, userId);
      // 仮パスワード（7日）の期限切れから戻すため、初回パスワード未設定のユーザーにだけ招待を再送する（R3-13）
      const user = await clients.cognito.send(new AdminGetUserCommand({ UserPoolId: env.USER_POOL_ID, Username: username }));
      if (user.UserStatus !== 'FORCE_CHANGE_PASSWORD') throw conflict('INVITE_NOT_PENDING', 'このユーザーはすでにパスワードを設定済みです');
      await clients.cognito.send(new AdminCreateUserCommand({ UserPoolId: env.USER_POOL_ID, Username: username, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }));
      audit(principal, 'user.invite.resend', userId);
      return success();
    }
    if (parts[0] === 'users' && parts[1] && parts[2] === 'role' && method === 'PUT') {
      adminFeature(principal, 'userManage');
      const { userId } = valid(UserIdParamsSchema, { userId: parts[1] });
      const { role } = valid(UpdateRoleRequestSchema, body);
      rejectSelf(principal, userId);
      const username = await resolveUsername(clients, env, userId);
      await setUserRole(clients, env, username, role);
      await revokeTokens(username, userId);
      audit(principal, 'user.role', userId);
      return success({ userId, role, enabled: true });
    }
    if (parts[0] === 'users' && parts[1] && parts[2] === 'disable' && method === 'POST') {
      adminFeature(principal, 'userManage');
      const { userId } = valid(UserIdParamsSchema, { userId: parts[1] });
      rejectSelf(principal, userId);
      const username = await resolveUsername(clients, env, userId);
      await clients.cognito.send(new AdminDisableUserCommand({ UserPoolId: env.USER_POOL_ID, Username: username }));
      await revokeTokens(username, userId);
      audit(principal, 'user.disable', userId);
      return success();
    }
    if (parts[0] === 'users' && parts[1] && parts[2] === 'enable' && method === 'POST') {
      adminFeature(principal, 'userManage');
      const { userId } = valid(UserIdParamsSchema, { userId: parts[1] });
      const username = await resolveUsername(clients, env, userId);
      await clients.cognito.send(new AdminEnableUserCommand({ UserPoolId: env.USER_POOL_ID, Username: username }));
      audit(principal, 'user.enable', userId);
      return success();
    }
    if (parts[0] === 'users' && parts[1] && parts.length === 2 && method === 'DELETE') {
      adminFeature(principal, 'userManage');
      const { userId } = valid(UserIdParamsSchema, { userId: parts[1] });
      rejectSelf(principal, userId);
      const username = await resolveUsername(clients, env, userId);
      await clients.cognito.send(new AdminDeleteUserCommand({ UserPoolId: env.USER_POOL_ID, Username: username }));
      await revokeTokens(username, userId, false);
      audit(principal, 'user.delete', userId);
      return success();
    }
    return json(404, { error: { code: 'NOT_FOUND', message: '対象が見つかりません' } });
  }

  return async (event: FunctionUrlEvent): Promise<LambdaResponse> => {
    try { return await handle(event); } catch (error) { return failureResponse(error); }
  };
}

/** OWASP CSV Injection: 先頭が = + - @ TAB CR のセルは ' を前置する（R1-15）。 */
function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function toSlide(item: JsonRecord) { return { id: item.id, title: item.title, fileName: item.fileName, size: item.size, order: item.order, filePath: `/files/slides/${item.id}.pdf` }; }
function archivePrefix(item: JsonRecord): string {
  const prefix = String(item.recordingPrefix ?? '').replace(/\/+$/u, '');
  if (!SAFE_PREFIX_PATTERN.test(prefix)) throw new Error(`Archive ${String(item.id)} has an invalid recording prefix`);
  return prefix;
}
function retainUntilOf(item: JsonRecord): string {
  if (typeof item.retainUntil === 'string') return item.retainUntil;
  const createdAt = Date.parse(String(item.createdAt ?? ''));
  return iso((Number.isNaN(createdAt) ? 0 : createdAt) + ARCHIVE_RETENTION_DAYS * DAY_MS);
}
function toArchive(item: JsonRecord) {
  return { id: item.id, title: item.title, published: item.published === true, durationSeconds: Number(item.durationSeconds ?? 0), playbackPath: `/files/archives/${archivePrefix(item)}/media/hls/multivariant.m3u8`, retainUntil: retainUntilOf(item) };
}

async function resolveUsername(clients: Clients, env: Env, userId: string): Promise<string> {
  const response = await clients.cognito.send(new ListUsersCommand({ UserPoolId: env.USER_POOL_ID, Filter: `sub = "${userId.replaceAll('"', '')}"`, Limit: 1 }));
  const user = response.Users?.[0];
  if (!user?.Username) throw notFound();
  return user.Username;
}

async function setUserRole(clients: Clients, env: Env, username: string, role: Role): Promise<void> {
  const groups = await clients.cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: env.USER_POOL_ID, Username: username }));
  for (const group of groups.Groups ?? []) if (group.GroupName && ROLES.includes(group.GroupName as Role)) {
    await clients.cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: env.USER_POOL_ID, Username: username, GroupName: group.GroupName }));
  }
  await clients.cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: env.USER_POOL_ID, Username: username, GroupName: role }));
}

/** ユーザー一覧: ListUsers + ロール毎の ListUsersInGroup(5回) + BatchGet で N+1 を避ける（R1-24）。 */
async function listUsers(clients: Clients, env: Env): Promise<JsonRecord[]> {
  const users = [];
  let PaginationToken: string | undefined;
  do {
    const page = await clients.cognito.send(new ListUsersCommand({ UserPoolId: env.USER_POOL_ID, PaginationToken, Limit: 60 }));
    users.push(...(page.Users ?? []));
    PaginationToken = page.PaginationToken;
  } while (PaginationToken);

  const rolesByUsername = new Map<string, Role[]>();
  for (const role of ROLES) {
    let NextToken: string | undefined;
    do {
      const page = await clients.cognito.send(new ListUsersInGroupCommand({ UserPoolId: env.USER_POOL_ID, GroupName: role, NextToken, Limit: 60 }));
      for (const user of page.Users ?? []) if (user.Username) rolesByUsername.set(user.Username, [...rolesByUsername.get(user.Username) ?? [], role]);
      NextToken = page.NextToken;
    } while (NextToken);
  }

  const userIds = users.map((user) => attribute(user.Attributes, 'sub')).filter((id): id is string => Boolean(id));
  const records = await batchGetUserRecords(clients, env, userIds);
  return users.map((user) => {
    const userId = attribute(user.Attributes, 'sub') ?? '';
    const roles = user.Username ? rolesByUsername.get(user.Username) ?? [] : [];
    // ロールなし・複数ロールは認証で拒否される状態。viewer と偽らず null（要修復）で返す（R2-04）
    const role = RoleSchema.safeParse(roles[0]);
    const profile = records.get(`${KEYS.user(userId)}|PROFILE`) as { commentSuspended?: boolean } | undefined;
    const login = records.get(`${KEYS.user(userId)}|LOGIN`) as { lastLoginAt?: string; loginMethod?: string } | undefined;
    return { userId, email: attribute(user.Attributes, 'email') ?? '', loginMethod: login?.loginMethod ?? loginMethodOf(user.Attributes), role: role.success && roles.length === 1 ? role.data : null, enabled: user.Enabled === true, commentSuspended: profile?.commentSuspended === true, lastLoginAt: login?.lastLoginAt ?? null, invitePending: user.UserStatus === 'FORCE_CHANGE_PASSWORD' };
  });
}

async function batchGetUserRecords(clients: Clients, env: Env, userIds: string[]): Promise<Map<string, JsonRecord>> {
  const records = new Map<string, JsonRecord>();
  const keys = userIds.flatMap((userId) => [{ PK: KEYS.user(userId), SK: 'PROFILE' }, { PK: KEYS.user(userId), SK: 'LOGIN' }]);
  for (let index = 0; index < keys.length; index += 100) {
    let pending: Record<string, unknown>[] | undefined = keys.slice(index, index + 100);
    for (let attempt = 0; pending?.length; attempt += 1) {
      if (attempt >= 5) throw new Error('BatchGetItem left unprocessed keys');
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      const result: BatchGetCommandOutput = await clients.ddb.send(new BatchGetCommand({ RequestItems: { [env.TABLE_NAME]: { Keys: pending } } }));
      for (const item of result.Responses?.[env.TABLE_NAME] ?? []) records.set(`${String(item.PK)}|${String(item.SK)}`, item);
      pending = result.UnprocessedKeys?.[env.TABLE_NAME]?.Keys;
    }
  }
  return records;
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
