import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVenueAcousticRecorder } from './venueAcousticRecorder';

class FakeMediaRecorder extends EventTarget {
  static supported = ['audio/webm;codecs=opus'];
  static latest: FakeMediaRecorder | undefined;
  static isTypeSupported = vi.fn((type: string) => FakeMediaRecorder.supported.includes(type));
  state: RecordingState = 'inactive';
  constructor(readonly stream: MediaStream, readonly options?: MediaRecorderOptions) { super(); FakeMediaRecorder.latest = this; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.dispatchEvent(new Event('stop'));
  }
  chunk(data: string) {
    const event = new Event('dataavailable');
    Object.defineProperty(event, 'data', { value: new Blob([data]) });
    this.dispatchEvent(event);
  }
}

describe('venue acoustic recorder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeMediaRecorder.supported = ['audio/webm;codecs=opus'];
    FakeMediaRecorder.isTypeSupported.mockClear();
  });

  it('selects the first supported type and returns collected chunks on stop', async () => {
    FakeMediaRecorder.supported = ['audio/mp4'];
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const recorder = createVenueAcousticRecorder({} as MediaStream);
    recorder.start();
    const instance = FakeMediaRecorder.latest!;
    instance.chunk('first');
    instance.chunk('second');
    const result = await recorder.stop();
    expect(result).toMatchObject({ mimeType: 'audio/mp4', extension: 'mp4', byteCount: 11 });
    expect(result.blob.size).toBe(11);
    expect(FakeMediaRecorder.isTypeSupported).toHaveBeenNthCalledWith(1, 'audio/webm;codecs=opus');
    expect(FakeMediaRecorder.isTypeSupported).toHaveBeenNthCalledWith(2, 'audio/mp4');
  });

  it('rejects empty recordings and rejects unsupported browsers and MIME types', async () => {
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const recorder = createVenueAcousticRecorder({} as MediaStream);
    recorder.start();
    const result = await recorder.stop();
    expect(result.byteCount).toBe(0);
    expect(result.blob.size).toBe(0);

    const cleanupRecorder = createVenueAcousticRecorder({} as MediaStream);
    cleanupRecorder.start();
    const active = FakeMediaRecorder.latest!;
    cleanupRecorder.cleanup();
    expect(active.state).toBe('inactive');

    FakeMediaRecorder.supported = [];
    expect(() => createVenueAcousticRecorder({} as MediaStream)).toThrow(/no supported audio MIME type/);
    vi.stubGlobal('MediaRecorder', undefined);
    expect(() => createVenueAcousticRecorder({} as MediaStream)).toThrow(/does not support MediaRecorder/);
  });
});
