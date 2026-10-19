import { useEffect, useRef, useState } from 'react';
import { MonitorOff, MonitorUp, RefreshCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAudioLevel } from './audioLevel';
import { ConnectionStatus, ErrorNotice, LevelMeter, SenderShell, VideoPreview } from './components';
import { PC_AUDIO_PUBLISH, SLIDE_PUBLISH, displayMediaOptions, toPublishTracks } from './engine/media';
import { canStart, classifyError, errorText, isActive, type SenderErrorKind } from './engine/session';
import { useStageSender } from './useStageSender';

function ShareGuide() {
  return (
    <Tabs defaultValue="powerpoint">
      <TabsList className="w-full">
        <TabsTrigger value="powerpoint" className="min-h-11">PowerPoint</TabsTrigger>
        <TabsTrigger value="google" className="min-h-11">Google スライド</TabsTrigger>
      </TabsList>
      <TabsContent value="powerpoint">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>発表者ビューでスライドショーを開始し、外部ディスプレイに映す</li>
          <li>「画面全体」でプロジェクターの画面を選ぶ</li>
          <li>「システム音声を共有」をオンにして共有</li>
        </ol>
      </TabsContent>
      <TabsContent value="google">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>スライドショーを表示しているタブを用意する</li>
          <li>「Chrome タブ」でそのタブを選ぶ</li>
          <li>「タブの音声も共有」をオンにして共有</li>
        </ol>
      </TabsContent>
      <p className="mt-2 text-xs text-muted-foreground">ウィンドウ単体の共有では音声を送れません。共有中は通知をオフにしてください。推奨: Windows の Chrome / Edge。</p>
    </Tabs>
  );
}

export default function SlideSharePage() {
  const sender = useStageSender('slide');
  const { updateTracks } = sender;
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [shareEnded, setShareEnded] = useState(false);
  const [mediaError, setMediaError] = useState<SenderErrorKind | null>(null);
  const current = useRef<MediaStream | null>(null);
  const level = useAudioLevel(stream?.getAudioTracks()[0] ?? null);

  useEffect(() => () => current.current?.getTracks().forEach((track) => track.stop()), []);

  const capture = async () => {
    try {
      const next = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions());
      const video = next.getVideoTracks()[0];
      if (video) {
        // 文字の読みやすさを優先（F-SHR-04）
        video.contentHint = 'text';
        // ブラウザの「共有を停止」や共有対象が閉じられたとき（F-SHR-08）
        video.addEventListener('ended', () => {
          if (current.current !== next) return;
          setShareEnded(true);
          updateTracks([]);
        });
      }
      current.current?.getTracks().forEach((track) => track.stop());
      current.current = next;
      setStream(next);
      setShareEnded(false);
      setMediaError(null);
      return next;
    } catch (error) {
      setMediaError(classifyError(error));
      return null;
    }
  };
  const tracksOf = (media: MediaStream) => toPublishTracks(media.getTracks(), SLIDE_PUBLISH, PC_AUDIO_PUBLISH);

  const start = async () => {
    const media = await capture();
    if (media) await sender.start(tracksOf(media));
  };
  const reshare = async () => {
    const media = await capture();
    if (media) updateTracks(tracksOf(media));
  };
  const stop = () => {
    sender.stop();
    current.current?.getTracks().forEach((track) => track.stop());
    current.current = null;
    setStream(null);
    setShareEnded(false);
  };
  const active = isActive(sender.state.status);
  const error = sender.state.error ?? mediaError;
  const hasAudio = Boolean(stream?.getAudioTracks().length);

  return (
    <SenderShell title="スライド共有" description="1280×720・最大30fpsで、スライドの画面とPC音声を送ります。" status={<ConnectionStatus status={shareEnded ? 'error' : sender.state.status} label={shareEnded ? '共有が停止しました' : undefined} />}>
      <VideoPreview stream={stream} label="共有中の画面" />
      <LevelMeter label={hasAudio || !stream ? 'PC音声' : 'PC音声（共有されていません）'} value={level} />
      {shareEnded && (
        <Alert>
          <MonitorOff aria-hidden />
          <AlertTitle>画面共有が停止しました</AlertTitle>
          <AlertDescription>
            <p>ブラウザの仕様上、共有の許可はもう一度手動で行う必要があります。</p>
            <Button className="mt-2 h-11 w-full" onClick={() => void reshare()}><RefreshCw aria-hidden />もう一度共有する</Button>
          </AlertDescription>
        </Alert>
      )}
      {error && <ErrorNotice>{errorText(error, 'slide')}</ErrorNotice>}
      {active ? (
        <Button variant="outline" className="h-11 w-full" onClick={stop}><Square aria-hidden />共有停止</Button>
      ) : (
        <Button className="h-11 w-full" onClick={() => void start()} disabled={!canStart(sender.state.status)}>
          <MonitorUp aria-hidden />共有開始
        </Button>
      )}
      {active && <p className="text-sm text-muted-foreground">共有中はこのブラウザを最小化しても送信を続けます。登壇者の交代は共有をやり直さず、スライドを切り替えるだけで構いません。</p>}
      <ShareGuide />
    </SenderShell>
  );
}
