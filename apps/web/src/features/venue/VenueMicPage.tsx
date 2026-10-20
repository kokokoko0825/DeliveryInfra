import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SenderShell } from '@/features/sender/components';
import { startVenueMic, type VenueSession } from './venueAudio';

export default function VenueMicPage() {
  const [status, setStatus] = useState('停止');
  const [error, setError] = useState<string | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const session = useRef<VenueSession | null>(null);
  useEffect(
    () => () => {
      session.current?.close();
      stream.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );
  const start = async () => {
    try {
      setError(null);
      setStatus('マイクを開いています');
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 48000,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      setStatus('相手を待っています');
      const current = await startVenueMic(stream.current);
      session.current = current;
      await current.connected;
      setStatus('接続中');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '接続に失敗しました');
      setStatus('エラー');
    }
  };
  const stop = () => {
    session.current?.close();
    session.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setStatus('停止');
  };
  return (
    <SenderShell
      title="会場音声 PoC: マイク"
      description="低遅延設定で PCM 音声を WebRTC DataChannel に送ります。"
      status={<span>{status}</span>}
    >
      <p role="status" className="text-sm">
        状態: {status}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {status === '停止' || status === 'エラー' ? (
        <Button className="h-11 w-full" onClick={() => void start()}>
          <Mic aria-hidden />
          接続開始
        </Button>
      ) : (
        <Button variant="outline" className="h-11 w-full" onClick={stop}>
          <Square aria-hidden />
          停止
        </Button>
      )}
      <p className="text-sm text-muted-foreground">
        スピーカー側も開き、同じ LAN の端末間通信を許可してください。
      </p>
    </SenderShell>
  );
}
