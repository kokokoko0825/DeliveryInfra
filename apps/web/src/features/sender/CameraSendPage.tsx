import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Square, SwitchCamera } from 'lucide-react';
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

export default function CameraSendPage() {
  const sender = useStageSender('camera');
  const { updateTracks } = sender;
  const { options, deviceName, setDeviceName } = useDeviceName('camera');
  const [facing, setFacing] = useState<Facing>('environment');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<SenderErrorKind | null>(null);
  const current = useRef<MediaStream | null>(null);
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

  const nameError = validateDeviceName('camera', deviceName);
  const start = async (takeover = false) => {
    const media = current.current ?? await openCamera(facing);
    if (!media || nameError) return;
    await sender.start(toPublishTracks(media.getVideoTracks(), CAMERA_PUBLISH, undefined), deviceName, false, takeover);
  };
  const error = sender.state.error ?? mediaError;

  return (
    <SenderShell title="カメラ送信" description="720p / 30fps で映像だけを送ります。音声はマイク端末から送ってください。" status={<ConnectionStatus status={sender.state.status} />}>
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
