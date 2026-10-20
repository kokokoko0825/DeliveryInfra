export const VENUE_ACOUSTIC_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/mp4',
] as const;

export type VenueAcousticRecording = {
  blob: Blob;
  mimeType: string;
  extension: 'webm' | 'mp4';
  byteCount: number;
};

export type VenueAcousticRecorder = {
  start(): void;
  stop(): Promise<VenueAcousticRecording>;
  cleanup(): void;
};

export function createVenueAcousticRecorder(stream: MediaStream): VenueAcousticRecorder {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Audio recording is unavailable: this browser does not support MediaRecorder.');
  }

  const mimeType = VENUE_ACOUSTIC_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) {
    throw new Error('Audio recording is unavailable: no supported audio MIME type (WebM/Opus or MP4).');
  }

  const extension = mimeType.startsWith('audio/webm') ? 'webm' : 'mp4';
  const recorder = new MediaRecorder(stream, { mimeType });
  let chunks: Blob[] = [];
  let pendingStop: Promise<VenueAcousticRecording> | undefined;

  recorder.addEventListener('dataavailable', (event: BlobEvent) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  return {
    start() {
      if (recorder.state !== 'inactive') throw new Error('Audio recording is already active.');
      chunks = [];
      pendingStop = undefined;
      recorder.start();
    },
    stop() {
      if (pendingStop) return pendingStop;
      if (recorder.state === 'inactive') return Promise.reject(new Error('Audio recording has not been started.'));
      pendingStop = new Promise((resolve, reject) => {
        recorder.addEventListener('error', () => reject(new Error('Audio recording failed.')), { once: true });
        recorder.addEventListener('stop', () => {
          const blob = new Blob(chunks, { type: mimeType });
          chunks = [];
          resolve({ blob, mimeType, extension, byteCount: blob.size });
        }, { once: true });
      });
      recorder.stop();
      return pendingStop;
    },
    cleanup() {
      if (recorder.state !== 'inactive') recorder.stop();
      chunks = [];
    },
  };
}
