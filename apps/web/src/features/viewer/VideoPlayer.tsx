import { useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';

type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/** 受信したステージ映像の再生。自動再生制限のため最初はミュートで再生し、タップで音声をオンにする。 */
export function VideoPlayer({ stream }: { stream: MediaStream | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<FullscreenVideo>(null);
  const [muted, setMuted] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [volume, setVolume] = useState(100);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) video.play().catch(() => undefined);
  }, [stream]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    video.volume = volume / 100;
  }, [muted, volume]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const unlockAudio = () => {
    setUnlocked(true);
    setMuted(false);
    videoRef.current?.play().catch(() => undefined);
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    if (container?.requestFullscreen) { void container.requestFullscreen(); return; }
    video?.webkitEnterFullscreen?.();
  };

  return (
    <div ref={containerRef} className="relative overflow-hidden rounded-xl border bg-muted">
      <video ref={videoRef} className="aspect-video w-full" autoPlay playsInline muted={muted} aria-label="配信映像" />
      {!unlocked && (
        <Button size="lg" className="absolute inset-x-0 top-1/2 mx-auto min-h-11 w-fit -translate-y-1/2" onClick={unlockAudio}>
          <Volume2 aria-hidden />タップして音声オン
        </Button>
      )}
      <div className="flex items-center gap-2 bg-card/90 px-2 py-1 text-card-foreground">
        <Button variant="ghost" size="icon" className="size-11" aria-label={muted ? 'ミュート解除' : 'ミュート'} aria-pressed={muted}
          onClick={() => { setUnlocked(true); setMuted((value) => !value); }}>
          {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
        </Button>
        <Slider className="w-32" aria-label="音量" min={0} max={100} step={1} value={[volume]}
          onValueChange={([value = 0]) => { setVolume(value); if (value > 0) { setUnlocked(true); setMuted(false); } }} />
        <span className="ml-auto" />
        <Button variant="ghost" size="icon" className="size-11" aria-label={fullscreen ? '全画面を終了' : '全画面表示'} onClick={toggleFullscreen}>
          {fullscreen ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
        </Button>
      </div>
    </div>
  );
}
