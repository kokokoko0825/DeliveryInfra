# 会場音声 PoC 実装内容と確認結果

## 変更内容

- APIにPoCルームの参加者登録・一覧・退出・期限更新と、マイク/スピーカー間のoffer/answerシグナリングを追加した。音声はサーバーで中継せず、WebRTCで端末間を直接接続する。
- 最大3マイク・5スピーカーの参加枠を設け、各マイク音声を全スピーカーへ送る。PCM DataChannel方式とWebRTC音声トラック方式を画面で選択できる。
- PCM受信では最大3マイクを合成し、キュー状態・欠落・underflow/overflow・ピークを記録する。
- `/send/mic` に会場音声への送信切替を追加した。配信用に開いたマイクの同じ `MediaStream` をIVS送信と会場音声の両方に渡す。
- PoC画面では接続スロット、接続状態、方式、毎秒のヘルスサンプルを記録する。ログはブラウザのIndexedDBに端末内保存し、CSVまたはJSON manifestとしてダウンロードできる。
- マイクページに明示操作の音響録音を追加した。録音はブラウザが対応するWebM/OpusまたはMP4で端末へダウンロードされ、AWSには送信しない。
- 計画書を修正し、初回PoCの比較方式をPCMと音声トラックに限定した。WebCodecs Opusと録音波形からの音響遅延自動算出は未実装として明記した。

## 確認結果

- `pnpm test`: 成功。Web 52ファイル/467件、共有パッケージ33件、インフラ136件、APIテストと統合テストを含むワークスペース全体。
- `pnpm typecheck`: 成功。
- `pnpm lint`: 成功。
- `pnpm --filter web build`: 成功。Viteは既存の500 kB超chunk警告を出したが、buildは正常終了。
- 会場音声の対象テスト13件: 成功。
- ミューテーション確認: ICE serverを追加する変異とPCM受信上限を2ストリームにする変異の両方を対象テストが検出し、変異を戻した後のテストが成功。復元後のファイルハッシュは変異前のバックアップと一致。
- `git diff --check`: 成功。

## 実機確認前の制約

- 実機での接続、音の出力、音響遅延、音質、iOSで画面を閉じた場合の挙動は未確認。コードテストを通過したことは実機の音響品質を保証しない。
- RTT・パケット欠落・バッファ統計は通信診断用で、マイク入力からスピーカー出力までの遅延ではない。音響録音ファイルからの自動解析は未実装。
- 1対1、1対3、2対2、3対1など、手持ちのiPhone 2台・iPad 1台・MacBook 1台で実機確認する。iPhone/iPadのChromeはWebKitで動作する。Android Chrome実機は対象外。
- stgへのデプロイとデプロイURLでの画面・ログイン確認は、GitHub `main` へのpush後に行う。
- 動作確認ユーザーはstg Cognitoに作成済み。初回サインイン時に仮パスワードの変更が必要。認証情報はこのリポジトリに含めない。

## 関連ファイル

- `plan/20261021-VenueAudioPoc.md`
- `apps/api/src/router.ts` と `apps/api/src/router.test.ts`
- `apps/web/src/features/venue/`
- `apps/web/src/features/sender/MicSendPage.tsx`
