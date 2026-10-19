import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { ErrorText } from '@/components/app/StatusView';

/** Safari はネイティブ HLS、それ以外は hls.js で再生する。 */
export function canPlayNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

/** 再生が進まないまま Cookie の取り直しで復帰を試みる上限回数。 */
export const MAX_RECOVERIES = 3;
const FAILED = '再生中にエラーが発生しました。ページを再読み込みしてください';
/**
 * ネイティブ HLS で Cookie の取り直しを試す MediaError のコード（MEDIA_ERR_NETWORK / MEDIA_ERR_SRC_NOT_SUPPORTED）。
 * Safari は 403 の playlist を SRC_NOT_SUPPORTED で返すことがある。DECODE（壊れたセグメント）は取り直しても直らない（R4-05）。
 */
const RECOVERABLE_MEDIA_ERRORS: readonly number[] = [2, 4];

/**
 * アーカイブ再生。ダウンロード不可（controlsList=nodownload・右クリック抑止）。
 * 署名付き Cookie（1時間）が切れてセグメントが 403 になったら、Cookie を取り直して現在位置から読み込み直す（R3-03）。
 * 例: 一時停止のまま1時間置いてから再開 → 403 → refreshCookies() → 続きから再生。
 */
export function HlsPlayer({ src, title, refreshCookies }: { src: string; title: string; refreshCookies: () => Promise<void> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRef(refreshCookies);
  refresh.current = refreshCookies;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    setError(null);
    let disposed = false;
    let recoveries = 0;
    /** Cookie を取り直してから resume を呼ぶ。上限を超えたか取り直しに失敗したらエラー表示。 */
    const recover = (resume: () => void) => {
      if (recoveries >= MAX_RECOVERIES) { setError(FAILED); return; }
      recoveries += 1;
      refresh.current()
        .then(() => { if (!disposed) resume(); })
        .catch(() => { if (!disposed) setError(FAILED); });
    };

    if (canPlayNativeHls(video)) {
      // ネイティブ HLS は HTTP の状態が取れないので、回線・読み込みのエラーだけ Cookie を取り直して src を張り直す
      let stalledAt = 0;
      const reload = () => {
        const position = video.currentTime;
        const wasPlaying = !video.paused;
        video.addEventListener('loadedmetadata', () => {
          video.currentTime = position;
          if (wasPlaying) video.play().catch(() => undefined);
        }, { once: true });
        video.src = src;
        video.load();
      };
      const onError = () => {
        if (!RECOVERABLE_MEDIA_ERRORS.includes(video.error?.code ?? 0)) { setError(FAILED); return; }
        stalledAt = video.currentTime;
        recover(reload);
      };
      // 同じ位置で再生開始 → エラーを繰り返すと回数が戻り続けるので、止まった位置より先に進んだときだけ数え直す（R4-05）
      const onTimeUpdate = () => { if (video.currentTime > stalledAt) recoveries = 0; };
      video.addEventListener('error', onError);
      video.addEventListener('timeupdate', onTimeUpdate);
      video.src = src;
      return () => {
        disposed = true;
        video.removeEventListener('error', onError);
        video.removeEventListener('timeupdate', onTimeUpdate);
        video.removeAttribute('src');
        video.load();
      };
    }
    if (!Hls.isSupported()) { setError('このブラウザではアーカイブを再生できません'); return undefined; }
    const hls = new Hls({ xhrSetup: (xhr) => { xhr.withCredentials = true; } });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      // 4xx（Cookie 失効の 403 など）は hls.js が再試行しない。取り直して現在位置から読み込みを再開する
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) recover(() => hls.startLoad(video.currentTime));
      else setError(FAILED);
    });
    hls.on(Hls.Events.FRAG_LOADED, () => { recoveries = 0; });
    hls.loadSource(src);
    hls.attachMedia(video);
    return () => {
      disposed = true;
      hls.destroy();
    };
  }, [src]);

  return (
    <div className="space-y-2">
      <video
        ref={videoRef}
        className="aspect-video w-full rounded-xl border bg-muted"
        controls
        playsInline
        controlsList="nodownload noremoteplayback"
        disablePictureInPicture
        onContextMenu={(event) => event.preventDefault()}
        aria-label={title}
      />
      {error && <ErrorText message={error} />}
    </div>
  );
}
