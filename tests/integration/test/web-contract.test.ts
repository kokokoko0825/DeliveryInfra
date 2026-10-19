import { CLOUDFRONT_HOST, ENV } from './support/environment';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTokenResponseSchema, MeResponseSchema } from '@delivery/shared';
import { handler as apiHandler } from '../../../apps/api/src/index';
import { handler as chatReviewHandler } from '../../../apps/api/src/chat-review';
import { handler as recordingHandler } from '../../../apps/api/src/recording';
import { apiFetch, ApiError, setTokenProvider } from '@/lib/api';
import { fetchMe } from '@/features/auth/AuthProvider';
import { saveDisplayName } from '@/features/auth/DisplayNamePage';
import { fetchBroadcast as fetchBroadcastForViewer } from '@/features/viewer/WatchPage';
import { fetchSlides } from '@/features/slides/api';
import { deleteSlide, renameSlide, reorderSlides, uploadSlide } from '@/features/admin/slides-api';
import { changeRole, deleteUser, fetchUsers, inviteUsers, setUserEnabled } from '@/features/admin/users-api';
import { addNgWord, exportComments, fetchNgWords, removeNgWord } from '@/features/admin/comments-api';
import { deleteArchive, fetchArchives, updateArchive } from '@/features/archives/api';
import { deleteComment, setCommentSuspension } from '@/lib/comments';
import { fetchRecentComments } from '@/lib/chat';
import { archiveCookiesPath, ensureFileCookies, resetFileCookies, SLIDE_COOKIES_PATH } from '@/lib/files';
import { fetchViewerToken } from '@/lib/viewer-stage';
import {
  fetchBroadcast, fetchBroadcastStats, fetchStatus, releaseDevice, requestStageTokens, sendHeartbeat, startBroadcast, stopBroadcast,
} from '@/lib/ivs/mediaApi';
import { createWorld, type World } from './support/fake-aws';
import { functionUrlEvent, sha256Hex } from './support/lambda';

/** CloudFront → 関数URL に届いたリクエスト(OAC の署名対象ヘッダーの検証結果つき)。 */
interface Forwarded { method: string; path: string; status: number; authToken: string | undefined; contentSha256: string | undefined; bodySha256: string }

let world: World;
let token: string | undefined;
const forwarded: Forwarded[] = [];

/**
 * SPA の fetch を CloudFront(/api/* → Lambda 関数URL)と S3(presigned POST)に見立てて処理するアダプタ。
 * OAC は本文の SHA-256 を x-amz-content-sha256 で受け取り SigV4 に含めるため、一致しない場合は 403 にする。
 */
async function adapter(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method ?? 'GET').toUpperCase();
  if (url.startsWith('https://') && !url.includes(CLOUDFRONT_HOST)) {
    const form = init.body as FormData;
    const fields: Record<string, string> = {};
    let file: File | undefined;
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') fields[key] = value;
      else file = value;
    }
    const { status } = world.s3.presignedUpload(url, fields, { body: Buffer.from(await file!.arrayBuffer()), contentType: file!.type });
    return new Response(null, { status });
  }
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
  const body = typeof init.body === 'string' ? init.body : undefined;
  const record: Forwarded = { method, path: url, status: 0, authToken: headers['x-auth-token'], contentSha256: headers['x-amz-content-sha256'], bodySha256: sha256Hex(body ?? '') };
  forwarded.push(record);
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && record.contentSha256 !== record.bodySha256) {
    record.status = 403;
    return new Response(JSON.stringify({ message: 'The request signature we calculated does not match the signature you provided.' }), { status: 403 });
  }
  const result = await apiHandler(functionUrlEvent(method, url, { headers, ...(body === undefined ? {} : { body }) }));
  record.status = result.statusCode;
  const responseHeaders = new Headers(result.headers);
  for (const cookie of result.cookies ?? []) responseHeaders.append('set-cookie', cookie);
  return new Response(result.statusCode === 204 ? null : result.body, { status: result.statusCode, headers: responseHeaders });
}

const as = async (email: string) => { token = world.cognito.accessToken(world.cognito.byEmail(email)); };
const pdfFile = (name: string) => new File([Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x20)])], name, { type: 'application/pdf' });

beforeAll(() => {
  vi.stubGlobal('fetch', adapter);
  setTokenProvider(async () => token);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => {
  setTokenProvider(undefined);
  vi.unstubAllGlobals();
});
beforeEach(() => {
  world = createWorld();
  forwarded.length = 0;
  resetFileCookies();
  world.cognito.seed('admin@example.com', ['admin']);
  world.cognito.seed('viewer@example.com', ['viewer']);
});

describe('Web(apps/web/src/lib/api.ts のクライアント) ↔ API ハンドラの契約', () => {
  it('管理者が使う全呼び出しの応答が shared スキーマ検証を通り、送信本文の SHA-256 が一致する', async () => {
    await as('admin@example.com');
    expect(await fetchMe()).toMatchObject({ email: 'admin@example.com', role: 'admin' });
    expect(await saveDisplayName({ displayName: '管理者' })).toEqual({ displayName: '管理者' });
    expect(await fetchStatus()).toMatchObject({ chatRoom: { exists: true } });

    // ユーザー管理(A-05)
    expect(await inviteUsers(['a@example.com', 'b@example.com'], 'viewer')).toEqual({ invited: ['a@example.com', 'b@example.com'], failed: [] });
    const users = await fetchUsers();
    const a = users.find((user) => user.email === 'a@example.com')!;
    expect(await changeRole(a.userId, 'presenter')).toEqual({ userId: a.userId, role: 'presenter', enabled: true });
    expect(await setUserEnabled(a.userId, false)).toEqual({ success: true });
    expect(await setUserEnabled(a.userId, true)).toEqual({ success: true });
    expect(await deleteUser(users.find((user) => user.email === 'b@example.com')!.userId)).toEqual({ success: true });

    // スライド管理(A-02): presigned POST へのアップロードを含む
    const first = await uploadSlide('第1部', pdfFile('part1.pdf'));
    const second = await uploadSlide('第2部', pdfFile('part2.pdf'));
    expect(await renameSlide(first.id, '第1部(改)')).toMatchObject({ id: first.id, title: '第1部(改)' });
    expect(await reorderSlides([second.id, first.id])).toEqual({ success: true });
    expect((await fetchSlides()).map((slide) => slide.id)).toEqual([second.id, first.id]);
    await ensureFileCookies(SLIDE_COOKIES_PATH);
    expect(await deleteSlide(second.id)).toEqual({ success: true });

    // コメント管理(A-04)
    await addNgWord('禁止');
    expect(await fetchNgWords()).toEqual(['禁止']);
    expect(await removeNgWord('禁止')).toEqual({ success: true });
    const viewer = world.cognito.byEmail('viewer@example.com');
    await as('viewer@example.com');
    await saveDisplayName({ displayName: '視聴者' });
    await chatReviewHandler({ MessageId: 'msg-1', Content: 'よろしく', RoomArn: ENV.CHAT_ROOM_ARN, Sender: { UserId: viewer.sub } });
    await as('admin@example.com');
    expect(ChatTokenResponseSchema.parse(await apiFetch('/tokens/chat', { method: 'POST', body: {}, schema: ChatTokenResponseSchema })).capabilities).toContain('DELETE_MESSAGE');
    expect((await fetchRecentComments()).map((comment) => comment.messageId)).toEqual(['msg-1']);
    const csv = await exportComments();
    expect(csv.type).toMatch(/^text\/csv;\s?charset=utf-8$/u);
    expect(await csv.text()).toContain('よろしく');
    expect(await setCommentSuspension(viewer.sub, true)).toEqual({ success: true });
    expect(await deleteComment('msg-1')).toEqual({ success: true });

    // 配信・スイッチング(A-01)
    const switcher = await requestStageTokens('switcher');
    expect(switcher.tokens.map((entry) => entry.stage).sort()).toEqual(['broadcast', 'production', 'slide']);
    expect(await startBroadcast('本番')).toMatchObject({ title: '本番', status: 'live' });
    expect(await fetchBroadcast()).toMatchObject({ status: 'live' });
    expect(await fetchBroadcastStats()).toEqual({ viewerCount: 0 });
    expect(await stopBroadcast()).toMatchObject({ status: 'ended' });

    // アーカイブ(U-04 / 管理)
    const [composition] = [...world.ivs.compositions.values()];
    world.s3.put(ENV.RECORDING_BUCKET, `${composition!.recordingPrefix}/media/hls/multivariant.m3u8`, '#EXTM3U');
    const { archiveId } = await recordingHandler({ source: 'aws.ivs', 'detail-type': 'IVS Composition State Change', time: new Date().toISOString(), resources: [composition!.arn], detail: { event_name: 'Session End' } });
    expect(await updateArchive(archiveId!, { title: '本番(録画)', published: true })).toMatchObject({ id: archiveId, title: '本番(録画)', published: true });
    expect((await fetchArchives()).map((archive) => archive.id)).toEqual([archiveId]);
    await ensureFileCookies(archiveCookiesPath(archiveId!));
    expect(await deleteArchive(archiveId!)).toEqual({ success: true });

    expect(forwarded.filter((request) => request.status >= 400)).toEqual([]);
    // ログイン中の全リクエストが Cognito アクセストークンを X-Auth-Token で送っている。
    expect(forwarded.filter((request) => !request.authToken?.startsWith('eyJ'))).toEqual([]);
    const mutating = forwarded.filter((request) => request.method !== 'GET');
    expect(mutating.length).toBeGreaterThan(20);
    expect(mutating.every((request) => request.contentSha256 === request.bodySha256)).toBe(true);
  });

  it('送信者・視聴者が使う呼び出し(トークン・ハートビート・解放・視聴)も契約どおり', async () => {
    const camera = world.cognito.seed('camera@example.com', ['camera']);
    await as('camera@example.com');
    const issued = await requestStageTokens('camera', 'CAM1');
    expect(issued.deviceId).toEqual(expect.any(String));
    expect(Date.parse((await sendHeartbeat(issued.deviceId!)).expiresAt)).toBeGreaterThan(Date.now());
    await releaseDevice(issued.deviceId!);
    expect(world.db.byPrefix('DEVICE').filter((item) => item.userId === camera.sub)).toEqual([]);

    await as('viewer@example.com');
    expect(MeResponseSchema.parse(await fetchMe())).toMatchObject({ email: 'viewer@example.com', role: 'viewer', displayName: null });
    expect(await fetchBroadcastForViewer()).toBeNull();
    expect(await fetchViewerToken()).toEqual(expect.stringMatching(/^ivs-token-/u));
    expect(await fetchSlides()).toEqual([]);
    expect(await fetchArchives()).toEqual([]);
    expect(await fetchRecentComments()).toEqual([]);
    await ensureFileCookies(SLIDE_COOKIES_PATH);
    expect(forwarded.filter((request) => request.status >= 400)).toEqual([]);
  });

  it('API のエラー応答は ApiError(code/日本語メッセージ)として Web に届く', async () => {
    await as('viewer@example.com');
    const failure = await fetchUsers().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const invalid = await saveDisplayName({ displayName: 'x'.repeat(21) }).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  it('x-amz-content-sha256 が本文と一致しなければ OAC が拒否する(アダプタの前提の確認)', async () => {
    await as('admin@example.com');
    const response = await fetch('/api/ng-words', { method: 'POST', headers: { 'X-Auth-Token': token!, 'x-amz-content-sha256': sha256Hex('{}') }, body: JSON.stringify({ word: 'x' }) });
    expect(response.status).toBe(403);
    expect(world.db.byPrefix('NGWORD')).toEqual([]);
  });
});
