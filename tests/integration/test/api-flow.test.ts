import { CLOUDFRONT_HOST, ENV } from './support/environment';
import './support/fake-clock';
import { createVerify } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARCHIVE_RETENTION_DAYS, ArchivesResponseSchema, BroadcastSchema, EmptyResponseSchema, HeartbeatResponseSchema, MeResponseSchema,
  RecentCommentsResponseSchema, SLIDE_MAX_BYTES, SlideSchema, SlidesResponseSchema, SlideUploadUrlResponseSchema,
  StageTokenResponseSchema, StatusResponseSchema, UserInviteResponseSchema, UsersResponseSchema, ViewerCountResponseSchema,
} from '@delivery/shared';
import { handler as apiHandler } from '../../../apps/api/src/index';
import { handler as chatReviewHandler, type ChatReviewEvent } from '../../../apps/api/src/chat-review';
import { handler as recordingHandler } from '../../../apps/api/src/recording';
import { handler as cognitoHandler } from '../../../apps/api/src/cognito';
import { createWorld, type World } from './support/fake-aws';
import { apiCaller } from './support/lambda';

const api = apiCaller(apiHandler);
const T0 = Date.parse('2026-10-19T09:00:00.000Z');
const BOM = String.fromCharCode(0xfeff);
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
const pdf = (size = 1024) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(size - 9, 0x20)]);
type Json = Record<string, unknown>;
const errorCode = (result: { json: unknown }) => (result.json as { error?: { code?: string } } | undefined)?.error?.code;

let world: World;
/** サインイン: Cognito が PostAuthentication トリガーを呼んだ後、SPA がアクセストークンを受け取る。 */
async function login(email: string): Promise<string> {
  const user = world.cognito.byEmail(email);
  await cognitoHandler({
    userPoolId: ENV.USER_POOL_ID, userName: user.username, triggerSource: 'PostAuthentication_Authentication',
    request: { userAttributes: { sub: user.sub, email: user.email, ...(user.identities ? { identities: user.identities } : {}) } }, response: {},
  });
  return world.cognito.accessToken(user);
}
const recordingEvent = (compositionArn: string, eventName = 'Session End') => ({
  source: 'aws.ivs', 'detail-type': 'IVS Composition State Change', time: new Date(Date.now()).toISOString(),
  resources: [compositionArn], detail: { event_name: eventName, stage_arn: ENV.STAGE_BROADCAST_ARN },
});
const nonUserRows = () => [...world.db.items.values()].filter((item) => !String(item.PK).startsWith('USER#'));

/** Set-Cookie を 名前 → { value, attributes } にする。 */
const parseSetCookies = (cookies: string[] = []) => Object.fromEntries(cookies.map((cookie) => {
  const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
  const index = pair!.indexOf('=');
  return [pair!.slice(0, index), { value: pair!.slice(index + 1), attributes }];
}));
const fromCloudFrontBase64 = (value: string) => Buffer.from(value.replaceAll('-', '+').replaceAll('_', '=').replaceAll('~', '/'), 'base64');
/**
 * Resource にワイルドカードを使う署名付き Cookie はカスタムポリシー(CloudFront-Policy)でなければ効かない
 * (既定ポリシー = CloudFront-Expires は1オブジェクト専用)。ポリシー内容・Path・SSM の鍵での署名を検証する。
 */
function expectCustomPolicyCookies(cookies: string[] | undefined, resource: string, path: string) {
  const jar = parseSetCookies(cookies);
  expect(Object.keys(jar).sort()).toEqual(['CloudFront-Key-Pair-Id', 'CloudFront-Policy', 'CloudFront-Signature']);
  expect(jar['CloudFront-Key-Pair-Id']!.value).toBe(ENV.CLOUDFRONT_KEY_PAIR_ID);
  for (const cookie of Object.values(jar)) expect(cookie.attributes).toEqual(expect.arrayContaining([`Path=${path}`, 'Secure', 'HttpOnly']));
  const policy = fromCloudFrontBase64(jar['CloudFront-Policy']!.value);
  expect(JSON.parse(policy.toString('utf8'))).toEqual({ Statement: [{ Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': Math.floor(Date.now() / 1000) + 3600 } } }] });
  expect(createVerify('RSA-SHA1').update(policy).verify(world.cloudFrontPrivateKey, fromCloudFrontBase64(jar['CloudFront-Signature']!.value))).toBe(true);
}

beforeAll(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  if (!process.env.INTEGRATION_DEBUG) vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  vi.setSystemTime(T0);
  world = createWorld();
  world.cognito.seed('admin@example.com', ['admin']);
});

describe('ユーザー招待 → ロール変更 → ステージトークン(送信枠)', () => {
  it('招待したユーザーを camera にすると6台まで送信でき、7台目は 409、解放・失効で再取得できる', async () => {
    const admin = await login('admin@example.com');
    const invited = await api('POST', '/users/invite', { token: admin, body: { emails: ['cam@example.com', 'cam2@example.com'], role: 'viewer' } });
    expect(invited.statusCode).toBe(200);
    expect(UserInviteResponseSchema.parse(invited.json)).toEqual({ invited: ['cam@example.com', 'cam2@example.com'], failed: [] });
    // 既存アドレスを含む招待は部分成功を返す(R1-11)。
    const partial = await api('POST', '/users/invite', { token: admin, body: { emails: ['cam@example.com', 'new@example.com'], role: 'viewer' } });
    expect(UserInviteResponseSchema.parse(partial.json)).toEqual({ invited: ['new@example.com'], failed: [{ email: 'cam@example.com', reason: 'ALREADY_EXISTS' }] });

    const cam = world.cognito.byEmail('cam@example.com');
    expect([...cam.groups]).toEqual(['viewer']);
    // ログイン(PostAuthentication)で最終ログインが記録され、ユーザー一覧に出る。
    const viewerToken = await login('cam@example.com');
    const users = UsersResponseSchema.parse((await api('GET', '/users', { token: admin })).json);
    expect(users.find((user) => user.userId === cam.sub)).toEqual({ userId: cam.sub, email: 'cam@example.com', loginMethod: 'email', role: 'viewer', enabled: true, commentSuspended: false, lastLoginAt: new Date(T0).toISOString() });
    // アクセストークンに email は無いが、/api/me は Cognito 側の値で補って返す(R1-01)。
    expect(MeResponseSchema.parse((await api('GET', '/me', { token: viewerToken })).json)).toMatchObject({ userId: cam.sub, email: 'cam@example.com', role: 'viewer', loginMethod: 'email' });

    expect((await api('POST', '/tokens/stage', { token: viewerToken, body: { purpose: 'camera', deviceName: 'CAM1' } })).statusCode).toBe(403);

    const changed = await api('PUT', `/users/${cam.sub}/role`, { token: admin, body: { role: 'camera' } });
    expect(changed.json).toEqual({ userId: cam.sub, role: 'camera', enabled: true });
    expect([...cam.groups]).toEqual(['camera']);
    // ロール変更前のトークンは失効し、再ログインを求める(R1-09)。
    expect(world.cognito.signedOut).toContain(cam.username);
    expect(errorCode(await api('GET', '/me', { token: viewerToken }))).toBe('TOKEN_REFRESH_REQUIRED');

    // 再ログインした利用者として送信枠を確保する。
    advance(1_000);
    const camToken = await login('cam@example.com');
    expect(MeResponseSchema.parse((await api('GET', '/me', { token: camToken })).json)).toMatchObject({ userId: cam.sub, email: 'cam@example.com', role: 'camera' });
    const deviceIds: string[] = [];
    for (let n = 1; n <= 6; n += 1) {
      const result = await api('POST', '/tokens/stage', { token: camToken, body: { purpose: 'camera', deviceName: `CAM${n}` } });
      expect(result.statusCode).toBe(200);
      const body = StageTokenResponseSchema.parse(result.json);
      expect(body.tokens).toEqual([expect.objectContaining({ stage: 'production', capabilities: ['PUBLISH'] })]);
      deviceIds.push(body.deviceId!);
    }
    expect(world.ivs.tokens.map((token) => token.attributes)).toEqual([1, 2, 3, 4, 5, 6].map((n) => ({ kind: 'camera', deviceName: `CAM${n}` })));
    expect(world.ivs.tokens.every((token) => token.stageArn === ENV.STAGE_PRODUCTION_ARN && token.userId === cam.sub)).toBe(true);

    const seventh = await api('POST', '/tokens/stage', { token: camToken, body: { purpose: 'camera', deviceName: 'CAM7' } });
    expect(seventh.statusCode).toBe(409);
    expect(errorCode(seventh)).toBe('DEVICE_LIMIT');
    expect(world.ivs.tokens).toHaveLength(6);

    // 解放した枠は再取得できる。他人の端末は解放・延長できず、稼働中の端末名は使えない(R1-18)。
    const other = world.cognito.byEmail('cam2@example.com');
    await api('PUT', `/users/${other.sub}/role`, { token: admin, body: { role: 'camera' } });
    advance(1_000);
    const otherToken = await login('cam2@example.com');
    expect((await api('DELETE', `/devices/${deviceIds[1]}`, { token: otherToken })).statusCode).toBe(403);
    expect((await api('POST', `/devices/${deviceIds[1]}/heartbeat`, { token: otherToken, body: {} })).statusCode).toBe(404);
    expect(EmptyResponseSchema.parse((await api('DELETE', `/devices/${deviceIds[1]}`, { token: camToken })).json)).toEqual({ success: true });
    expect(errorCode(await api('POST', '/tokens/stage', { token: otherToken, body: { purpose: 'camera', deviceName: 'CAM1' } }))).toBe('DEVICE_NAME_IN_USE');
    const reacquired = await api('POST', '/tokens/stage', { token: camToken, body: { purpose: 'camera', deviceName: 'CAM2' } });
    expect(reacquired.statusCode).toBe(200);
    deviceIds[1] = StageTokenResponseSchema.parse(reacquired.json).deviceId!;
    expect((await api('POST', '/tokens/stage', { token: camToken, body: { purpose: 'camera', deviceName: 'CAM7' } })).statusCode).toBe(409);

    // 15秒ごとのハートビートで延長した枠は残り、止めた枠(CAM6)は45秒で失効して再取得できる。
    // 失効した端末の IVS 接続は切断してから枠を再利用する(R1-07)。
    const cam6Participant = world.ivs.tokens.find((token) => token.attributes?.deviceName === 'CAM6')!.participantId;
    world.ivs.connect(cam6Participant, true);
    for (let tick = 0; tick < 3; tick += 1) {
      advance(15_000);
      for (const id of deviceIds.slice(0, 5)) {
        const beat = await api('POST', `/devices/${id}/heartbeat`, { token: camToken, body: {} });
        expect(beat.statusCode).toBe(200);
        expect(Date.parse(HeartbeatResponseSchema.parse(beat.json).expiresAt)).toBe(Math.floor(Date.now() / 1000) * 1000 + 45_000);
      }
    }
    advance(1_000);
    const devices = (await api('GET', '/devices', { token: admin })).json as Json[];
    expect(devices.map((device) => device.deviceName).sort()).toEqual(['CAM1', 'CAM2', 'CAM3', 'CAM4', 'CAM5']);
    const afterExpiry = await api('POST', '/tokens/stage', { token: camToken, body: { purpose: 'camera', deviceName: 'CAM6' } });
    expect(afterExpiry.statusCode).toBe(200);
    expect(world.ivs.disconnected).toContainEqual({ stageArn: ENV.STAGE_PRODUCTION_ARN, participantId: cam6Participant });
    expect(world.ivs.connected.map((participant) => participant.participantId)).not.toContain(cam6Participant);
    expect((await api('POST', '/tokens/stage', { token: camToken, body: { purpose: 'camera', deviceName: 'CAM7' } })).statusCode).toBe(409);
  });

  it('Okta ユーザーは初回サインイン(PostConfirmation)で viewer になり、ログイン方式と最終ログインが記録される(R1-20)', async () => {
    const admin = await login('admin@example.com');
    const okta = world.cognito.seed('okta-user@example.com', [], true);
    await cognitoHandler({
      userPoolId: ENV.USER_POOL_ID, userName: okta.username, triggerSource: 'PostConfirmation_ConfirmSignUp',
      request: { userAttributes: { sub: okta.sub, email: okta.email, identities: okta.identities! } }, response: {},
    });
    expect([...okta.groups]).toEqual(['viewer']);
    const users = UsersResponseSchema.parse((await api('GET', '/users', { token: admin })).json);
    expect(users.find((user) => user.userId === okta.sub)).toMatchObject({ loginMethod: 'Okta', role: 'viewer', lastLoginAt: new Date(T0).toISOString() });
    expect(MeResponseSchema.parse((await api('GET', '/me', { token: world.cognito.accessToken(okta) })).json)).toMatchObject({ email: 'okta-user@example.com', loginMethod: 'Okta' });
  });

  it('スイッチャーは端末枠を使わず、何度でも3ステージ分のトークンを取得できる(R1-02)。/api/status は3ステージとルームを報告する(R1-06)', async () => {
    const admin = await login('admin@example.com');
    for (let n = 0; n < 2; n += 1) {
      const result = StageTokenResponseSchema.parse((await api('POST', '/tokens/stage', { token: admin, body: { purpose: 'switcher' } })).json);
      expect(Object.fromEntries(result.tokens.map((token) => [token.stage, token.capabilities]))).toEqual({ production: ['SUBSCRIBE'], slide: ['SUBSCRIBE'], broadcast: ['PUBLISH'] });
      expect(result.deviceId).toBeUndefined();
    }
    expect(world.db.byPrefix('DEVICE#')).toEqual([]);
    const status = StatusResponseSchema.parse((await api('GET', '/status', { token: admin })).json);
    expect(status.stages.map((stage) => [stage.name, stage.exists])).toEqual([['production', true], ['slide', true], ['broadcast', true]]);
    expect(status.chatRoom.exists).toBe(true);
  });

  it('IVS のトークン発行に失敗したら確保した枠を戻す(枠が漏れない)', async () => {
    const admin = await login('admin@example.com');
    const original = world.ivs.createToken.bind(world.ivs);
    let fail = true;
    world.ivs.createToken = (input) => {
      if (fail) throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
      return original(input);
    };
    expect((await api('POST', '/tokens/stage', { token: admin, body: { purpose: 'slide' } })).statusCode).toBe(500);
    expect(world.db.byPrefix('DEVICE#')).toEqual([]);
    fail = false;
    expect((await api('POST', '/tokens/stage', { token: admin, body: { purpose: 'slide' } })).statusCode).toBe(200);
    expect((await api('POST', '/tokens/stage', { token: admin, body: { purpose: 'slide' } })).statusCode).toBe(409);
  });
});

describe('スライド: upload-url → アップロード → complete → 一覧 → 並べ替え → 削除', () => {
  async function upload(admin: string, title: string, body: Buffer, contentType = 'application/pdf') {
    const created = await api('POST', '/slides/upload-url', { token: admin, body: { title, fileName: `${title}.pdf`, size: body.length, contentType: 'application/pdf' } });
    expect(created.statusCode).toBe(200);
    const { slideId, url, fields } = SlideUploadUrlResponseSchema.parse(created.json);
    expect(fields.key).toBe(`slides/${slideId}.pdf`);
    return { slideId, uploaded: world.s3.presignedUpload(url, fields, { body, contentType }) };
  }

  it('%PDF- で始まる PDF だけを公開し、表示順の変更と削除が一覧に反映される', async () => {
    const admin = await login('admin@example.com');
    world.cognito.seed('viewer@example.com', ['viewer']);
    const viewer = await login('viewer@example.com');

    const ids: string[] = [];
    for (const title of ['資料A', '資料B', '資料C']) {
      const { slideId, uploaded } = await upload(admin, title, pdf());
      expect(uploaded.status).toBe(204);
      const completed = await api('POST', `/slides/${slideId}/complete`, { token: admin });
      expect(completed.statusCode).toBe(200);
      expect(SlideSchema.parse(completed.json)).toMatchObject({ id: slideId, title, filePath: `/files/slides/${slideId}.pdf` });
      ids.push(slideId);
    }
    // 偽装ファイル(中身が PDF でない)は complete で拒否され、一覧に出ない。
    const fake = await upload(admin, '偽装', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(1018)]));
    expect(fake.uploaded.status).toBe(204);
    const rejected = await api('POST', `/slides/${fake.slideId}/complete`, { token: admin });
    expect(rejected.statusCode).toBe(400);
    expect(errorCode(rejected)).toBe('VALIDATION_ERROR');
    // 申告サイズと実ファイルが違う場合も拒否する。
    const created = await api('POST', '/slides/upload-url', { token: admin, body: { title: 'サイズ違い', fileName: 'x.pdf', size: 2048, contentType: 'application/pdf' } });
    const mismatch = SlideUploadUrlResponseSchema.parse(created.json);
    world.s3.presignedUpload(mismatch.url, mismatch.fields, { body: pdf(1024), contentType: 'application/pdf' });
    expect((await api('POST', `/slides/${mismatch.slideId}/complete`, { token: admin })).statusCode).toBe(400);

    const titles = async () => SlidesResponseSchema.parse((await api('GET', '/slides', { token: viewer })).json).map((slide) => slide.title);
    expect(await titles()).toEqual(['資料A', '資料B', '資料C']);

    expect((await api('PUT', '/slides/order', { token: admin, body: { ids: [ids[2], ids[0], ids[1]] } })).json).toEqual({ success: true });
    expect(await titles()).toEqual(['資料C', '資料A', '資料B']);

    const renamed = await api('PATCH', `/slides/${ids[0]}`, { token: admin, body: { title: '資料A(改)' } });
    expect(SlideSchema.parse(renamed.json).title).toBe('資料A(改)');

    expect((await api('DELETE', `/slides/${ids[1]}`, { token: admin })).json).toEqual({ success: true });
    expect(world.s3.keys(ENV.CONTENT_BUCKET)).not.toContain(`slides/${ids[1]}.pdf`);
    expect(await titles()).toEqual(['資料C', '資料A(改)']);
    expect(world.chat.events.filter((event) => event.eventName === 'slides-updated')).toHaveLength(5);

    // 存在しないスライドへの操作は 404(R1-14)。
    expect((await api('PATCH', '/slides/missing', { token: admin, body: { title: 'x' } })).statusCode).toBe(404);
    expect((await api('POST', '/slides/missing/complete', { token: admin })).statusCode).toBe(404);
    expect((await api('DELETE', '/slides/missing', { token: admin })).statusCode).toBe(404);

    // スライド閲覧用 Cookie は /files/slides/* だけに効く(R1-08)。ワイルドカードなのでカスタムポリシー(INT-01)。
    const cookies = await api('POST', '/files/cookies', { token: viewer });
    expect(cookies.statusCode).toBe(204);
    expectCustomPolicyCookies(cookies.cookies, `https://${CLOUDFRONT_HOST}/files/slides/*`, '/files/slides/');
  });

  it('50MB を超えるファイルは upload-url で 400、presigned POST のポリシーでも拒否される', async () => {
    const admin = await login('admin@example.com');
    const over = await api('POST', '/slides/upload-url', { token: admin, body: { title: '大きい', fileName: 'big.pdf', size: SLIDE_MAX_BYTES + 1, contentType: 'application/pdf' } });
    expect(over.statusCode).toBe(400);
    const created = SlideUploadUrlResponseSchema.parse((await api('POST', '/slides/upload-url', { token: admin, body: { title: '上限', fileName: 'max.pdf', size: SLIDE_MAX_BYTES, contentType: 'application/pdf' } })).json);
    expect(world.s3.presignedUpload(created.url, created.fields, { body: Buffer.alloc(SLIDE_MAX_BYTES + 1), contentType: 'application/pdf' }).status).toBe(400);
    expect(world.s3.presignedUpload(created.url, created.fields, { body: pdf(), contentType: 'image/png' }).status).toBe(403);
    expect(world.s3.presignedUpload(created.url, created.fields, { body: pdf(), contentType: 'application/pdf' }).status).toBe(204);
  });
});

describe('配信 start → stats → stop → 録画イベント → アーカイブ公開 → 視聴者一覧', () => {
  it('録画は非公開で登録され、管理者が公開すると視聴者の一覧に出る', async () => {
    const admin = await login('admin@example.com');
    world.cognito.seed('viewer@example.com', ['viewer']);
    const viewer = await login('viewer@example.com');
    expect((await api('GET', '/broadcast', { token: viewer })).json).toBeNull();

    const started = await api('POST', '/broadcast/start', { token: admin, body: { title: '10月定例' } });
    expect(started.statusCode).toBe(200);
    const broadcast = BroadcastSchema.parse(started.json);
    expect(broadcast).toMatchObject({ title: '10月定例', status: 'live', endedAt: null });
    expect(BroadcastSchema.parse((await api('GET', '/broadcast', { token: viewer })).json).status).toBe('live');
    expect(errorCode(await api('POST', '/broadcast/start', { token: admin, body: { title: '二重' } }))).toBe('BROADCAST_LIVE');
    expect(world.chat.events.map((event) => event.eventName)).toEqual(['broadcast-started']);

    // 視聴者55人(SUBSCRIBE のみ)とスイッチャー1人(PUBLISH)が接続 → 視聴者数は55(ページングを含む)。
    for (let n = 0; n < 55; n += 1) {
      const token = StageTokenResponseSchema.parse((await api('POST', '/tokens/stage', { token: viewer, body: { purpose: 'viewer' } })).json);
      expect(token.tokens).toEqual([expect.objectContaining({ stage: 'broadcast', capabilities: ['SUBSCRIBE'] })]);
      expect(token.deviceId).toBeUndefined();
      world.ivs.connect(token.tokens[0]!.participantId);
    }
    const switcher = StageTokenResponseSchema.parse((await api('POST', '/tokens/stage', { token: admin, body: { purpose: 'switcher' } })).json);
    world.ivs.connect(switcher.tokens.find((token) => token.stage === 'broadcast')!.participantId, true);
    expect(ViewerCountResponseSchema.parse((await api('GET', '/broadcast/stats', { token: admin })).json)).toEqual({ viewerCount: 55 });

    advance(90 * 60_000);
    // アクセストークンの有効期限(1時間)を過ぎたので、管理者・視聴者ともトークンを更新して続ける。
    const adminAgain = await login('admin@example.com');
    const viewerAgain = await login('viewer@example.com');
    const stopped = BroadcastSchema.parse((await api('POST', '/broadcast/stop', { token: adminAgain, body: {} })).json);
    expect(stopped).toMatchObject({ id: broadcast.id, status: 'ended', endedAt: new Date(Date.now()).toISOString() });
    expect(errorCode(await api('POST', '/broadcast/stop', { token: adminAgain, body: {} }))).toBe('BROADCAST_NOT_LIVE');
    const [composition] = [...world.ivs.compositions.values()];
    expect(composition!.state).toBe('STOPPED');

    // IVS が録画を書き込み、EventBridge が Session End を recording Lambda に届ける。
    for (const file of ['media/hls/multivariant.m3u8', 'media/hls/720p30/playlist.m3u8', 'media/hls/720p30/0.ts', 'media/hls/720p30/1.ts', 'media/thumbnails/0.jpg']) {
      world.s3.put(ENV.RECORDING_BUCKET, `${composition!.recordingPrefix}/${file}`, 'data');
    }
    expect(await recordingHandler(recordingEvent(composition!.arn, 'Session Start'))).toEqual({ archived: false });
    const archived = await recordingHandler(recordingEvent(composition!.arn));
    expect(archived.archived).toBe(true);
    expect(await recordingHandler(recordingEvent(composition!.arn))).toEqual(archived);

    expect(ArchivesResponseSchema.parse((await api('GET', '/archives', { token: viewerAgain })).json)).toEqual([]);
    const [archive] = ArchivesResponseSchema.parse((await api('GET', '/archives', { token: adminAgain })).json);
    expect(archive).toMatchObject({ id: archived.archiveId, title: '10月定例', published: false, durationSeconds: 5400, playbackPath: `/files/archives/${composition!.recordingPrefix}/media/hls/multivariant.m3u8` });
    // 再生パスから /files/archives を外した S3 キーに HLS プレイリストがある(CloudFront の書き換えと一致)。
    expect(world.s3.keys(ENV.RECORDING_BUCKET)).toContain(archive!.playbackPath.replace('/files/archives/', ''));
    // 保存期限の初期値は録画登録から365日(R1-22)。
    expect(Math.abs(Date.parse(archive!.retainUntil) - (Date.now() + ARCHIVE_RETENTION_DAYS * 86_400_000))).toBeLessThan(86_400_000);
    // 非公開アーカイブの Cookie は管理者以外に発行しない(R1-08)。
    expect([403, 404]).toContain((await api('POST', `/archives/${archive!.id}/cookies`, { token: viewerAgain })).statusCode);

    const published = await api('PATCH', `/archives/${archive!.id}`, { token: adminAgain, body: { published: true } });
    expect(published.json).toMatchObject({ id: archive!.id, published: true });
    expect(ArchivesResponseSchema.parse((await api('GET', '/archives', { token: viewerAgain })).json).map((item) => item.id)).toEqual([archive!.id]);

    // 公開後は視聴者にも当該アーカイブのプレフィックスだけに効く Cookie を発行する(R1-08 / INT-01)。
    const cookies = await api('POST', `/archives/${archive!.id}/cookies`, { token: viewerAgain });
    expect(cookies.statusCode).toBe(204);
    const archivePath = `/files/archives/${composition!.recordingPrefix}/`;
    expectCustomPolicyCookies(cookies.cookies, `https://${CLOUDFRONT_HOST}${archivePath}*`, archivePath);

    expect((await api('DELETE', `/archives/${archive!.id}`, { token: adminAgain })).json).toEqual({ success: true });
    expect(world.s3.keys(ENV.RECORDING_BUCKET)).toEqual([]);
    expect(ArchivesResponseSchema.parse((await api('GET', '/archives', { token: adminAgain })).json)).toEqual([]);
    // 存在しないアーカイブの更新は 404(R1-14)。
    expect((await api('PATCH', `/archives/${archive!.id}`, { token: adminAgain, body: { published: true } })).statusCode).toBe(404);
    const events = world.chat.events.map((item) => item.eventName);
    expect(events.slice(0, 2)).toEqual(['broadcast-started', 'broadcast-ended']);
    expect(events.filter((name) => name === 'archives-updated').length).toBeGreaterThanOrEqual(3);
  });

  it('合成が自動終了した後でも配信を終了でき、Session End で配信状態が ended になる(R1-03)', async () => {
    const admin = await login('admin@example.com');
    expect((await api('POST', '/broadcast/start', { token: admin, body: { title: '自動終了' } })).statusCode).toBe(200);
    const [first] = [...world.ivs.compositions.values()];
    world.ivs.autoEnd(first!.arn);
    const stopped = await api('POST', '/broadcast/stop', { token: admin, body: {} });
    expect(stopped.statusCode).toBe(200);
    expect(BroadcastSchema.parse(stopped.json).status).toBe('ended');

    expect((await api('POST', '/broadcast/start', { token: admin, body: { title: '次の回' } })).statusCode).toBe(200);
    const second = [...world.ivs.compositions.values()].find((item) => item.state === 'ACTIVE')!;
    world.ivs.autoEnd(second.arn);
    world.s3.put(ENV.RECORDING_BUCKET, `${second.recordingPrefix}/media/hls/multivariant.m3u8`, '#EXTM3U');
    await recordingHandler(recordingEvent(second.arn));
    expect(BroadcastSchema.parse((await api('GET', '/broadcast', { token: admin })).json).status).toBe('ended');
    expect(world.chat.events.filter((event) => event.eventName === 'broadcast-ended')).toHaveLength(2);
  });
});

describe('コメント審査 → 直近100件 → 削除 → CSV', () => {
  const review = (userId: string, content: string, messageId: string): Promise<{ ReviewResult: string; Attributes?: Record<string, string> }> =>
    chatReviewHandler({ MessageId: messageId, Content: content, RoomArn: ENV.CHAT_ROOM_ARN, Sender: { UserId: userId, Attributes: {} } } satisfies ChatReviewEvent);

  it('NGワード・3秒連投・停止ユーザーを拒否し、許可分だけを履歴とCSVに残す', async () => {
    const admin = await login('admin@example.com');
    const taro = world.cognito.seed('taro@example.com', ['viewer']);
    const hanako = world.cognito.seed('hanako@example.com', ['viewer']);
    const taroToken = await login('taro@example.com');
    const hanakoToken = await login('hanako@example.com');
    expect((await api('POST', '/ng-words', { token: admin, body: { word: 'ばか' } })).statusCode).toBe(200);

    // 表示名未設定は拒否。表示名にも NG ワードは使えない。
    expect((await review(taro.sub, 'こんにちは', 'm-0')).ReviewResult).toBe('DENY');
    expect(errorCode(await api('PUT', '/me/display-name', { token: taroToken, body: { displayName: 'ばか太郎' } }))).toBe('NG_WORD');
    expect((await api('PUT', '/me/display-name', { token: taroToken, body: { displayName: 'たろう' } })).statusCode).toBe(200);
    expect((await api('PUT', '/me/display-name', { token: hanakoToken, body: { displayName: 'はなこ' } })).statusCode).toBe(200);

    // クライアントが付けた displayName 属性は審査でプロフィールの表示名に置き換える(R1-04)。
    const allowed = await chatReviewHandler({ MessageId: 'm-1', Content: 'こんにちは', Attributes: { displayName: '管理者' }, RoomArn: ENV.CHAT_ROOM_ARN, Sender: { UserId: taro.sub, Attributes: {} } });
    expect(allowed).toMatchObject({ ReviewResult: 'ALLOW', Attributes: { displayName: 'たろう' } });
    expect((await review(taro.sub, 'ばかだな', 'm-2')).ReviewResult).toBe('DENY');
    advance(3_000);
    expect(await review(taro.sub, '=HYPERLINK("x")', 'm-3')).toMatchObject({ ReviewResult: 'ALLOW' });
    advance(2_999);
    expect((await review(taro.sub, '連投', 'm-4')).Attributes?.Reason).toContain('3秒');
    expect((await review(hanako.sub, '別の人は送れる', 'm-5')).ReviewResult).toBe('ALLOW');
    advance(3_000);
    expect((await review(taro.sub, 'x'.repeat(201), 'm-6')).ReviewResult).toBe('DENY');
    expect((await review(taro.sub, '   ', 'm-6b')).ReviewResult).toBe('DENY');

    // 停止すると切断され、審査でも拒否、チャットトークンから送信権限が外れる。
    expect((await api('PUT', `/users/${hanako.sub}/comment-suspension`, { token: admin, body: { suspended: true } })).json).toEqual({ success: true });
    expect(world.chat.disconnected).toEqual([hanako.sub]);
    advance(5_000);
    expect((await review(hanako.sub, '停止中', 'm-7')).ReviewResult).toBe('DENY');
    expect((await api('POST', '/tokens/chat', { token: hanakoToken, body: {} })).json).toEqual({ token: expect.any(String), capabilities: [] });
    expect((await api('POST', '/tokens/chat', { token: admin, body: {} })).json).toMatchObject({ capabilities: ['SEND_MESSAGE', 'DELETE_MESSAGE', 'DISCONNECT_USER'] });
    expect(MeResponseSchema.parse((await api('GET', '/me', { token: hanakoToken })).json).commentSuspended).toBe(true);

    for (let n = 0; n < 105; n += 1) {
      advance(3_001);
      expect((await review(taro.sub, `コメント${n}`, `bulk-${String(n).padStart(3, '0')}`)).ReviewResult).toBe('ALLOW');
    }
    const recent = RecentCommentsResponseSchema.parse((await api('GET', '/comments/recent', { token: taroToken })).json);
    expect(recent).toHaveLength(100);
    expect(recent[0]).toMatchObject({ messageId: 'bulk-104', displayName: 'たろう', comment: 'コメント104', deleted: false });
    expect(recent.at(-1)!.messageId).toBe('bulk-005');

    expect((await api('DELETE', '/comments/bulk-104', { token: admin })).json).toEqual({ success: true });
    expect(world.chat.deleted).toEqual(['bulk-104']);
    const afterDelete = RecentCommentsResponseSchema.parse((await api('GET', '/comments/recent', { token: admin })).json);
    expect(afterDelete[0]!.messageId).toBe('bulk-103');
    expect(afterDelete.map((comment) => comment.messageId)).not.toContain('bulk-104');
    expect((await api('DELETE', '/comments/unknown', { token: admin })).statusCode).toBe(404);

    const csv = await api('GET', '/comments/export', { token: admin });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    const lines = csv.body.split('\r\n');
    expect(lines[0]!.startsWith(BOM)).toBe(true);
    // 許可された全コメント(m-1, m-3, m-5 と 105件。削除済みを含む)を出し、メッセージID と削除フラグの列を持つ(R1-15)。
    expect(lines).toHaveLength(1 + 3 + 105);
    expect(lines[0]!.split(',')).toHaveLength(6);
    const row = (messageId: string) => lines.find((line) => line.includes(`"${messageId}"`)) ?? '';
    // 数式インジェクション対策: = で始まるセルは ' を前置し、" は二重化する。
    expect(row('m-3')).toContain(`"'=HYPERLINK(""x"")"`);
    expect(row('m-3')).toContain(`"${taro.sub}"`);
    expect(row('bulk-104').split(',').at(-1)).not.toBe(row('bulk-103').split(',').at(-1));
  });
});

describe('認可と入力検証', () => {
  const adminOnly: [string, string, unknown?][] = [
    ['POST', '/broadcast/start', { title: 'x' }], ['POST', '/broadcast/stop', {}], ['GET', '/broadcast/stats'], ['GET', '/status'],
    ['GET', '/devices'], ['DELETE', '/comments/m-1'], ['PUT', '/users/u-1/comment-suspension', { suspended: true }],
    ['GET', '/comments/export'], ['GET', '/ng-words'], ['POST', '/ng-words', { word: 'x' }], ['DELETE', '/ng-words/x'],
    ['POST', '/slides/upload-url', { title: 'x', fileName: 'x.pdf', size: 10, contentType: 'application/pdf' }],
    ['POST', '/slides/s-1/complete'], ['PATCH', '/slides/s-1', { title: 'x' }], ['PUT', '/slides/order', { ids: ['s-1'] }],
    ['DELETE', '/slides/s-1'], ['PATCH', '/archives/a-1', { published: true }], ['DELETE', '/archives/a-1'],
    ['GET', '/users'], ['POST', '/users/invite', { emails: ['a@example.com'], role: 'admin' }], ['PUT', '/users/u-1/role', { role: 'admin' }],
    ['POST', '/users/u-1/disable'], ['POST', '/users/u-1/enable'], ['DELETE', '/users/u-1'],
  ];

  it.each(['camera', 'audio', 'presenter', 'viewer'])('%s は管理 API をすべて 403 で拒否され、副作用もない', async (role) => {
    world.cognito.seed(`${role}@example.com`, [role]);
    const token = await login(`${role}@example.com`);
    for (const [method, path, body] of adminOnly) {
      const result = await api(method, path, { token, body });
      expect({ method, path, status: result.statusCode, code: errorCode(result) }).toEqual({ method, path, status: 403, code: 'FORBIDDEN' });
    }
    expect(world.chat.events).toEqual([]);
    expect(world.cognito.users.size).toBe(2);
    expect(nonUserRows()).toEqual([]);
  });

  it('送信用トークンは用途ごとのロールだけが取得できる', async () => {
    const cases: [string, string, number][] = [
      ['viewer', 'camera', 403], ['viewer', 'switcher', 403], ['camera', 'mic', 403], ['audio', 'mic', 200],
      ['audio', 'camera', 403], ['presenter', 'slide', 200], ['presenter', 'switcher', 403], ['viewer', 'viewer', 200],
    ];
    for (const [role, purpose, status] of cases) {
      world.cognito.seed(`${role}-${purpose}@example.com`, [role]);
      const result = await api('POST', '/tokens/stage', { token: await login(`${role}-${purpose}@example.com`), body: { purpose } });
      expect({ role, purpose, status: result.statusCode }).toEqual({ role, purpose, status });
    }
  });

  it('管理者は自分自身を降格・無効化・削除できない(R1-19)', async () => {
    const admin = world.cognito.byEmail('admin@example.com');
    const token = await login('admin@example.com');
    const attempts: [string, string, unknown?][] = [['PUT', `/users/${admin.sub}/role`, { role: 'viewer' }], ['POST', `/users/${admin.sub}/disable`], ['DELETE', `/users/${admin.sub}`]];
    for (const [method, path, body] of attempts) {
      const result = await api(method, path, { token, body });
      expect({ path, clientError: result.statusCode >= 400 && result.statusCode < 500 }).toEqual({ path, clientError: true });
    }
    expect(admin).toMatchObject({ enabled: true, groups: new Set(['admin']) });
    expect(world.cognito.users.has(admin.username)).toBe(true);
  });

  it('未認証・不正トークンは 401、グループ不正は 403', async () => {
    const admin = world.cognito.byEmail('admin@example.com');
    const noGroup = world.cognito.seed('nogroup@example.com', []);
    const twoGroups = world.cognito.seed('two@example.com', ['viewer', 'camera']);
    const valid = world.cognito.accessToken(admin);
    const [header, payload, signature] = valid.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Json;
    const forged = `${header}.${Buffer.from(JSON.stringify({ ...claims, sub: noGroup.sub })).toString('base64url')}.${signature}`;
    const cases: [string, string | undefined, number, string][] = [
      ['トークンなし', undefined, 401, 'UNAUTHORIZED'],
      ['改ざん', forged, 401, 'UNAUTHORIZED'],
      ['期限切れ', world.cognito.accessToken(admin, { expiresInSeconds: -1 }), 401, 'UNAUTHORIZED'],
      ['別クライアント', world.cognito.accessToken(admin, { clientId: 'other-client' }), 401, 'UNAUTHORIZED'],
      ['グループ未所属(初回ログイン直後)', world.cognito.accessToken(noGroup), 401, 'TOKEN_REFRESH_REQUIRED'],
      ['複数グループ', world.cognito.accessToken(twoGroups), 403, 'INVALID_ROLE'],
    ];
    for (const [label, token, status, code] of cases) {
      const result = await api('GET', '/me', token === undefined ? {} : { token });
      expect({ label, status: result.statusCode, code: errorCode(result) }).toEqual({ label, status, code });
    }
    expect((await api('GET', '/me', { token: valid })).statusCode).toBe(200);
  });

  it('不正な入力は 400 VALIDATION_ERROR', async () => {
    const admin = await login('admin@example.com');
    const cases: [string, string, { body?: unknown; rawBody?: string }][] = [
      ['PUT', '/me/display-name', { body: { displayName: '' } }],
      ['PUT', '/me/display-name', { body: { displayName: 'あ'.repeat(21) } }],
      ['PUT', '/me/display-name', { rawBody: '{"displayName":' }],
      ['POST', '/broadcast/start', { body: { title: '' } }],
      ['POST', '/tokens/stage', { body: { purpose: 'producer' } }],
      ['POST', '/tokens/stage', { body: { purpose: 'camera', deviceName: 'CAM 1' } }],
      ['POST', '/users/invite', { body: { emails: [], role: 'viewer' } }],
      ['POST', '/users/invite', { body: { emails: Array.from({ length: 101 }, (_, n) => `u${n}@example.com`), role: 'viewer' } }],
      ['POST', '/users/invite', { body: { emails: ['not-an-email'], role: 'viewer' } }],
      ['PUT', '/users/u-1/role', { body: { role: 'superuser' } }],
      ['POST', '/slides/upload-url', { body: { title: '資料', fileName: 'deck.pptx', size: 10, contentType: 'application/pdf' } }],
      ['POST', '/slides/upload-url', { body: { title: '資料', fileName: 'deck.pdf', size: 10, contentType: 'image/png' } }],
      ['POST', '/ng-words', { body: { word: ' ' } }],
      ['PATCH', '/archives/a-1', { body: {} }],
      ['PUT', '/users/u-1/comment-suspension', { body: { suspended: 'yes' } }],
    ];
    for (const [method, path, options] of cases) {
      const result = await api(method, path, { token: admin, ...options });
      expect({ method, path, status: result.statusCode, code: errorCode(result) }).toEqual({ method, path, status: 400, code: 'VALIDATION_ERROR' });
    }
    expect(world.cognito.users.size).toBe(1);
    expect(world.chat.events).toEqual([]);
  });
});
