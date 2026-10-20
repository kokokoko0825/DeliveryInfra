import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Minus, Plus, Square, SwitchCamera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ConnectionStatus, DeviceNameSelect, ErrorNotice, SenderErrorNotice, SenderShell, VideoPreview } from './components';
import { validateDeviceName } from './engine/deviceName';
import { CAMERA_PUBLISH, cameraConstraints, toPublishTracks, type Facing } from './engine/media';
import { canStart, classifyError, isActive, type SenderErrorKind } from './engine/session';
import { useDeviceName } from './useDeviceName';
import { useStageSender } from './useStageSender';

const stopStream = (stream: MediaStream | null) => stream?.getTracks().forEach((track) => track.stop());

type CameraZoom = { min: number; max: number; step: number; value: number };
type ZoomCapabilities = { zoom?: { min: number; max: number; step?: number } };

function cameraZoom(stream: MediaStream | null): CameraZoom | null {
  const track = stream?.getVideoTracks()[0];
  if (!track || typeof track.getCapabilities !== 'function') return null;
  try {
    const range = (track.getCapabilities() as MediaTrackCapabilities & ZoomCapabilities).zoom;
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max <= range.min) return null;
    const value = track.getSettings().zoom ?? range.min;
    return { min: range.min, max: range.max, step: range.step && range.step > 0 ? range.step : (range.max - range.min) / 20, value };
  } catch {
    return null;
  }
}

export default function CameraSendPage() {
  const sender = useStageSender('camera');
  const { updateTracks } = sender;
  const { options, deviceName, setDeviceName } = useDeviceName('camera');
  const [facing, setFacing] = useState<Facing>('environment');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [zoom, setZoom] = useState<CameraZoom | null>(null);
  const [mediaError, setMediaError] = useState<SenderErrorKind | null>(null);
  const current = useRef<MediaStream | null>(null);
  const livePreview = useRef<HTMLVideoElement>(null);
  /** 最新の getUserMedia 要求の番号。古い要求の結果は使わずに止める（R3-09） */
  const request = useRef(0);
  const active = isActive(sender.state.status);
  const activeRef = useRef(active);
  activeRef.current = active;

  const openCamera = useCallback(async (nextFacing: Facing) => {
    const id = ++request.current;
    // iOS は同時に2つのカメラを開けないため、先に止める
    stopStream(current.current);
    current.current = null;
    setStream(null);
    try {
      const next = await navigator.mediaDevices.getUserMedia(cameraConstraints(nextFacing));
      // 取得中に前面/背面が切り替わった・画面を離れた場合は、この結果を捨てて必ず止める
      if (id !== request.current) {
        stopStream(next);
        return null;
      }
      current.current = next;
      setStream(next);
      setZoom(cameraZoom(next));
      setMediaError(null);
      if (activeRef.current) updateTracks(toPublishTracks(next.getVideoTracks(), CAMERA_PUBLISH, undefined));
      return next;
    } catch (error) {
      if (id === request.current) setMediaError(classifyError(error));
      return null;
    }
  }, [updateTracks]);

  useEffect(() => {
    void openCamera(facing);
  }, [facing, openCamera]);
  useEffect(() => () => {
    request.current += 1;
    stopStream(current.current);
  }, []);
  useEffect(() => {
    if (livePreview.current) livePreview.current.srcObject = stream;
  }, [stream, sender.state.status]);

  const nameError = validateDeviceName('camera', deviceName);
  const start = async (takeover = false) => {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      void document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
    }
    const media = current.current ?? await openCamera(facing);
    if (!media || nameError) return;
    await sender.start(toPublishTracks(media.getVideoTracks(), CAMERA_PUBLISH, undefined), deviceName, false, takeover);
  };
  const stop = () => {
    sender.stop();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };
  const error = sender.state.error ?? mediaError;
  const cameraView = active || sender.state.status === 'starting';

  const changeZoom = async (direction: -1 | 1) => {
    const track = current.current?.getVideoTracks()[0];
    if (!track || !zoom) return;
    const value = Math.max(zoom.min, Math.min(zoom.max, Math.round((zoom.value + direction * zoom.step) * 100) / 100));
    if (value === zoom.value) return;
    setZoom({ ...zoom, value });
    try {
      await track.applyConstraints({ advanced: [{ zoom: value }] } as unknown as MediaTrackConstraints);
    } catch {
      setZoom((currentZoom) => currentZoom ? { ...currentZoom, value: track.getSettings().zoom ?? zoom.value } : null);
    }
  };

  useEffect(() => {
    if (sender.state.status === 'error' && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, [sender.state.status]);

  if (cameraView) {
    return (
      <main className="fixed inset-0 z-50 bg-black">
        <video ref={livePreview} aria-label="送信中のカメラ映像" className="absolute inset-0 size-full object-contain" autoPlay muted playsInline />
        {sender.state.status === 'reconnecting' && <p role="status" className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-2 text-sm text-white">再接続中…</p>}
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-5 px-6 pb-[max(2rem,env(safe-area-inset-bottom))]">
          {zoom && (
            <div className="flex items-center gap-4 rounded-full bg-black/60 px-3 py-2 text-white">
              <Button variant="secondary" size="icon" className="size-11 rounded-full" aria-label="ズームアウト" disabled={zoom.value <= zoom.min} onClick={() => void changeZoom(-1)}><Minus aria-hidden /></Button>
              <span className="min-w-12 text-center text-sm tabular-nums">{zoom.value.toFixed(1)}×</span>
              <Button variant="secondary" size="icon" className="size-11 rounded-full" aria-label="ズームイン" disabled={zoom.value >= zoom.max} onClick={() => void changeZoom(1)}><Plus aria-hidden /></Button>
            </div>
          )}
          <Button variant="destructive" size="icon" className="size-16 rounded-full border-4 border-white/80" aria-label="送信停止" onClick={stop}><Square aria-hidden /></Button>
        </div>
      </main>
    );
  }

  return (
    <SenderShell title="カメラ送信" description="720p / 30fps で映像だけを送ります。横向きで撮影するときは端末の画面回転ロックを解除してください。ロック中は映像が横向きで送信されない場合があります。音声はマイク端末から送ってください。" status={<ConnectionStatus status={sender.state.status} />}>
      <VideoPreview stream={stream} label="カメラのプレビュー" />
      <div className="grid gap-4 sm:grid-cols-2">
        <DeviceNameSelect id="camera-device-name" options={options} value={deviceName} onChange={setDeviceName} disabled={!canStart(sender.state.status)} />
        <div className="space-y-2">
          <Label id="facing-label"><SwitchCamera aria-hidden className="size-4" />カメラ</Label>
          <ToggleGroup type="single" variant="outline" aria-labelledby="facing-label" value={facing} onValueChange={(value) => value && setFacing(value as Facing)} className="w-full">
            <ToggleGroupItem value="user" className="h-11 flex-1">前面</ToggleGroupItem>
            <ToggleGroupItem value="environment" className="h-11 flex-1">背面</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      {nameError && <ErrorNotice>{nameError}</ErrorNotice>}
      {error && <SenderErrorNotice error={error} purpose="camera" deviceName={deviceName} onTakeover={() => void start(true)} />}
      {canStart(sender.state.status) || sender.state.status === 'starting' ? (
        <Button className="h-11 w-full" onClick={() => void start()} disabled={!canStart(sender.state.status) || Boolean(nameError)}>
          <Camera aria-hidden />送信開始
        </Button>
      ) : (
        <Button variant="outline" className="h-11 w-full" onClick={sender.stop}><Square aria-hidden />送信停止</Button>
      )}
      {active && <p className="text-sm text-muted-foreground">送信中は画面を消さないでください。回線が切れても自動で再接続します。</p>}
    </SenderShell>
  );
}
