# 会場音声PoCのSTUNのみ接続

## 変更

- WebRTCの `RTCPeerConnection` に `stun:stun.l.google.com:19302` を設定し、外向きのICE候補を使った直接接続を試す。
- TURNサーバーは設定しない。STUN候補で接続できない場合、これまで通り `WebRTC 接続に失敗しました` を表示する。
- DataChannel PCMとWebRTC音声トラックの両方式で同じICE設定を使う。
- 要件F-VEN-05をSTUNのみの直接接続に更新した。

## 理由

PoCを別キャリア回線間でも試せるようにするため。STUNは接続候補を増やすだけで、音声は端末間の直接経路を使う。キャリアのNATなどにより直接接続できない組み合わせでは失敗する。

## 検証

`venueAudio.test.ts` で両方式のSTUN設定、TURNを使わないこと、既存接続失敗エラーを検証する。実機の別キャリア間接続は別途確認が必要。
