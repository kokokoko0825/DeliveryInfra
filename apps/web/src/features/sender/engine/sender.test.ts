import { describe, expect, it } from 'vitest';
import { deviceNameOptions, validateDeviceName } from './deviceName';
import {
  AUDIO_PUBLISH, CAMERA_PUBLISH, LEVEL_FLOOR_DB, cameraConstraints, displayMediaOptions, levelPercent, micConstraints, rms, smoothLevel, toPublishTracks,
} from './media';
import { canStart, classifyError, errorText, initialSenderState, isActive, senderReducer, statusText, type SenderState } from './session';

describe('deviceName', () => {
  it('offers CAM1〜CAM6 and MIC1〜MIC5', () => {
    expect(deviceNameOptions('camera')).toEqual(['CAM1', 'CAM2', 'CAM3', 'CAM4', 'CAM5', 'CAM6']);
    expect(deviceNameOptions('mic')).toEqual(['MIC1', 'MIC2', 'MIC3', 'MIC4', 'MIC5']);
  });
  it('accepts names from the list only', () => {
    expect(validateDeviceName('camera', 'CAM1')).toBeNull();
    expect(validateDeviceName('camera', 'CAM6')).toBeNull();
    expect(validateDeviceName('mic', 'MIC5')).toBeNull();
    expect(validateDeviceName('camera', 'CAM7')).toBe('端末名は CAM1 / CAM2 / CAM3 / CAM4 / CAM5 / CAM6 から選んでください');
    expect(validateDeviceName('mic', 'MIC6')).toContain('MIC1 / MIC2');
    expect(validateDeviceName('camera', 'MIC1')).not.toBeNull();
  });
  it('rejects names that break the shared schema', () => {
    const message = '端末名は英数字とハイフンで1〜16文字にしてください';
    expect(validateDeviceName('camera', '')).toBe(message);
    expect(validateDeviceName('camera', 'CAM 1')).toBe(message);
    expect(validateDeviceName('camera', 'A'.repeat(17))).toBe(message);
    expect(validateDeviceName('camera', 'カメラ')).toBe(message);
  });
});

describe('senderReducer', () => {
  const at = (status: SenderState['status']): SenderState => ({ status, error: status === 'error' ? 'network' : null, reconnects: 2 });
  it('walks idle → starting → live → reconnecting → live', () => {
    let state = senderReducer(initialSenderState, { type: 'START' });
    expect(state).toEqual({ status: 'starting', error: null, reconnects: 0 });
    state = senderReducer(state, { type: 'CONNECTED' });
    expect(state.status).toBe('live');
    state = senderReducer(state, { type: 'CONNECTION_LOST' });
    expect(state).toEqual({ status: 'reconnecting', error: null, reconnects: 1 });
    state = senderReducer(state, { type: 'CONNECTED' });
    expect(state).toEqual({ status: 'live', error: null, reconnects: 1 });
  });
  it('ignores START while running and restarts from error', () => {
    for (const status of ['starting', 'live', 'reconnecting'] as const) expect(senderReducer(at(status), { type: 'START' })).toEqual(at(status));
    expect(senderReducer(at('error'), { type: 'START' })).toEqual({ status: 'starting', error: null, reconnects: 0 });
  });
  it('ignores CONNECTED and CONNECTION_LOST outside their states', () => {
    for (const status of ['idle', 'live', 'error'] as const) expect(senderReducer(at(status), { type: 'CONNECTED' })).toEqual(at(status));
    for (const status of ['idle', 'starting', 'reconnecting', 'error'] as const) expect(senderReducer(at(status), { type: 'CONNECTION_LOST' })).toEqual(at(status));
  });
  it('records failures except when idle, and STOPPED resets', () => {
    expect(senderReducer(at('starting'), { type: 'FAILED', error: 'deviceLimit' })).toEqual({ status: 'error', error: 'deviceLimit', reconnects: 2 });
    expect(senderReducer(at('idle'), { type: 'FAILED', error: 'deviceLimit' })).toEqual(at('idle'));
    expect(senderReducer(at('live'), { type: 'STOPPED' })).toEqual(initialSenderState);
  });
  it('isActive / canStart', () => {
    expect(['idle', 'starting', 'live', 'reconnecting', 'error'].map((s) => isActive(s as SenderState['status']))).toEqual([false, false, true, true, false]);
    expect(['idle', 'starting', 'live', 'reconnecting', 'error'].map((s) => canStart(s as SenderState['status']))).toEqual([true, false, false, false, true]);
  });
});

describe('classifyError', () => {
  it('maps API errors and media errors', () => {
    expect(classifyError({ code: 'DEVICE_LIMIT', status: 409 })).toBe('deviceLimit');
    expect(classifyError({ code: 'FORBIDDEN', status: 403 })).toBe('forbidden');
    expect(classifyError({ status: 401 })).toBe('forbidden');
    expect(classifyError({ name: 'NotAllowedError' })).toBe('permission');
    expect(classifyError({ name: 'SecurityError' })).toBe('permission');
    expect(classifyError({ name: 'NotFoundError' })).toBe('notFound');
    expect(classifyError({ name: 'OverconstrainedError' })).toBe('notFound');
    expect(classifyError({ name: 'NotReadableError' })).toBe('busy');
    expect(classifyError({ name: 'AbortError' })).toBe('busy');
    expect(classifyError({ status: 500 })).toBe('network');
    expect(classifyError(new Error('x'))).toBe('network');
    expect(classifyError(null)).toBe('network');
    expect(classifyError('x')).toBe('network');
  });
});

describe('texts', () => {
  it('describes the device limit with the shared limits (F-CAM-06, F-MIC-05)', () => {
    expect(errorText('deviceLimit', 'camera')).toBe('カメラは最大6台まで接続できます。他の端末の送信が停止するまでお待ちください。');
    expect(errorText('deviceLimit', 'mic')).toContain('マイクは最大5台');
    expect(errorText('deviceLimit', 'slide')).toContain('スライド共有は最大1台');
    expect(errorText('deviceLimit', 'viewer')).toContain('送信は最大0台');
  });
  it('has a message for every error kind', () => {
    expect(errorText('permission', 'camera')).toContain('カメラの使用が許可されていません');
    expect(errorText('notFound', 'mic')).toBe('使用できるマイクが見つかりません。');
    expect(errorText('busy', 'camera')).toContain('他のアプリが使用中');
    expect(errorText('forbidden', 'camera')).toContain('権限がありません');
    expect(errorText('network', 'camera')).toContain('回線を確認');
  });
  it('labels each status', () => {
    expect(['idle', 'starting', 'live', 'reconnecting', 'error'].map((s) => statusText(s as SenderState['status']))).toEqual(['未接続', '接続中', '送信中', '再接続中', 'エラー']);
  });
});

describe('media constraints', () => {
  it('camera: 720p / 30fps without audio (F-CAM-01, 03)', () => {
    expect(cameraConstraints('user')).toEqual({
      audio: false,
      video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
    });
    expect((cameraConstraints('environment').video as MediaTrackConstraints).facingMode).toEqual({ ideal: 'environment' });
  });
  it('mic: 48kHz mono, audio only', () => {
    expect(micConstraints()).toEqual({ video: false, audio: { sampleRate: 48000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  });
  it('display: max 1280x720@30 with system audio (F-SHR-03, 04)', () => {
    const options = displayMediaOptions();
    expect(options.video).toEqual({ width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 } });
    expect(options.audio).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    expect(options.systemAudio).toBe('include');
    expect(options.selfBrowserSurface).toBe('exclude');
    expect(options.surfaceSwitching).toBe('include');
  });
  it('attaches publish config by track kind', () => {
    const video = { kind: 'video' } as MediaStreamTrack;
    const audio = { kind: 'audio' } as MediaStreamTrack;
    expect(toPublishTracks([video, audio], CAMERA_PUBLISH, AUDIO_PUBLISH)).toEqual([{ track: video, config: CAMERA_PUBLISH }, { track: audio, config: AUDIO_PUBLISH }]);
    expect(CAMERA_PUBLISH).toEqual({ maxVideoBitrateKbps: 2000, maxFramerate: 30 });
  });
});

describe('level', () => {
  it('rms', () => {
    expect(rms([])).toBe(0);
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
    expect(rms([1, 0])).toBeCloseTo(Math.SQRT1_2);
  });
  it('maps -60〜0 dBFS to 0〜100', () => {
    expect(LEVEL_FLOOR_DB).toBe(-60);
    expect(levelPercent(0)).toBe(0);
    expect(levelPercent(-1)).toBe(0);
    expect(levelPercent(1)).toBe(100);
    expect(levelPercent(2)).toBe(100);
    expect(levelPercent(0.001)).toBe(0);
    expect(levelPercent(0.0001)).toBe(0);
    expect(levelPercent(10 ** (-30 / 20))).toBe(50);
    expect(levelPercent(10 ** (-6 / 20))).toBe(90);
  });
  it('rises instantly and falls by decay', () => {
    expect(smoothLevel(10, 50)).toBe(50);
    expect(smoothLevel(50, 50)).toBe(50);
    expect(smoothLevel(50, 0)).toBe(46);
    expect(smoothLevel(50, 48)).toBe(48);
    expect(smoothLevel(50, 0, 10)).toBe(40);
  });
});
