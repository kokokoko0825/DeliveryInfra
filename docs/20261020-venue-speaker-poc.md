# 会場スピーカー WebRTC PoC

## 目的と方式

既存の配信経路を維持したまま、マイク端末からスピーカー端末へ会場内 LAN で PCM 音声を直接送る 1:1 の試験経路を追加した。`/venue/mic` と `/venue/speaker` は音声担当・管理者だけが開ける。DataChannel は `ordered: false`、`maxRetransmits: 0`、音声は AudioWorklet で 48 kHz モノラルの 10 ms ごとの PCM16 に変換・再生する。

シグナリングは既存 API の `/api/venue-speaker/{mic,speaker}` を使い、SDP offer/answer を既存の DynamoDB テーブルに最大90秒保存する。AWS 音声中継、新規 AWS リソース、STUN/TURN は使わない。ICE サーバーは空配列で、候補交換は SDP の ICE gathering 完了後に行う。

既存の `/send/mic` には「会場スピーカーにも送信」スイッチを追加した。有効にすると既に取得した同じ MediaStream を IVS と DataChannel の両方に入力する。PoC の `/venue/mic` は IVS 接続なしで単独試験できる。

## 使い方

1. マイク端末で `/venue/mic` を開き、「接続開始」を押す。
2. 同じ Wi-Fi またはテザリング上のスピーカー端末で `/venue/speaker` を開き、「受信開始」を押す。
3. スピーカー画面の接続状態と RTT を確認し、実際のマイク入力からスピーカー出力までの遅延を別途録音して測る。

既存の IVS マイク送信と併用する場合は `/send/mic` で両方を有効にする。既存経路の音声取得設定は配信動作を維持するため従来どおりであり、PoC 専用ページではエコーキャンセル・ノイズ抑制・自動音量調整を無効にしている。

## 技術上の制約

- 表示する RTT は DataChannel の ping/pong によるネットワーク往復時間で、片道音声遅延や音声入出力遅延を示さない。50 ms 目標は録音波形で別途測定する必要がある。
- LAN 内で直接 ICE 接続できることが前提。ゲスト Wi-Fi の端末分離、異なるサブネット、NAT/ファイアウォールが直接候補を遮断する場合は接続できない。STUN/TURN は意図的に設定していない。
- シグナリングは音声担当ロールの利用者間で共有される単一の試験枠で、同時に複数組を使う設計ではない。SDP は短命ですが、同ロールの利用者は取得できます。
- DataChannel の混雑時は送信側でバッファが64 KB未満のときだけ音声を送る。ブラウザ・OS・端末の AudioWorklet スケジューリングや再生待ち時間は異なるため、50 ms 以下を保証しない。

## インフラ確認

`delivery-stack.ts` の既存 DynamoDB テーブルはオンデマンド課金、AWS 管理キー暗号化、TTL 属性 `ttl` を持つ。既存 API Lambda は同テーブルへの読み書き権限を持つため、シグナリング保存に IaC 変更は不要。TTL 削除は即時ではないため、API 読み出し側でも期限を検証し、期限切れレコードを返さない。

## ロールバック

追加ルートを `apps/web/src/router.tsx` から削除し、`AppLayout.tsx` の2つの PoC メニュー項目と `MicSendPage.tsx` の会場送信スイッチを削除する。API の `venue-speaker` ルート、共有スキーマ、権限フラグ、`features/venue` を取り除けば PoC は完全に無効化できる。既存の配信経路と DynamoDB/IaC 構成に移行やデータ変換は発生しない。
