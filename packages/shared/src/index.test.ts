import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema, ArchivesResponseSchema, BroadcastResponseSchema, BroadcastStartRequestSchema, canAccess, canRequestPurpose,
  CHAT_EVENTS, ChatTokenResponseSchema, CommentSchema, CommentSuspensionRequestSchema, containsNgWord,
  DeviceNameSchema, DisplayNameSchema, DisplayNameRequestSchema, getPostLoginPath, InviteUsersRequestSchema,
  MeResponseSchema, NgWordSchema, normalizeForModeration, RecentCommentsResponseSchema, ROLE_PURPOSES,
  ROLES, RoleSchema, SlideOrderRequestSchema, SlideUploadSchema, SlideUploadUrlResponseSchema, SlidesResponseSchema,
  StagePurposeSchema, StageTokenRequestSchema, StageTokenResponseSchema, StatusResponseSchema, UpdateRoleRequestSchema,
  UsersResponseSchema, ViewerCountResponseSchema, STAGE_LIMITS, FEATURES,
} from './index';

describe('shared schemas', () => {
  it('validates role and purpose enums and rejects invalid roles', () => {
    ROLES.forEach((role) => expect(RoleSchema.safeParse(role).success).toBe(true));
    expect(RoleSchema.safeParse('owner').success).toBe(false);
    expect(StagePurposeSchema.safeParse('unknown').success).toBe(false);
  });
  it.each([['a', true], ['a'.repeat(20), true], ['a'.repeat(21), false], ['', false], ['  ', false], ['a\u0001', false]])('validates display name %j', (name, valid) => expect(DisplayNameSchema.safeParse(name).success).toBe(valid));
  it('trims display names and checks request schema', () => {
    expect(DisplayNameSchema.parse('  Alice  ')).toBe('Alice');
    expect(DisplayNameRequestSchema.safeParse({ displayName: 'x'.repeat(21) }).success).toBe(false);
  });
  it.each([[1, true], [200, true], [201, false], [0, false]])('validates comments at %i chars', (size, valid) => expect(CommentSchema.safeParse('x'.repeat(size)).success).toBe(valid));
  it.each([[1, true], [52428800, true], [52428801, false], [0, false]])('validates slide size %i', (size, valid) => expect(SlideUploadSchema.safeParse({ title: 'T', fileName: 's.pdf', size, contentType: 'application/pdf' }).success).toBe(valid));
  it('rejects mismatched slide extension and MIME and validates title boundary', () => {
    expect(SlideUploadSchema.safeParse({ title: 'T', fileName: 's.txt', size: 1, contentType: 'application/pdf' }).success).toBe(false);
    expect(SlideUploadSchema.safeParse({ title: 'T', fileName: 's.pdf', size: 1, contentType: 'text/plain' }).success).toBe(false);
    expect(SlideUploadSchema.safeParse({ title: 'x'.repeat(101), fileName: 's.pdf', size: 1, contentType: 'application/pdf' }).success).toBe(false);
  });
  it('validates device names and upload metadata', () => {
    expect(DeviceNameSchema.safeParse('CAM1').success).toBe(true);
    expect(DeviceNameSchema.safeParse('bad name').success).toBe(false);
    expect(NgWordSchema.safeParse(' ').success).toBe(false);
  });
  it('validates API request and response contracts', () => {
    const schemas = [ApiErrorSchema, MeResponseSchema, BroadcastResponseSchema, ViewerCountResponseSchema, BroadcastStartRequestSchema,
      StageTokenRequestSchema, StageTokenResponseSchema, CommentSuspensionRequestSchema, RecentCommentsResponseSchema,
      SlidesResponseSchema, SlideOrderRequestSchema, SlideUploadUrlResponseSchema, ArchivesResponseSchema,
      InviteUsersRequestSchema, UpdateRoleRequestSchema, UsersResponseSchema, ChatTokenResponseSchema, StatusResponseSchema];
    expect(schemas).toHaveLength(18);
    expect(ApiErrorSchema.safeParse({ error: { code: 'X', message: 'x' } }).success).toBe(true);
    expect(BroadcastStartRequestSchema.safeParse({ title: '' }).success).toBe(false);
    expect(StageTokenRequestSchema.safeParse({ purpose: 'camera', deviceName: 'x'.repeat(17) }).success).toBe(false);
    expect(StageTokenResponseSchema.safeParse({ tokens: [] }).success).toBe(false);
    const token = { stage: 'broadcast', token: 't', participantId: 'p', capabilities: ['SUBSCRIBE'], expiresAt: '2026-10-19T00:00:00.000Z' };
    expect(StageTokenResponseSchema.safeParse({ tokens: [token] }).success).toBe(true);
    expect(StageTokenResponseSchema.safeParse({ tokens: [{ ...token, stage: 'arn:aws:ivs:ap-northeast-1:1:stage/x' }] }).success).toBe(false);
    expect(CommentSuspensionRequestSchema.safeParse({ suspended: 'yes' }).success).toBe(false);
    expect(SlideOrderRequestSchema.safeParse({ ids: ['a'] }).success).toBe(true);
    expect(SlideUploadUrlResponseSchema.safeParse({ slideId: 's1', url: 'https://example.test', fields: {} }).success).toBe(true);
    expect(SlideUploadUrlResponseSchema.safeParse({ url: 'https://example.test', fields: {} }).success).toBe(false);
    const archive = { id: 'a1', title: 't', published: false, durationSeconds: 0, playbackPath: '/files/archives/a1/multivariant.m3u8', retainUntil: '2027-10-19T00:00:00.000Z' };
    expect(ArchivesResponseSchema.safeParse([archive]).success).toBe(true);
    expect(ArchivesResponseSchema.safeParse([{ ...archive, playbackPath: 'https://evil.test/x.m3u8' }]).success).toBe(false);
    const user = { userId: 'u', email: 'a@example.com', loginMethod: 'email', role: 'viewer', enabled: true, commentSuspended: false, lastLoginAt: null };
    expect(UsersResponseSchema.safeParse([user]).success).toBe(true);
    expect(ArchivesResponseSchema.safeParse([{ ...archive, retainUntil: undefined }]).success).toBe(false);
    expect(CommentSchema.safeParse('   ').success).toBe(false);
    expect(CommentSchema.safeParse(' a ').data).toBe('a');
    expect(CommentSchema.safeParse('a\u0007b').success).toBe(false);
    expect(CommentSchema.safeParse('x'.repeat(200)).success).toBe(true);
    expect(CommentSchema.safeParse('x'.repeat(201)).success).toBe(false);
    expect(UsersResponseSchema.safeParse([{ ...user, commentSuspended: undefined }]).success).toBe(false);
    expect(InviteUsersRequestSchema.safeParse({ emails: [], role: 'admin' }).success).toBe(false);
    expect(UpdateRoleRequestSchema.safeParse({ role: 'fake' }).success).toBe(false);
    expect(CHAT_EVENTS).toEqual(['broadcast-started', 'broadcast-ended', 'slides-updated', 'archives-updated']);
  });
  it('validates all role-feature combinations', () => {
    const allowed: Record<string, string[]> = {
      watch: [...ROLES], archives: [...ROLES], cameraSend: ['admin', 'camera'], micSend: ['admin', 'audio'],
      slideShare: ['admin', 'presenter'], switcher: ['admin'], broadcastManage: ['admin'], slideManage: ['admin'],
      commentModeration: ['admin'], userManage: ['admin'],
    };
    for (const role of ROLES) for (const feature of FEATURES) expect(canAccess(role, feature)).toBe(allowed[feature]!.includes(role));
  });
  it('has explicit purpose permissions and stage limits', () => {
    expect(ROLE_PURPOSES).toEqual({ admin: ['viewer', 'camera', 'mic', 'slide', 'switcher'], camera: ['viewer', 'camera'], audio: ['viewer', 'mic'], presenter: ['viewer', 'slide'], viewer: ['viewer'] });
    expect(STAGE_LIMITS).toEqual({ camera: 6, mic: 5, slide: 1 });
    const purposes = ['viewer', 'camera', 'mic', 'slide', 'switcher'] as const;
    for (const role of ROLES) for (const purpose of purposes) expect(canRequestPurpose(role, purpose)).toBe(ROLE_PURPOSES[role].includes(purpose));
  });
  it('normalizes full width and case for forbidden words', () => {
    expect(normalizeForModeration('ＡＢＣ')).toBe('abc');
    expect(containsNgWord('これはＦＵＣＫです', ['fuck'])).toBe(true);
    expect(containsNgWord('hello', ['bad'])).toBe(false);
    expect(containsNgWord('allowed', [])).toBe(false);
    expect(containsNgWord('an apple', ['pear', 'APPLE'])).toBe(true);
    expect(containsNgWord('anything', [''])).toBe(false);
  });
  it('maps each role to post login destination', () => {
    expect(ROLES.map(getPostLoginPath)).toEqual(['/watch', '/send/camera', '/send/mic', '/send/slide', '/watch']);
  });
});
