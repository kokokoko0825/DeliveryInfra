# 異常系ログと診断情報の改善

## 目的

障害が起きた際に、画面のエラーだけでは原因を特定できず、特に別キャリア間のVenue WebRTC接続で「相手を検出したが接続できない」状態の切り分けが難しかった。端末・API双方で障害の段階と相関情報を残し、利用者から診断ログを受け取れるようにする。

## 実装内容

- ブラウザーで未処理例外、未処理Promise rejection、API通信失敗（4xxを含む）、認証初期化、端末メディア取得、IVS再接続、チャット、アーカイブ再生、Venue WebRTCの失敗を記録する。利用者入力の誤りなど4xxはブラウザーの警告ログに記録し、API側では5xxと補償失敗をエラーログに記録する。
- ブラウザーの診断ログは最大100件を端末内に保存し、直近30秒の同一エラーを集約する。JWT/Bearer token、認証情報、署名付きURLのクエリ、メールアドレス、ローカルホームディレクトリをマスクする。保存領域が使えない場合も、ページを開いている間はメモリ上に診断を保持する。
- アプリのサイドバーからJSONログを書き出せる。画面描画エラー時にも書き出しと再読み込みを提供する。
- Venue WebRTCではoffer/answer、ICE gathering、ICE候補、connection state、一定時間`new`のままの状態、参加者探索、リース更新、DataChannel送信失敗を記録する。バッファ輻輳による破棄と実送信例外は別に記録する。画面と計測CSVにはconnection/ICE/SDP状態を出力する。
- APIの全レスポンスに`x-request-id`ヘッダーを付け、エラー応答本文にもIDを含める。サーバーログは構造化し、例外の生メッセージやstackは出さず、安全なエラー名・コード・AWSリクエストIDを残す。ブラウザー側のAPI診断にも同IDを含める。
- Cognito JWT検証では無効トークンを401、JWKSなど検証基盤の障害を500として扱う。
- スピーカー端末の案内には、iPhone/iPadの消音モードを解除し、音量ボタンで音量を調整することを表示する。

## 運用例

スピーカー画面に`ICE: checking / SDP: have-local-offer`と表示され続ける場合、サイドバーの「診断ログを保存」でJSONを取得する。`venue.peer`の`phase`、`iceConnectionState`、`signalingState`とAPIリクエストIDを確認し、端末側ICE到達性とシグナリング応答を分けて調べる。

## テストとミューテーションの実行方針

- ローカルの `pnpm mutation` は、base branchとの差分から変更された本番ソースの行だけを変異対象にする。テスト・ドキュメントだけの変更ではミューテーションをスキップする。
- `pnpm mutation:all` は全パッケージの本番コードを対象にし、パッケージ間は逐次実行する。PR作成時とmainへのpush後のデプロイ前に、GitHub Actionsがこの全件実行に加えて `pnpm test`、`pnpm typecheck`、`pnpm lint` を行う。
- どちらも既定の80%閾値を維持し、ローカルでは変更行の回帰を短時間で確認し、PRとデプロイ時には全体の回帰を確認する。

## 検証

- 最終変更後に `pnpm test` が成功。Web 54ファイル・500テスト、Infra 136テスト、shared 33テスト、integration 50テストを含む。APIのルーター回帰テストも含め全workspaceのテストが成功。
- 最終変更後に `pnpm typecheck`、`pnpm lint`、Web production build、API build が成功。
- 変更箇所に絞った mutation test はすべて閾値80%を通過: API `auth.ts` 82.46%、API router の新規診断・補償ログ範囲 89.55%、Web `auth.ts` 84.67%、Web `diagnostics.ts` 83.61%。
- 追加したAPIの異常系・境界値テストを含め `pnpm --filter api mutation` を再実行し、API全体で80.20%となり閾値80%を通過した。内訳はauth.ts 82.76%、router.ts 79.46%、errors.ts/storage.ts 100%。ルーター単独では閾値未満だが、パッケージ全体の設定閾値を満たしている。
- Infra 88.11%、shared 95.74%、Web core 89.81%、Web media 93.10% も各パッケージの前回mutation実行で閾値を通過した。これらの実装ファイルは今回変更していない。API追加テスト後にルートの `pnpm mutation` は再実行していない。
- API router のエラーログから `requestId` を外す一時 mutation では、相関IDを検証するテストが失敗することを確認し、実装を戻した後に同テストが通ることを確認した。
- CodexのOrcaレビューで出たCognitoの`UserNotConfirmedException`と`PasswordResetRequiredException`の分類漏れを修正し、失敗分類テストを追加した。最終レビューで通常404本文の相関ID欠落が見つかり修正し、再レビューでは追加指摘なし。
- リポジトリ内に `CLAUDE.md` / `Claude.md` はなかったため、`AGENTS.md` とレビュー結果に従った。
