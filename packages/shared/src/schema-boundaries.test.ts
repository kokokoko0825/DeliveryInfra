import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema, ArchiveIdParamsSchema, ArchiveUpdateRequestSchema, ArchiveUpdateResponseSchema, ArchivesResponseSchema,
  BroadcastResponseSchema, BroadcastSchema, ChatCustomEventSchema, ChatTokenRequestSchema, ChatTokenResponseSchema, CommentSchemaResponse,
  DeviceHeartbeatRequestSchema, DeviceIdParamsSchema, DeviceListResponseSchema, EmptyResponseSchema,
  HeartbeatResponseSchema, InviteUsersRequestSchema, MessageIdParamsSchema, NgWordRequestSchema,
  NgWordsResponseSchema, SlideCompleteResponseSchema, SlideCreateResponseSchema, SlideIdParamsSchema,
  SlideOrderRequestSchema, SlideSchema, SlideUpdateRequestSchema, SlideUploadSchema,
  SlideUploadUrlResponseSchema, SlidesResponseSchema, StageTokenResponseSchema, StatusResponseSchema,
  MeResponseSchema, RecentCommentsResponseSchema, SuggestedDeviceNameSchema, TitleSchema, UserIdParamsSchema,
  UserInviteResponseSchema, UserUpdateResponseSchema, UsersResponseSchema, ViewerCountResponseSchema,
} from './index';

describe('shared contract boundary schemas', () => {
  it('trims titles, rejects blank titles, and enforces the 100 character maximum', () => {
    expect(TitleSchema.parse('  keynote  ')).toBe('keynote');
    expect(TitleSchema.safeParse('  ').success).toBe(false);
    expect(TitleSchema.safeParse('x'.repeat(100)).success).toBe(true);
    expect(TitleSchema.safeParse('x'.repeat(101)).success).toBe(false);
  });

  it('requires exact suggested device names and a valid PDF file name', () => {
    for (const name of ['CAM1', 'CAM9', 'MIC1', 'MIC9']) expect(SuggestedDeviceNameSchema.safeParse(name).success).toBe(true);
    for (const name of ['X-CAM1', 'CAM10', 'CAM0', 'MIC1x', 'mic1']) expect(SuggestedDeviceNameSchema.safeParse(name).success).toBe(false);
    const base = { title: 'Slides', size: 1, contentType: 'application/pdf' };
    expect(SlideUploadSchema.safeParse({ ...base, fileName: 'file.PDF' }).success).toBe(true);
    expect(SlideUploadSchema.safeParse({ ...base, fileName: 'file.pdf.exe' }).success).toBe(false);
    expect(SlideUploadSchema.safeParse({ ...base, fileName: '' }).success).toBe(false);
    const extensionIssue = SlideUploadSchema.safeParse({ ...base, fileName: 'deck.txt' });
    expect(extensionIssue.success).toBe(false);
    if (!extensionIssue.success) {
      expect(extensionIssue.error.issues[0]?.message).toBe('PDF 拡張子が必要です');
      expect(extensionIssue.error.issues[0]?.path).toEqual(['fileName']);
    }
  });

  it('requires meaningful stage token values and valid expiry timestamps', () => {
    const token = { stage: 'production', token: 'signed-participant-token', participantId: 'participant-123', capabilities: ['PUBLISH'], expiresAt: '2026-10-19T12:00:00.000Z' };
    expect(StageTokenResponseSchema.safeParse({ tokens: [token] }).success).toBe(true);
    for (const invalid of [
      { ...token, token: '' }, { ...token, participantId: '' }, { ...token, expiresAt: 'tomorrow' },
      { ...token, stage: 'unknown' }, { ...token, capabilities: 'PUBLISH' },
    ]) expect(StageTokenResponseSchema.safeParse({ tokens: [invalid] }).success).toBe(false);
  });

  it('validates identifiers and rejects empty archive updates', () => {
    for (const schema of [DeviceIdParamsSchema, MessageIdParamsSchema, UserIdParamsSchema]) {
      const key = schema === DeviceIdParamsSchema ? 'deviceId' : schema === MessageIdParamsSchema ? 'messageId' : 'userId';
      expect(schema.safeParse({ [key]: 'valid-id' }).success).toBe(true);
      expect(schema.safeParse({ [key]: '' }).success).toBe(false);
    }
    for (const schema of [SlideIdParamsSchema, ArchiveIdParamsSchema]) {
      expect(schema.safeParse({ id: 'valid-id' }).success).toBe(true);
      expect(schema.safeParse({ id: '' }).success).toBe(false);
    }
    expect(ArchiveUpdateRequestSchema.safeParse({}).success).toBe(false);
    expect(ArchiveUpdateRequestSchema.safeParse({ title: 'new title' }).success).toBe(true);
    expect(ArchiveUpdateRequestSchema.safeParse({ retainUntil: 'not-a-date' }).success).toBe(false);
  });

  it('checks slide ordering, slide records, and upload URL response shape', () => {
    const slide = { id: 's1', title: 'Slides', fileName: 'deck.pdf', size: 1, order: 0, filePath: '/files/slides/s1.pdf' };
    expect(SlideSchema.safeParse(slide).success).toBe(true);
    for (const invalid of [{ ...slide, size: 1.5 }, { ...slide, order: -1 }, { ...slide, title: ' ' }]) expect(SlideSchema.safeParse(invalid).success).toBe(false);
    expect(SlidesResponseSchema.safeParse([slide]).success).toBe(true);
    expect(SlideOrderRequestSchema.safeParse({ ids: ['s1', 's2'] }).success).toBe(true);
    expect(SlideOrderRequestSchema.safeParse({ ids: 's1' }).success).toBe(false);
    expect(SlideUpdateRequestSchema.safeParse({ title: 'renamed' }).success).toBe(true);
    expect(SlideUpdateRequestSchema.safeParse({ title: ' ' }).success).toBe(false);
    expect(SlideUploadUrlResponseSchema.safeParse({ slideId: 's1', url: 'https://upload.example.test', fields: { key: 'slides/s1.pdf' } }).success).toBe(true);
    expect(SlideUploadUrlResponseSchema.safeParse({ slideId: 's1', url: '/relative', fields: {} }).success).toBe(false);
    expect(SlideCompleteResponseSchema.safeParse(slide).success).toBe(true);
    expect(SlideCreateResponseSchema.safeParse({ ...slide, order: -1 }).success).toBe(false);
  });

  it('validates archive, broadcast, status and device response fields', () => {
    const archive = { id: 'a1', title: 'Replay', published: false, durationSeconds: 12, playbackPath: '/files/archives/a1/index.m3u8', retainUntil: '2027-10-19T12:00:00.000Z' };
    expect(ArchivesResponseSchema.safeParse([archive]).success).toBe(true);
    expect(ArchiveUpdateResponseSchema.safeParse({ ...archive, published: true }).success).toBe(true);
    expect(ArchivesResponseSchema.safeParse([{ ...archive, durationSeconds: -1 }]).success).toBe(false);
    expect(BroadcastSchema.safeParse({ id: 'b1', title: 'Live', status: 'live', startedAt: null, endedAt: null }).success).toBe(true);
    expect(BroadcastSchema.safeParse({ id: 'b1', title: 'Live', status: 'pending', startedAt: null, endedAt: null }).success).toBe(false);
    expect(DeviceListResponseSchema.safeParse([{ deviceId: 'camera.1.x', deviceName: 'CAM-1', kind: 'camera', userId: 'u1', connected: true }]).success).toBe(true);
    expect(DeviceListResponseSchema.safeParse([{ deviceId: 'x', deviceName: 'bad name', kind: 'camera', userId: 'u1', connected: true }]).success).toBe(false);
    expect(StatusResponseSchema.safeParse({ stages: [{ name: 'production', exists: true, status: 'ACTIVE' }], chatRoom: { exists: true, status: 'ACTIVE' } }).success).toBe(true);
    expect(StatusResponseSchema.safeParse({ stages: [], chatRoom: { exists: 'yes' } }).success).toBe(false);
  });

  it('validates comment, word, invitation, and user response contracts', () => {
    const comment = { messageId: 'm1', userId: 'u1', displayName: 'Ada', comment: 'hello', sentAt: '2026-10-19T12:00:00.000Z', deleted: false };
    expect(CommentSchemaResponse.safeParse(comment).success).toBe(true);
    expect(CommentSchemaResponse.safeParse({ ...comment, sentAt: 'bad-time' }).success).toBe(false);
    expect(CommentSchemaResponse.safeParse({ ...comment, comment: undefined }).success).toBe(false);
    expect(NgWordRequestSchema.safeParse({ word: 'spam' }).success).toBe(true);
    expect(NgWordRequestSchema.safeParse({ word: ' '.repeat(2) }).success).toBe(false);
    expect(NgWordsResponseSchema.safeParse(['spam']).success).toBe(true);
    expect(InviteUsersRequestSchema.safeParse({ emails: ['a@example.test'], role: 'viewer' }).success).toBe(true);
    expect(InviteUsersRequestSchema.safeParse({ emails: ['bad-address'], role: 'viewer' }).success).toBe(false);
    expect(UserInviteResponseSchema.safeParse({ invited: ['a@example.test'], failed: [] }).success).toBe(true);
    expect(UsersResponseSchema.safeParse([{ userId: 'u1', email: 'a@example.test', loginMethod: 'email', role: null, enabled: true, commentSuspended: false, lastLoginAt: null }]).success).toBe(true);
    expect(UserUpdateResponseSchema.safeParse({ userId: 'u1', role: 'camera', enabled: true }).success).toBe(true);
    expect(UserUpdateResponseSchema.safeParse({ userId: 'u1', role: 'invalid', enabled: true }).success).toBe(false);
  });

  it('validates auxiliary request and response schemas', () => {
    expect(ChatTokenRequestSchema.safeParse({}).success).toBe(true);
    expect(DeviceHeartbeatRequestSchema.safeParse({}).success).toBe(true);
    expect(EmptyResponseSchema.safeParse({ success: true }).success).toBe(true);
    expect(EmptyResponseSchema.safeParse({ success: 'yes' }).success).toBe(false);
    expect(HeartbeatResponseSchema.safeParse({ expiresAt: '2026-10-19T12:00:00.000Z' }).success).toBe(true);
    expect(HeartbeatResponseSchema.safeParse({ expiresAt: 'bad-time' }).success).toBe(false);
    expect(ChatCustomEventSchema.safeParse({ eventName: 'broadcast-ended', attributes: { source: 'api' } }).success).toBe(true);
    expect(ChatCustomEventSchema.safeParse({ eventName: 'other-event' }).success).toBe(false);
  });

  it('checks response-required fields, enum alternatives, and list limits', () => {
    expect(ApiErrorSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'missing' } }).success).toBe(true);
    expect(ApiErrorSchema.safeParse({ error: { code: 'NOT_FOUND' } }).success).toBe(false);
    const me = { userId: 'u1', email: 'a@example.test', role: 'viewer', loginMethod: 'email', displayName: null, commentSuspended: false };
    expect(MeResponseSchema.safeParse(me).success).toBe(true);
    expect(MeResponseSchema.safeParse({ ...me, role: 'owner' }).success).toBe(false);
    const invalidName = MeResponseSchema.safeParse({ ...me, displayName: 'line\nbreak' });
    expect(invalidName.success).toBe(false);
    if (!invalidName.success) expect(invalidName.error.issues.some((issue) => issue.message === '制御文字は使用できません')).toBe(true);
    expect(BroadcastResponseSchema.safeParse(null).success).toBe(true);
    for (const status of ['idle', 'live', 'ended']) expect(BroadcastResponseSchema.safeParse({ id: 'b1', title: 'show', status, startedAt: null, endedAt: null }).success).toBe(true);
    expect(ViewerCountResponseSchema.safeParse({ viewerCount: -1 }).success).toBe(false);
    expect(ChatTokenResponseSchema.safeParse({ token: 'chat-token', capabilities: ['SEND_MESSAGE'] }).success).toBe(true);
    expect(ChatTokenResponseSchema.safeParse({}).success).toBe(false);
    expect(ChatTokenResponseSchema.safeParse({ token: '', capabilities: [] }).success).toBe(true);
    expect(RecentCommentsResponseSchema.safeParse(Array.from({ length: 101 }, () => ({ messageId: 'm', userId: 'u', displayName: 'A', comment: 'x', sentAt: '2026-10-19T12:00:00.000Z', deleted: false }))).success).toBe(false);
    expect(DeviceListResponseSchema.safeParse([{ deviceId: 'd', deviceName: 'CAM1', kind: 'mic', userId: 'u', connected: true }]).success).toBe(true);
    expect(DeviceListResponseSchema.safeParse([{ deviceId: 'd', deviceName: 'CAM1', kind: 'slide', userId: 'u', connected: true }]).success).toBe(true);
    expect(DeviceListResponseSchema.safeParse([{ deviceId: 'd', deviceName: 'CAM1', kind: '', userId: 'u', connected: true }]).success).toBe(false);
    expect(StatusResponseSchema.safeParse({ stages: [{ name: 'production', exists: true }], chatRoom: { exists: false } }).success).toBe(true);
    expect(StatusResponseSchema.safeParse({ stages: [{ name: 'production', exists: 'yes' }], chatRoom: { exists: false } }).success).toBe(false);
  });
});
