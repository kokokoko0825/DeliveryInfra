import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { ErrorText } from '@/components/app/StatusView';

/** Safari はネイティブ HLS、それ以外は hls.js で再生する。 */
export function canPlayNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

/** アーカイブ再生。ダウンロード不可（controlsList=nodownload・右クリック抑止）。 */
export function HlsPlayer({ src, title }: { src: string; title: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    setError(null);
    if (canPlayNativeHls(video)) {
      video.src = src;
      return () => { video.removeAttribute('src'); video.load(); };
    }
    if (!Hls.isSupported()) { setError('このブラウザではアーカイブを再生できません'); return undefined; }
    const hls = new Hls({ xhrSetup: (xhr) => { xhr.withCredentials = true; } });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) setError('再生中にエラーが発生しました。ページを再読み込みしてください');
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    return () => hls.destroy();
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
