import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand,
  AdminEnableUserCommand, AdminGetUserCommand, AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand,
  AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient, ListUsersCommand, ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CreateParticipantTokenCommand, DisconnectParticipantCommand, GetCompositionCommand, GetStageCommand, IVSRealTimeClient, ListParticipantsCommand,
  ListStageSessionsCommand, ListStorageConfigurationsCommand, StartCompositionCommand, StopCompositionCommand,
} from '@aws-sdk/client-ivs-realtime';
import {
  CreateChatTokenCommand, DeleteMessageCommand, DisconnectUserCommand, GetRoomCommand, IvschatClient, ListRoomsCommand, SendEventCommand,
} from '@aws-sdk/client-ivschat';
import {
  DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client,
} from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  BatchGetCommand, BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand,
  TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { vi } from 'vitest';
import { ENV, RECORDING_STORAGE_CONFIGURATION_ARN, REGION, TABLE_INDEXES } from './environment';
import { FakeDynamoDB } from './fake-dynamodb';

const GROUPS = ['admin', 'camera', 'audio', 'presenter', 'viewer'];
const awsError = (name: string, message = name) => Object.assign(new Error(message), { name, $metadata: { httpStatusCode: 400 } });
const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** status: 招待直後は FORCE_CHANGE_PASSWORD、初回パスワードを設定すると CONFIRMED。 */
interface CognitoUser { username: string; sub: string; email: string; enabled: boolean; groups: Set<string>; identities?: string; status: 'FORCE_CHANGE_PASSWORD' | 'CONFIRMED' }

/** Cognito User Pool(ユーザー・グループ)と、そのプールが発行するアクセストークン(RS256 署名)のフェイク。 */
export class FakeCognito {
  readonly users = new Map<string, CognitoUser>();
  readonly signedOut: string[] = [];
  /** MessageAction: RESEND で招待を再送したユーザー名。 */
  readonly resent: string[] = [];
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly kid = 'integration-key';

  get jwks() {
    return { keys: [{ ...(this.keys.publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: this.kid, alg: 'RS256', use: 'sig' }] };
  }

  private pool(id: string | undefined) {
    if (id !== ENV.USER_POOL_ID) throw awsError('ResourceNotFoundException', `User pool ${String(id)} does not exist.`);
  }

  private user(username: string | undefined): CognitoUser {
    const user = username ? this.users.get(username) : undefined;
    if (!user) throw awsError('UserNotFoundException', 'User does not exist.');
    return user;
  }

  /** 招待を経ずに作る既存ユーザー(初期管理者・Okta 連携ユーザーなど)。 */
  seed(email: string, groups: string[], okta = false): CognitoUser {
    const sub = randomUUID();
    const username = okta ? `okta_${sub.slice(0, 8)}` : sub;
    const user: CognitoUser = { username, sub, email, enabled: true, groups: new Set(groups), status: 'CONFIRMED', ...(okta ? { identities: JSON.stringify([{ providerName: 'Okta', providerType: 'OIDC', userId: sub }]) } : {}) };
    this.users.set(username, user);
    return user;
  }

  private attributes(user: CognitoUser) {
    return [{ Name: 'sub', Value: user.sub }, { Name: 'email', Value: user.email }, { Name: 'email_verified', Value: 'true' }, ...(user.identities ? [{ Name: 'identities', Value: user.identities }] : [])];
  }

  /** Username か email エイリアスで引ける(email をサインインエイリアスにしたプール)。 */
  adminGetUser(input: AdminGetUserCommand['input']) {
    this.pool(input.UserPoolId);
    const user = this.users.get(input.Username ?? '') ?? [...this.users.values()].find((candidate) => candidate.email === input.Username);
    if (!user) throw awsError('UserNotFoundException', 'User does not exist.');
    return { Username: user.username, Enabled: user.enabled, UserStatus: user.status, UserAttributes: this.attributes(user) };
  }

  listUsersInGroup(input: ListUsersInGroupCommand['input']) {
    this.pool(input.UserPoolId);
    if (!GROUPS.includes(input.GroupName ?? '')) throw awsError('ResourceNotFoundException', 'Group not found.');
    if ((input.Limit ?? 60) > 60) throw awsError('InvalidParameterException', 'Limit must be <= 60');
    const users = [...this.users.values()].filter((user) => user.groups.has(input.GroupName!));
    const start = Number(input.NextToken ?? 0);
    const limit = input.Limit ?? 60;
    return {
      Users: users.slice(start, start + limit).map((user) => ({ Username: user.username, Enabled: user.enabled, Attributes: this.attributes(user) })),
      ...(start + limit < users.length ? { NextToken: String(start + limit) } : {}),
    };
  }

  byEmail(email: string): CognitoUser {
    const user = [...this.users.values()].find((candidate) => candidate.email === email);
    if (!user) throw new Error(`no user ${email}`);
    return user;
  }

  /**
   * サインイン後に SPA が持つアクセストークン。Cognito のアクセストークンと同じクレーム構成
   * (email・identities は含まれない。グループ未所属なら cognito:groups 自体がない)。
   */
  accessToken(user: CognitoUser, options: { expiresInSeconds?: number; clientId?: string } = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: user.sub,
      ...(user.groups.size ? { 'cognito:groups': [...user.groups] } : {}),
      iss: `https://cognito-idp.${REGION}.amazonaws.com/${ENV.USER_POOL_ID}`,
      client_id: options.clientId ?? ENV.USER_POOL_CLIENT_ID,
      origin_jti: randomUUID(), event_id: randomUUID(), token_use: 'access',
      scope: 'aws.cognito.signin.user.admin', auth_time: now, iat: now, exp: now + (options.expiresInSeconds ?? 3600),
      jti: randomUUID(), username: user.username,
    };
    const unsigned = `${b64url(JSON.stringify({ kid: this.kid, alg: 'RS256' }))}.${b64url(JSON.stringify(payload))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.keys.privateKey as KeyObject);
    return `${unsigned}.${b64url(signature)}`;
  }

  adminCreateUser(input: AdminCreateUserCommand['input']) {
    this.pool(input.UserPoolId);
    if (input.MessageAction === 'RESEND') {
      // 再送は既存ユーザー名で呼ぶ。パスワード設定済みのユーザーには再送できない
      const user = this.user(input.Username);
      if (user.status !== 'FORCE_CHANGE_PASSWORD') throw awsError('UnsupportedUserStateException', 'Resend not possible.');
      this.resent.push(user.username);
      return { User: { Username: user.username, Enabled: user.enabled, UserStatus: user.status, Attributes: this.attributes(user) } };
    }
    const email = input.UserAttributes?.find((attribute) => attribute.Name === 'email')?.Value;
    if (!email || input.Username !== email) throw awsError('InvalidParameterException', 'email alias required');
    if ([...this.users.values()].some((user) => user.email === email)) throw awsError('UsernameExistsException', 'An account with the given email already exists.');
    // email をサインインエイリアスにしたプールでは Username は sub(UUID)になる。
    const sub = randomUUID();
    this.users.set(sub, { username: sub, sub, email, enabled: true, groups: new Set(), status: 'FORCE_CHANGE_PASSWORD' });
    return { User: { Username: sub, Enabled: true, UserStatus: 'FORCE_CHANGE_PASSWORD' as const, Attributes: [{ Name: 'sub', Value: sub }, { Name: 'email', Value: email }] } };
  }

  addToGroup(input: AdminAddUserToGroupCommand['input']) {
    this.pool(input.UserPoolId);
    if (!GROUPS.includes(input.GroupName ?? '')) throw awsError('ResourceNotFoundException', 'Group not found.');
    this.user(input.Username).groups.add(input.GroupName!);
    return {};
  }

  removeFromGroup(input: AdminRemoveUserFromGroupCommand['input']) {
    this.pool(input.UserPoolId);
    this.user(input.Username).groups.delete(input.GroupName!);
    return {};
  }

  listGroups(input: AdminListGroupsForUserCommand['input']) {
    this.pool(input.UserPoolId);
    return { Groups: [...this.user(input.Username).groups].map((GroupName) => ({ GroupName, UserPoolId: ENV.USER_POOL_ID })) };
  }

  listUsers(input: ListUsersCommand['input']) {
    this.pool(input.UserPoolId);
    let users = [...this.users.values()];
    if (input.Filter) {
      const match = /^(sub|email) = "([^"]*)"$/u.exec(input.Filter);
      if (!match) throw awsError('InvalidParameterException', `unsupported filter ${input.Filter}`);
      users = users.filter((user) => user[match[1] as 'sub' | 'email'] === match[2]);
    }
    if ((input.Limit ?? 60) > 60) throw awsError('InvalidParameterException', 'Limit must be <= 60');
    const start = Number(input.PaginationToken ?? 0);
    const limit = input.Limit ?? 60;
    const page = users.slice(start, start + limit);
    return {
      Users: page.map((user) => ({ Username: user.username, Enabled: user.enabled, UserStatus: user.status, Attributes: this.attributes(user) })),
      ...(start + limit < users.length ? { PaginationToken: String(start + limit) } : {}),
    };
  }

  setEnabled(input: { UserPoolId?: string; Username?: string }, enabled: boolean) {
    this.pool(input.UserPoolId);
    this.user(input.Username).enabled = enabled;
    return {};
  }

  deleteUser(input: AdminDeleteUserCommand['input']) {
    this.pool(input.UserPoolId);
    this.users.delete(this.user(input.Username).username);
    return {};
  }
}

interface Participant { participantId: string; userId: string; stageArn: string; capabilities: string[]; published: boolean }

/** IVS Real-Time(ステージ3つ・合成)のフェイク。 */
export class FakeIvs {
  readonly tokens: (Participant & { attributes?: Record<string, string>; duration: number })[] = [];
  readonly connected: Participant[] = [];
  readonly compositions = new Map<string, { arn: string; state: 'ACTIVE' | 'STOPPED'; recordingPrefix: string; startTime: Date; endTime?: Date; idempotencyToken?: string }>();
  activeSessionId: string | undefined;
  private readonly stages = [ENV.STAGE_PRODUCTION_ARN, ENV.STAGE_SLIDE_ARN, ENV.STAGE_BROADCAST_ARN] as string[];

  private stage(arn: string | undefined) {
    if (!arn || !this.stages.includes(arn)) throw awsError('ResourceNotFoundException', `stage ${String(arn)}`);
  }

  createToken(input: CreateParticipantTokenCommand['input']) {
    this.stage(input.stageArn);
    const duration = input.duration ?? 720;
    if (duration < 1 || duration > 20160) throw awsError('ValidationException', 'duration');
    const attributes = input.attributes;
    if (attributes && JSON.stringify(attributes).length > 1000) throw awsError('ValidationException', 'attributes too large');
    const participantId = randomUUID().slice(0, 12);
    const capabilities = input.capabilities ?? ['PUBLISH', 'SUBSCRIBE'];
    this.tokens.push({ participantId, userId: input.userId ?? '', stageArn: input.stageArn!, capabilities, published: false, duration, ...(attributes ? { attributes } : {}) });
    return {
      participantToken: {
        participantId, token: `ivs-token-${participantId}`, userId: input.userId, attributes, duration, capabilities,
        expirationTime: new Date(Date.now() + duration * 60_000),
      },
    };
  }

  /** 視聴者がトークンでブロードキャストステージに接続したことにする。 */
  connect(participantId: string, published = false) {
    const token = this.tokens.find((candidate) => candidate.participantId === participantId);
    if (!token) throw new Error(`unknown participant ${participantId}`);
    this.connected.push({ ...token, published });
  }

  getStage(input: GetStageCommand['input']) {
    this.stage(input.arn);
    return { stage: { arn: input.arn, ...(input.arn === ENV.STAGE_BROADCAST_ARN && this.activeSessionId ? { activeSessionId: this.activeSessionId } : {}) } };
  }

  listParticipants(input: ListParticipantsCommand['input']) {
    this.stage(input.stageArn);
    if (input.sessionId !== this.activeSessionId) throw awsError('ResourceNotFoundException', 'session');
    if ((input.maxResults ?? 50) > 100) throw awsError('ValidationException', 'maxResults');
    const all = this.connected.filter((participant) => participant.stageArn === input.stageArn);
    const start = Number(input.nextToken ?? 0);
    const size = input.maxResults ?? 50;
    return {
      participants: all.slice(start, start + size).map((participant) => ({ participantId: participant.participantId, userId: participant.userId, state: 'CONNECTED' as const, published: participant.published })),
      ...(start + size < all.length ? { nextToken: String(start + size) } : {}),
    };
  }

  listSessions(input: ListStageSessionsCommand['input']) {
    this.stage(input.stageArn);
    return { stageSessions: input.stageArn === ENV.STAGE_BROADCAST_ARN && this.activeSessionId ? [{ sessionId: this.activeSessionId }] : [] };
  }

  startComposition(input: StartCompositionCommand['input']) {
    if (input.stageArn !== ENV.STAGE_BROADCAST_ARN) throw awsError('ValidationException', 'composition must use the broadcast stage');
    const s3 = input.destinations?.[0]?.s3;
    if (s3?.storageConfigurationArn !== RECORDING_STORAGE_CONFIGURATION_ARN) throw awsError('ValidationException', 'storageConfigurationArn');
    if (JSON.stringify(s3.encoderConfigurationArns) !== JSON.stringify([ENV.ENCODER_CONFIGURATION_ARN])) throw awsError('ValidationException', 'encoderConfigurationArns');
    if (s3.recordingConfiguration?.hlsConfiguration?.targetSegmentDurationSeconds !== 10) throw awsError('ValidationException', 'hls segment');
    if ([...this.compositions.values()].some((composition) => composition.state === 'ACTIVE')) throw awsError('ConflictException', 'composition already active');
    const id = randomUUID().slice(0, 12);
    this.activeSessionId = `st-${id}`;
    const arn = `arn:aws:ivs:${REGION}:123456789012:composition/${id}`;
    const recordingPrefix = `broadcast/${this.activeSessionId}/${id}/composite`;
    this.compositions.set(arn, { arn, state: 'ACTIVE', recordingPrefix, startTime: new Date(), ...(input.idempotencyToken ? { idempotencyToken: input.idempotencyToken } : {}) });
    return { composition: { arn, stageArn: input.stageArn, state: 'ACTIVE' as const, layout: {}, destinations: [{ id: 'dest', state: 'STARTING' as const, configuration: {}, detail: { s3: { recordingPrefix } } }] } };
  }

  readonly disconnected: { stageArn: string; participantId: string }[] = [];

  disconnectParticipant(input: DisconnectParticipantCommand['input']) {
    this.stage(input.stageArn);
    if (!input.participantId) throw awsError('ValidationException', 'participantId');
    this.disconnected.push({ stageArn: input.stageArn!, participantId: input.participantId });
    const index = this.connected.findIndex((participant) => participant.participantId === input.participantId);
    if (index >= 0) this.connected.splice(index, 1);
    return {};
  }

  /** 全参加者の切断から一定時間後に IVS が合成を自動終了した状態にする。 */
  autoEnd(arn: string) {
    const composition = this.compositions.get(arn)!;
    composition.state = 'STOPPED';
    composition.endTime = new Date();
    this.activeSessionId = undefined;
  }

  stopComposition(input: StopCompositionCommand['input']) {
    const composition = input.arn ? this.compositions.get(input.arn) : undefined;
    // 終了済みの合成は停止できない(自動終了後の StopComposition は ResourceNotFound)。
    if (!composition || composition.state !== 'ACTIVE') throw awsError('ResourceNotFoundException', 'composition');
    composition.state = 'STOPPED';
    composition.endTime = new Date();
    return {};
  }

  /** 2ページに分けて返し、API がページングして名前で選ぶことを確かめる。 */
  listStorageConfigurations(input: ListStorageConfigurationsCommand['input']) {
    if (!input.nextToken) return { storageConfigurations: [{ name: 'other-recording', arn: `${RECORDING_STORAGE_CONFIGURATION_ARN}-other` }], nextToken: 'page2' };
    return { storageConfigurations: [{ name: ENV.RECORDING_STORAGE_CONFIGURATION_NAME, arn: RECORDING_STORAGE_CONFIGURATION_ARN }] };
  }

  getComposition(input: GetCompositionCommand['input']) {
    const composition = input.arn ? this.compositions.get(input.arn) : undefined;
    if (!composition) throw awsError('ResourceNotFoundException', 'composition');
    return { composition: { arn: composition.arn, stageArn: ENV.STAGE_BROADCAST_ARN, state: composition.state, layout: {}, startTime: composition.startTime, endTime: composition.endTime, destinations: [{ id: 'dest', state: 'STOPPED' as const, configuration: {}, detail: { s3: { recordingPrefix: composition.recordingPrefix } } }] } };
  }
}

/** IVS Chat(ルーム1つ)のフェイク。送信イベント・削除・切断を記録する。 */
export class FakeChat {
  readonly events: { eventName: string; attributes?: Record<string, string> }[] = [];
  readonly tokens: { userId: string; capabilities: string[]; attributes?: Record<string, string> }[] = [];
  readonly deleted: string[] = [];
  readonly disconnected: string[] = [];

  private room(identifier: string | undefined) {
    if (identifier !== ENV.CHAT_ROOM_ARN) throw awsError('ResourceNotFoundException', `room ${String(identifier)}`);
  }

  private failures = 0;

  /** 次の n 回の SendEvent を一時障害で失敗させる（再試行の検証用）。 */
  failNextSends(count = 1) { this.failures = count; }

  sendEvent(input: SendEventCommand['input']) {
    this.room(input.roomIdentifier);
    if (this.failures > 0) { this.failures -= 1; throw awsError('ThrottlingException', 'chat unavailable'); }
    this.events.push({ eventName: input.eventName!, ...(input.attributes ? { attributes: input.attributes } : {}) });
    return { id: randomUUID() };
  }

  createToken(input: CreateChatTokenCommand['input']) {
    this.room(input.roomIdentifier);
    if (!input.userId) throw awsError('ValidationException', 'userId');
    if ((input.sessionDurationInMinutes ?? 60) > 180) throw awsError('ValidationException', 'sessionDurationInMinutes');
    this.tokens.push({ userId: input.userId, capabilities: input.capabilities ?? [], ...(input.attributes ? { attributes: input.attributes } : {}) });
    return { token: `chat-token-${this.tokens.length}`, sessionExpirationTime: new Date(Date.now() + 3_600_000), tokenExpirationTime: new Date(Date.now() + 120_000) };
  }

  deleteMessage(input: DeleteMessageCommand['input']) {
    this.room(input.roomIdentifier);
    this.deleted.push(input.id!);
    return { id: randomUUID() };
  }

  disconnectUser(input: DisconnectUserCommand['input']) {
    this.room(input.roomIdentifier);
    this.disconnected.push(input.userId!);
    return {};
  }

  /** name は部分一致のフィルタ。名前の似た別ルームも返し、API が完全一致で選ぶことを確かめる。 */
  listRooms(input: ListRoomsCommand['input']) {
    const rooms = [{ name: `${ENV.CHAT_ROOM_NAME}-old`, arn: `${ENV.CHAT_ROOM_ARN}-old` }, { name: ENV.CHAT_ROOM_NAME, arn: ENV.CHAT_ROOM_ARN }];
    return { rooms: rooms.filter((room) => !input.name || room.name.includes(input.name)) };
  }

  getRoom(input: GetRoomCommand['input']) {
    this.room(input.identifier);
    return { arn: ENV.CHAT_ROOM_ARN, maximumMessageLength: 200 };
  }
}

interface StoredObject { body: Buffer; contentType: string }

/** S3(コンテンツ・録画バケット)のフェイク。presigned POST のポリシー条件を検証してアップロードを受け付ける。 */
export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  private readonly buckets: string[] = [ENV.CONTENT_BUCKET, ENV.RECORDING_BUCKET];

  private bucket(name: string | undefined) {
    if (!name || !this.buckets.includes(name)) throw awsError('NoSuchBucket', String(name));
  }

  put(bucket: string, key: string, body: Buffer | string, contentType = 'application/octet-stream') {
    this.bucket(bucket);
    this.objects.set(`${bucket}/${key}`, { body: Buffer.from(body), contentType });
  }

  keys(bucket: string): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(`${bucket}/`)).map((key) => key.slice(bucket.length + 1));
  }

  /**
   * ブラウザが presigned POST でアップロードしたことにする。S3 と同じく policy の
   * 条件(bucket・key・Content-Type・content-length-range・有効期限)を満たさなければ拒否する。
   */
  presignedUpload(url: string, fields: Record<string, string>, file: { body: Buffer; contentType: string }): { status: number } {
    const bucket = new URL(url).hostname.split('.')[0]!;
    const policy = JSON.parse(Buffer.from(fields.Policy ?? '', 'base64').toString('utf8')) as { expiration: string; conditions: unknown[] };
    if (Date.parse(policy.expiration) < Date.now()) return { status: 403 };
    for (const condition of policy.conditions) {
      if (Array.isArray(condition)) {
        const [operator, field, value] = condition as [string, string, unknown];
        if (operator === 'content-length-range' && (file.body.length < Number(field) || file.body.length > Number(value))) return { status: 400 };
        if (operator === 'eq' && field === '$Content-Type' && (fields['Content-Type'] !== value || file.contentType !== value)) return { status: 403 };
      } else {
        const entries = Object.entries(condition as Record<string, string>);
        for (const [name, value] of entries) {
          if (name === 'bucket' && value !== bucket) return { status: 403 };
          if (name === 'key' && fields.key !== value) return { status: 403 };
        }
      }
    }
    this.put(bucket, fields.key!, file.body, fields['Content-Type']);
    return { status: 204 };
  }

  head(input: HeadObjectCommand['input']) {
    this.bucket(input.Bucket);
    const object = this.objects.get(`${input.Bucket}/${input.Key}`);
    if (!object) throw awsError('NotFound');
    return { ContentLength: object.body.length, ContentType: object.contentType };
  }

  get(input: GetObjectCommand['input']) {
    this.bucket(input.Bucket);
    const object = this.objects.get(`${input.Bucket}/${input.Key}`);
    if (!object) throw awsError('NoSuchKey');
    const range = input.Range ? /^bytes=(\d+)-(\d+)$/u.exec(input.Range) : null;
    const body = range ? object.body.subarray(Number(range[1]), Number(range[2]) + 1) : object.body;
    return { ContentType: object.contentType, ContentLength: body.length, Body: { transformToByteArray: async () => new Uint8Array(body), transformToString: async () => body.toString('utf8') } };
  }

  /** 1ページ2件。継続トークンは最後に返したキー(本物と同じく、途中で削除されても取りこぼさない)。 */
  list(input: ListObjectsV2Command['input']) {
    this.bucket(input.Bucket);
    const keys = this.keys(input.Bucket!).filter((key) => key.startsWith(input.Prefix ?? '') && (!input.ContinuationToken || key > input.ContinuationToken)).sort();
    const page = keys.slice(0, 2);
    const truncated = keys.length > 2;
    return { Contents: page.map((Key) => ({ Key })), KeyCount: page.length, IsTruncated: truncated, ...(truncated ? { NextContinuationToken: page.at(-1) } : {}) };
  }

  deleteObjects(input: DeleteObjectsCommand['input']) {
    this.bucket(input.Bucket);
    const objects = input.Delete?.Objects ?? [];
    if (objects.length === 0 || objects.length > 1000) throw awsError('MalformedXML');
    for (const { Key } of objects) this.objects.delete(`${input.Bucket}/${Key}`);
    return { Deleted: objects };
  }
}

export interface World {
  db: FakeDynamoDB;
  cognito: FakeCognito;
  ivs: FakeIvs;
  chat: FakeChat;
  s3: FakeS3;
  /** SSM SecureString に置いた CloudFront 署名用秘密鍵(PEM)。 */
  cloudFrontPrivateKey: string;
}

const mocks = {
  ddb: mockClient(DynamoDBDocumentClient),
  cognito: mockClient(CognitoIdentityProviderClient),
  ivs: mockClient(IVSRealTimeClient),
  chat: mockClient(IvschatClient),
  s3: mockClient(S3Client),
  ssm: mockClient(SSMClient),
};
let current: World | undefined;

// 本物の JWT 検証(署名・iss・client_id・token_use・exp)を通すため、検証の直前にフェイクの JWKS を
// キャッシュさせる(JWKS の HTTPS 取得だけを置き換える)。Verifier の生成場所(呼び出し毎/モジュール)に依存しない。
const originalVerify = CognitoJwtVerifier.prototype.verify;
vi.spyOn(CognitoJwtVerifier.prototype, 'verify').mockImplementation(function (this: CognitoJwtVerifier<never, never, false>, ...args: Parameters<typeof originalVerify>) {
  if (current) this.cacheJwks(current.cognito.jwks as never);
  return originalVerify.apply(this, args);
} as typeof originalVerify);

/** すべての AWS SDK クライアント(全インスタンス)をフェイクへ配線した新しい世界を作る。 */
export function createWorld(): World {
  for (const mock of Object.values(mocks)) mock.reset();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const world: World = {
    db: new FakeDynamoDB(ENV.TABLE_NAME, TABLE_INDEXES),
    cognito: new FakeCognito(),
    ivs: new FakeIvs(),
    chat: new FakeChat(),
    s3: new FakeS3(),
    cloudFrontPrivateKey: privateKey.export({ format: 'pem', type: 'pkcs1' }).toString(),
  };
  current = world;
  const { db, cognito, ivs, chat, s3 } = world;
  mocks.ddb.on(GetCommand).callsFake((input) => db.get(input))
    .on(PutCommand).callsFake((input) => db.put(input))
    .on(UpdateCommand).callsFake((input) => db.update(input))
    .on(DeleteCommand).callsFake((input) => db.delete(input))
    .on(ScanCommand).callsFake((input) => db.scan(input))
    .on(QueryCommand).callsFake((input) => db.query(input))
    .on(BatchGetCommand).callsFake((input) => db.batchGet(input))
    .on(BatchWriteCommand).callsFake((input) => db.batchWrite(input))
    .on(TransactWriteCommand).callsFake((input) => db.transactWrite(input));
  mocks.cognito.on(AdminCreateUserCommand).callsFake((input) => cognito.adminCreateUser(input))
    .on(AdminAddUserToGroupCommand).callsFake((input) => cognito.addToGroup(input))
    .on(AdminRemoveUserFromGroupCommand).callsFake((input) => cognito.removeFromGroup(input))
    .on(AdminListGroupsForUserCommand).callsFake((input) => cognito.listGroups(input))
    .on(ListUsersCommand).callsFake((input) => cognito.listUsers(input))
    .on(ListUsersInGroupCommand).callsFake((input) => cognito.listUsersInGroup(input))
    .on(AdminGetUserCommand).callsFake((input) => cognito.adminGetUser(input))
    .on(AdminDisableUserCommand).callsFake((input) => cognito.setEnabled(input, false))
    .on(AdminEnableUserCommand).callsFake((input) => cognito.setEnabled(input, true))
    .on(AdminDeleteUserCommand).callsFake((input) => cognito.deleteUser(input))
    .on(AdminUserGlobalSignOutCommand).callsFake((input) => { cognito.signedOut.push(input.Username!); return {}; });
  mocks.ivs.on(CreateParticipantTokenCommand).callsFake((input) => ivs.createToken(input))
    .on(DisconnectParticipantCommand).callsFake((input) => ivs.disconnectParticipant(input))
    .on(GetStageCommand).callsFake((input) => ivs.getStage(input))
    .on(ListParticipantsCommand).callsFake((input) => ivs.listParticipants(input))
    .on(ListStageSessionsCommand).callsFake((input) => ivs.listSessions(input))
    .on(StartCompositionCommand).callsFake((input) => ivs.startComposition(input))
    .on(StopCompositionCommand).callsFake((input) => ivs.stopComposition(input))
    .on(GetCompositionCommand).callsFake((input) => ivs.getComposition(input))
    .on(ListStorageConfigurationsCommand).callsFake((input) => ivs.listStorageConfigurations(input));
  mocks.chat.on(SendEventCommand).callsFake((input) => chat.sendEvent(input))
    .on(CreateChatTokenCommand).callsFake((input) => chat.createToken(input))
    .on(DeleteMessageCommand).callsFake((input) => chat.deleteMessage(input))
    .on(DisconnectUserCommand).callsFake((input) => chat.disconnectUser(input))
    .on(GetRoomCommand).callsFake((input) => chat.getRoom(input))
    .on(ListRoomsCommand).callsFake((input) => chat.listRooms(input));
  mocks.s3.on(HeadObjectCommand).callsFake((input) => s3.head(input))
    .on(GetObjectCommand).callsFake((input) => s3.get(input))
    .on(ListObjectsV2Command).callsFake((input) => s3.list(input))
    .on(DeleteObjectsCommand).callsFake((input) => s3.deleteObjects(input));
  mocks.ssm.on(GetParameterCommand).callsFake((input) => {
    if (input.Name !== ENV.CLOUDFRONT_PRIVATE_KEY_PARAMETER || input.WithDecryption !== true) throw awsError('ParameterNotFound');
    return { Parameter: { Name: input.Name, Type: 'SecureString', Value: world.cloudFrontPrivateKey } };
  });
  return world;
}
