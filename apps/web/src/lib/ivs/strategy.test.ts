import { describe, expect, it } from 'vitest';
import { SUBSCRIBE, isRecoverableLeave, shouldPublish, subscribeTypeFor, toRemoteParticipant } from './strategy';

describe('toRemoteParticipant', () => {
  it('reads kind and deviceName from token attributes', () => {
    expect(toRemoteParticipant({ id: 'p1', attributes: { kind: 'camera', deviceName: 'CAM1' } })).toEqual({ id: 'p1', kind: 'camera', deviceName: 'CAM1' });
    expect(toRemoteParticipant({ id: 'p2', attributes: { kind: 'switcher' } }).kind).toBe('switcher');
  });
  it('falls back to unknown kind and a short id', () => {
    expect(toRemoteParticipant({ id: 'abcdefghijk' })).toEqual({ id: 'abcdefghijk', kind: 'unknown', deviceName: 'abcdefgh' });
    expect(toRemoteParticipant({ id: 'p', attributes: { kind: 'hacker', deviceName: '' } })).toEqual({ id: 'p', kind: 'unknown', deviceName: 'p' });
    expect(toRemoteParticipant({ id: 'p', attributes: { kind: 1, deviceName: 2 } })).toEqual({ id: 'p', kind: 'unknown', deviceName: 'p' });
  });
});

describe('subscribeTypeFor', () => {
  const participant = (kind: 'camera' | 'mic' | 'slide' | 'switcher' | 'unknown') => ({ id: 'x', kind, deviceName: 'X' });
  it('subscribes to video for cameras and slides, audio only for mics', () => {
    expect(subscribeTypeFor(participant('camera'), true)).toBe(SUBSCRIBE.AUDIO_VIDEO);
    expect(subscribeTypeFor(participant('slide'), true)).toBe(SUBSCRIBE.AUDIO_VIDEO);
    expect(subscribeTypeFor(participant('mic'), true)).toBe(SUBSCRIBE.AUDIO_ONLY);
    expect(subscribeTypeFor(participant('switcher'), true)).toBe(SUBSCRIBE.NONE);
    expect(subscribeTypeFor(participant('unknown'), true)).toBe(SUBSCRIBE.NONE);
  });
  it('never subscribes for publish-only sessions', () => {
    expect(subscribeTypeFor(participant('camera'), false)).toBe(SUBSCRIBE.NONE);
    expect(subscribeTypeFor(participant('mic'), false)).toBe(SUBSCRIBE.NONE);
  });
  it('matches the SDK string values', () => {
    expect(SUBSCRIBE).toEqual({ NONE: 'none', AUDIO_ONLY: 'audio_only', AUDIO_VIDEO: 'audio_video' });
  });
});

describe('shouldPublish', () => {
  it('requires the publish flag and at least one track', () => {
    expect(shouldPublish(true, 1)).toBe(true);
    expect(shouldPublish(true, 0)).toBe(false);
    expect(shouldPublish(false, 2)).toBe(false);
  });
});

describe('isRecoverableLeave', () => {
  it('excludes intentional or terminal leaves', () => {
    expect(isRecoverableLeave('user-initiated')).toBe(false);
    expect(isRecoverableLeave('participant-disconnected')).toBe(false);
    expect(isRecoverableLeave('stage-deleted')).toBe(false);
    expect(isRecoverableLeave('unknown')).toBe(true);
    expect(isRecoverableLeave('token-reused')).toBe(true);
    expect(isRecoverableLeave('errored')).toBe(true);
  });
});
