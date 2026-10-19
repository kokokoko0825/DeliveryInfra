import { describe, expect, it } from 'vitest';
import { formatElapsed, preflightItems, preflightReady } from './broadcast';
import {
  DEFAULT_VOLUME, MAX_MIC_CHANNELS, SLIDE_CHANNEL, VOLUME_MAX, VOLUME_MIN, VolumeSchema, channelOf, gainOf, initialMixerState, micChannel, mixerReducer,
} from './mixer';
import { remoteReducer, routeMedia, type RemoteState } from './remote';
import { SLIDE, STANDBY, cameraSource } from './scene';
import { INTERACTIVE_SELECTOR, SHORTCUT_HELP, keyToAction, shouldIgnoreKey } from './shortcuts';
import { HEALTH_LABEL, MAX_CAMERAS, STALL_THRESHOLD_MS, cameraSlots, healthOf, orderDevices, sameHealth, slideAlert } from './sources';

describe('mixer', () => {
  const MIC1 = micChannel('MIC1');
  it('validates volume 0〜100 integers', () => {
    expect([VOLUME_MIN, VOLUME_MAX, DEFAULT_VOLUME, MAX_MIC_CHANNELS]).toEqual([0, 100, 80, 5]);
    expect(VolumeSchema.safeParse(-1).success).toBe(false);
    expect(VolumeSchema.safeParse(0).success).toBe(true);
    expect(VolumeSchema.safeParse(100).success).toBe(true);
    expect(VolumeSchema.safeParse(101).success).toBe(false);
    expect(VolumeSchema.safeParse(50.5).success).toBe(false);
  });
  it('defaults unknown channels and sets volume / mute', () => {
    expect(channelOf(initialMixerState, MIC1)).toEqual({ volume: 80, muted: false });
    expect(initialMixerState.master).toEqual({ volume: 100, muted: false });
    const louder = mixerReducer(initialMixerState, { type: 'SET_VOLUME', channel: MIC1, volume: 30 });
    expect(channelOf(louder, MIC1)).toEqual({ volume: 30, muted: false });
    const muted = mixerReducer(louder, { type: 'SET_MUTED', channel: MIC1, muted: true });
    expect(channelOf(muted, MIC1)).toEqual({ volume: 30, muted: true });
    expect(channelOf(muted, SLIDE_CHANNEL)).toEqual({ volume: 80, muted: false });
  });
  it('ignores out-of-range volumes', () => {
    expect(mixerReducer(initialMixerState, { type: 'SET_VOLUME', channel: MIC1, volume: 101 })).toBe(initialMixerState);
    expect(mixerReducer(initialMixerState, { type: 'SET_VOLUME', channel: MIC1, volume: -1 })).toBe(initialMixerState);
    expect(mixerReducer(initialMixerState, { type: 'SET_MASTER_VOLUME', volume: 100.5 })).toBe(initialMixerState);
  });
  it('controls the master', () => {
    const quiet = mixerReducer(initialMixerState, { type: 'SET_MASTER_VOLUME', volume: 0 });
    expect(quiet.master).toEqual({ volume: 0, muted: false });
    expect(mixerReducer(quiet, { type: 'SET_MASTER_MUTED', muted: true }).master).toEqual({ volume: 0, muted: true });
  });
  it('gain follows a square curve, 0 when muted', () => {
    expect(gainOf({ volume: 100, muted: false })).toBe(1);
    expect(gainOf({ volume: 50, muted: false })).toBe(0.25);
    expect(gainOf({ volume: 0, muted: false })).toBe(0);
    expect(gainOf({ volume: 100, muted: true })).toBe(0);
    expect(gainOf({ volume: 150, muted: false })).toBe(1);
    expect(gainOf({ volume: -10, muted: false })).toBe(0);
  });
});

describe('sources', () => {
  it('compares health maps by content (R3-10)', () => {
    const a = new Map([['camera:CAM1', 'live'], ['slide', 'stalled']] as const);
    expect(sameHealth(a, new Map(a))).toBe(true);
    expect(sameHealth(new Map(), new Map())).toBe(true);
    expect(sameHealth(a, new Map([['camera:CAM1', 'live']]))).toBe(false);
    expect(sameHealth(new Map([['camera:CAM1', 'live']]), a)).toBe(false);
    expect(sameHealth(a, new Map([['camera:CAM1', 'live'], ['slide', 'live']]))).toBe(false);
    expect(sameHealth(a, new Map([['camera:CAM2', 'live'], ['slide', 'stalled']]))).toBe(false);
  });
  it('health: disconnected / stalled / live with a 2s threshold', () => {
    expect(STALL_THRESHOLD_MS).toBe(2000);
    expect(healthOf({ connected: false, lastFrameAt: 1000 }, 1000)).toBe('disconnected');
    expect(healthOf({ connected: true, lastFrameAt: null }, 1000)).toBe('stalled');
    expect(healthOf({ connected: true, lastFrameAt: 1000 }, 3000)).toBe('live');
    expect(healthOf({ connected: true, lastFrameAt: 1000 }, 3001)).toBe('stalled');
    expect(healthOf({ connected: true, lastFrameAt: 1000 }, 1500, 400)).toBe('stalled');
    expect(HEALTH_LABEL).toEqual({ live: '受信中', stalled: '映像途絶', disconnected: '未接続' });
  });
  it('orders device names naturally, deduplicates and limits', () => {
    expect(orderDevices(['CAM10', 'CAM2', 'CAM1', 'CAM2'], 6)).toEqual(['CAM1', 'CAM2', 'CAM10']);
    expect(orderDevices(['b', 'a', 'c'], 2)).toEqual(['a', 'b']);
  });
  it('fills camera slots up to 6', () => {
    expect(MAX_CAMERAS).toBe(6);
    expect(cameraSlots(['CAM3', 'CAM1'])).toEqual(['CAM1', 'CAM3', null, null, null, null]);
    expect(cameraSlots(['A', 'B', 'C'], 2)).toEqual(['A', 'B']);
  });
  it('slide alert fires only after the share was seen (F-SHR-07)', () => {
    expect(slideAlert(false, 'disconnected')).toEqual({ seen: false, alert: false });
    expect(slideAlert(false, 'stalled')).toEqual({ seen: false, alert: false });
    expect(slideAlert(false, 'live')).toEqual({ seen: true, alert: false });
    expect(slideAlert(true, 'stalled')).toEqual({ seen: true, alert: true });
    expect(slideAlert(true, 'disconnected')).toEqual({ seen: true, alert: true });
    expect(slideAlert(true, 'live')).toEqual({ seen: true, alert: false });
  });
});

describe('remote', () => {
  const empty: RemoteState<string> = { entries: [] };
  const camera = (id: string, name: string) => ({ id, kind: 'camera' as const, deviceName: name });
  it('adds, merges, removes tracks and participants', () => {
    let state = remoteReducer(empty, { type: 'STREAMS_ADDED', stage: 'production', participant: camera('p1', 'CAM1'), tracks: [{ kind: 'video', track: 'v1' }] });
    expect(state.entries).toEqual([{ participantId: 'p1', stage: 'production', kind: 'camera', deviceName: 'CAM1', video: 'v1', audio: null }]);
    state = remoteReducer(state, { type: 'STREAMS_ADDED', stage: 'production', participant: camera('p1', 'CAM1'), tracks: [{ kind: 'audio', track: 'a1' }] });
    expect(state.entries[0]).toMatchObject({ video: 'v1', audio: 'a1' });
    state = remoteReducer(state, { type: 'STREAMS_REMOVED', participantId: 'p1', tracks: [{ kind: 'video', track: 'v1' }] });
    expect(state.entries[0]).toMatchObject({ video: null, audio: 'a1' });
    state = remoteReducer(state, { type: 'STREAMS_REMOVED', participantId: 'p1', tracks: [{ kind: 'audio', track: 'other' }] });
    expect(state.entries[0]).toMatchObject({ video: null, audio: 'a1' });
    state = remoteReducer(state, { type: 'STREAMS_REMOVED', participantId: 'p1', tracks: [{ kind: 'audio', track: 'a1' }] });
    expect(state.entries[0]).toMatchObject({ video: null, audio: null });
    const other = remoteReducer(state, { type: 'STREAMS_REMOVED', participantId: 'zz', tracks: [] });
    expect(other.entries).toEqual(state.entries);
    expect(remoteReducer(state, { type: 'LEFT', participantId: 'p1' }).entries).toEqual([]);
  });
  it('resets one stage only', () => {
    let state = remoteReducer(empty, { type: 'STREAMS_ADDED', stage: 'production', participant: camera('p1', 'CAM1'), tracks: [] });
    state = remoteReducer(state, { type: 'STREAMS_ADDED', stage: 'slide', participant: { id: 's', kind: 'slide', deviceName: 'SLIDE' }, tracks: [] });
    expect(remoteReducer(state, { type: 'RESET', stage: 'production' }).entries.map((entry) => entry.participantId)).toEqual(['s']);
    expect(remoteReducer(state, { type: 'RESET', stage: 'slide' }).entries.map((entry) => entry.participantId)).toEqual(['p1']);
  });
  it('routes cameras, mics and slide to sources and channels', () => {
    let state = empty;
    const add = (stage: 'production' | 'slide', id: string, kind: 'camera' | 'mic' | 'slide' | 'unknown', name: string, video: string | null, audio: string | null) => {
      const tracks = [...(video ? [{ kind: 'video' as const, track: video }] : []), ...(audio ? [{ kind: 'audio' as const, track: audio }] : [])];
      state = remoteReducer(state, { type: 'STREAMS_ADDED', stage, participant: { id, kind, deviceName: name }, tracks });
    };
    add('production', 'c2', 'camera', 'CAM2', 'v2', null);
    add('production', 'c1', 'camera', 'CAM1', null, null);
    add('production', 'm1', 'mic', 'MIC1', null, 'a1');
    add('production', 'm2', 'mic', 'MIC2', null, null);
    add('production', 'x', 'unknown', 'X', 'vx', 'ax');
    add('slide', 's', 'slide', 'SLIDE', 'vs', 'as');
    add('production', 'fake', 'slide', 'SLIDE', 'vf', 'af');
    add('slide', 'cs', 'camera', 'CAMS', 'vcs', null);
    const routed = routeMedia(state);
    expect(routed.cameraNames).toEqual(['CAM1', 'CAM2']);
    expect(routed.micNames).toEqual(['MIC1', 'MIC2']);
    expect([...routed.video]).toEqual([[cameraSource('CAM2'), 'v2'], [SLIDE, 'vs']]);
    expect([...routed.audio]).toEqual([[micChannel('MIC1'), 'a1'], [SLIDE_CHANNEL, 'as']]);
  });
  it('lets the newest participant win for the same device name and caps counts', () => {
    let state: RemoteState<string> = empty;
    state = remoteReducer(state, { type: 'STREAMS_ADDED', stage: 'production', participant: camera('old', 'CAM1'), tracks: [{ kind: 'video', track: 'old' }] });
    state = remoteReducer(state, { type: 'STREAMS_ADDED', stage: 'production', participant: camera('new', 'CAM1'), tracks: [{ kind: 'video', track: 'new' }] });
    for (let i = 2; i <= 8; i += 1) state = remoteReducer(state, { type: 'STREAMS_ADDED', stage: 'production', participant: camera(`p${i}`, `CAM${i}`), tracks: [{ kind: 'video', track: `v${i}` }] });
    for (let i = 1; i <= 7; i += 1) state = remoteReducer(state, { type: 'STREAMS_ADDED', stage: 'production', participant: { id: `m${i}`, kind: 'mic', deviceName: `MIC${i}` }, tracks: [{ kind: 'audio', track: `a${i}` }] });
    const routed = routeMedia(state);
    expect(routed.video.get(cameraSource('CAM1'))).toBe('new');
    expect(routed.cameraNames).toEqual(['CAM1', 'CAM2', 'CAM3', 'CAM4', 'CAM5', 'CAM6']);
    expect(routed.video.has(cameraSource('CAM7'))).toBe(false);
    expect(routed.micNames).toHaveLength(5);
    expect(routed.audio.has(micChannel('MIC6'))).toBe(false);
  });
});

describe('shortcuts', () => {
  const slots = ['CAM1', 'CAM2', null, null, null, null];
  it('maps keys to switching actions', () => {
    expect(keyToAction('1', slots)).toEqual({ type: 'SELECT_PREVIEW', source: cameraSource('CAM1') });
    expect(keyToAction('2', slots)).toEqual({ type: 'SELECT_PREVIEW', source: cameraSource('CAM2') });
    expect(keyToAction('3', slots)).toBeNull();
    expect(keyToAction('6', ['a', 'b', 'c', 'd', 'e', 'f'])).toEqual({ type: 'SELECT_PREVIEW', source: cameraSource('f') });
    expect(keyToAction('7', slots)).toEqual({ type: 'SELECT_PREVIEW', source: SLIDE });
    expect(keyToAction('8', slots)).toEqual({ type: 'SELECT_PREVIEW', source: STANDBY });
    expect(keyToAction(' ', slots)).toEqual({ type: 'CUT' });
    expect(keyToAction('Spacebar', slots)).toEqual({ type: 'CUT' });
    expect(keyToAction('Enter', slots)).toEqual({ type: 'AUTO' });
    expect(keyToAction('9', slots)).toBeNull();
    expect(keyToAction('0', slots)).toBeNull();
    expect(keyToAction('12', slots)).toBeNull();
    expect(keyToAction('a', slots)).toBeNull();
    expect(SHORTCUT_HELP.map(([key]) => key)).toEqual(['1〜6', '7', '8', 'Space', 'Enter']);
  });
  it('ignores keys in inputs, with modifiers, and Space/Enter on buttons', () => {
    const none = { ctrl: false, meta: false, alt: false };
    expect(INTERACTIVE_SELECTOR.split(',')).toEqual(expect.arrayContaining(['summary', 'button', 'a', 'input', '[role="button"]', '[role="slider"]', '[contenteditable="true"]']));
    expect(shouldIgnoreKey('1', null, none)).toBe(false);
    expect(shouldIgnoreKey('1', null, { ...none, ctrl: true })).toBe(true);
    expect(shouldIgnoreKey('1', null, { ...none, meta: true })).toBe(true);
    expect(shouldIgnoreKey('1', null, { ...none, alt: true })).toBe(true);
    expect(shouldIgnoreKey('1', { tagName: 'input' }, none)).toBe(true);
    expect(shouldIgnoreKey('1', { tagName: 'TEXTAREA' }, none)).toBe(true);
    expect(shouldIgnoreKey('1', { tagName: 'SELECT' }, none)).toBe(true);
    expect(shouldIgnoreKey('1', { tagName: 'DIV', isContentEditable: true }, none)).toBe(true);
    expect(shouldIgnoreKey('1', { tagName: 'SPAN', role: 'slider' }, none)).toBe(true);
    expect(shouldIgnoreKey('1', { tagName: 'BUTTON', role: 'combobox' }, none)).toBe(true);
    expect(shouldIgnoreKey('1', { tagName: 'BUTTON' }, none)).toBe(false);
    expect(shouldIgnoreKey(' ', { tagName: 'BUTTON' }, none)).toBe(true);
    expect(shouldIgnoreKey('Enter', { tagName: 'a' }, none)).toBe(true);
    // details の summary 上の Enter/Space は開閉に使う（R3-05）
    expect(shouldIgnoreKey('Enter', { tagName: 'SUMMARY' }, none)).toBe(true);
    expect(shouldIgnoreKey(' ', { tagName: 'summary' }, none)).toBe(true);
    expect(shouldIgnoreKey('1', { tagName: 'SUMMARY' }, none)).toBe(false);
    expect(shouldIgnoreKey('Enter', { tagName: 'SPAN', role: 'link' }, none)).toBe(true);
    expect(shouldIgnoreKey('Enter', { tagName: 'DIV', role: 'switch' }, none)).toBe(true);
    expect(shouldIgnoreKey(' ', { tagName: 'DIV' }, none)).toBe(false);
    expect(shouldIgnoreKey(' ', { role: null }, none)).toBe(false);
    expect(shouldIgnoreKey(' ', {}, none)).toBe(false);
  });
});

describe('broadcast', () => {
  it('formats elapsed time as H:MM:SS', () => {
    const start = '2026-10-19T10:00:00.000Z';
    const base = Date.parse(start);
    expect(formatElapsed(start, base)).toBe('0:00:00');
    expect(formatElapsed(start, base + 59_999)).toBe('0:00:59');
    expect(formatElapsed(start, base + 61_000)).toBe('0:01:01');
    expect(formatElapsed(start, base + (3600 + 600 + 5) * 1000)).toBe('1:10:05');
    expect(formatElapsed(start, base + 5 * 3600 * 1000)).toBe('5:00:00');
    expect(formatElapsed(start, base - 1000)).toBe('0:00:00');
    expect(formatElapsed(null, base)).toBe('0:00:00');
    expect(formatElapsed('not a date', base)).toBe('0:00:00');
  });
  it('builds preflight items from GET /api/status (F-OPS-02)', () => {
    const items = preflightItems({
      stages: [{ name: 'production', exists: true, status: 'ACTIVE' }, { name: 'slide', exists: true }, { name: 'broadcast', exists: false }],
      chatRoom: { exists: true },
    });
    expect(items).toEqual([
      { id: 'production', label: '制作用ステージ', ok: true, detail: 'ACTIVE' },
      { id: 'slide', label: 'スライド用ステージ', ok: true, detail: '利用可能' },
      { id: 'broadcast', label: '配信用ステージ', ok: false, detail: '見つかりません' },
      { id: 'chat', label: 'コメント（Chat ルーム）', ok: true, detail: '利用可能' },
    ]);
    expect(preflightReady(items)).toBe(false);
  });
  it('marks missing stages and chat failures', () => {
    const items = preflightItems({ stages: [], chatRoom: { exists: false, status: 'X' } });
    expect(items.map((item) => [item.ok, item.detail])).toEqual([[false, '応答なし'], [false, '応答なし'], [false, '応答なし'], [false, '見つかりません']]);
    const ok = preflightItems({ stages: ['production', 'slide', 'broadcast'].map((name) => ({ name, exists: true })), chatRoom: { exists: true, status: 'ACTIVE' } });
    expect(ok[3]?.detail).toBe('ACTIVE');
    expect(preflightReady(ok)).toBe(true);
    expect(preflightReady([])).toBe(false);
  });
});
