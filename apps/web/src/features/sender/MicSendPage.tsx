import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAudioLevel } from './audioLevel';
import { ConnectionStatus, DeviceNameSelect, ErrorNotice, LevelMeter, SenderErrorNotice, SenderShell } from './components';
import { validateDeviceName } from './engine/deviceName';
import { AUDIO_PUBLISH, micConstraints, toPublishTracks } from './engine/media';
import { canStart, classifyError, isActive, type SenderErrorKind } from './engine/session';
import { useDeviceName } from './useDeviceName';
import { useStageSender } from './useStageSender';

export default function MicSendPage() {
  const sender = useStageSender('mic');
  const { options, deviceName, setDeviceName } = useDeviceName('mic');
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);
  const [muted, setMuted] = useState(false);
  const [mediaError, setMediaError] = useState<SenderErrorKind | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const level = useAudioLevel(track);

  const openMic = useCallback(async () => {
    if (stream.current) return stream.current;
    try {
      const next = await navigator.mediaDevices.getUserMedia(micConstraints());
      stream.current = next;
      setTrack(next.getAudioTracks()[0] ?? null);
      setMediaError(null);
      return next;
    } catch (error) {
      setMediaError(classifyError(error));
      return null;
    }
  }, []);
  useEffect(() => () => stream.current?.getTracks().forEach((item) => item.stop()), []);

  const nameError = validateDeviceName('mic', deviceName);
  const start = async (takeover = false) => {
    const media = await openMic();
    if (!media || nameError) return;
    await sender.start(toPublishTracks(media.getAudioTracks(), undefined, AUDIO_PUBLISH), deviceName, muted, takeover);
  };
  const toggleMute = (value: boolean) => {
    setMuted(value);
    sender.setMuted(value);
  };
  const error = sender.state.error ?? mediaError;

  return (
    <SenderShell title="マイク送信" description="登壇者・質問者の声を配信に送ります。" status={<ConnectionStatus status={sender.state.status} />}>
      <LevelMeter label="入力レベル" value={level} muted={muted} />
      {!track && <Button variant="outline" className="h-11 w-full" onClick={() => void openMic()}><Mic aria-hidden />マイクを確認</Button>}
      <DeviceNameSelect id="mic-device-name" options={options} value={deviceName} onChange={setDeviceName} disabled={!canStart(sender.state.status)} />
      <div className="flex min-h-11 items-center justify-between">
        <Label htmlFor="mic-mute" className="gap-2">{muted ? <MicOff aria-hidden className="size-4" /> : <Mic aria-hidden className="size-4" />}ミュート</Label>
        <Switch id="mic-mute" checked={muted} onCheckedChange={toggleMute} />
      </div>
      {nameError && <ErrorNotice>{nameError}</ErrorNotice>}
      {error && <SenderErrorNotice error={error} purpose="mic" deviceName={deviceName} onTakeover={() => void start(true)} />}
      {isActive(sender.state.status) ? (
        <Button variant="outline" className="h-11 w-full" onClick={sender.stop}><Square aria-hidden />送信停止</Button>
      ) : (
        <Button className="h-11 w-full" onClick={() => void start()} disabled={!canStart(sender.state.status) || Boolean(nameError)}>
          <Mic aria-hidden />送信開始
        </Button>
      )}
      {isActive(sender.state.status) && <p className="text-sm text-muted-foreground">送信中は画面を消さないでください。回線が切れても自動で再接続します。</p>}
    </SenderShell>
  );
}
