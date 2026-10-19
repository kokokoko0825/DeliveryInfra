# 結合テスト（Wave2）実装メモ

対象: `tests/integration`（pnpm workspace パッケージ `integration-tests`）、`infra/src/app-config.ts` の `HANDLER_DIRS`。
前提にした契約: `plan/20261019-online-delivery.md` 5章、`docs/20261019-api-design.md`、`docs/reviews/20261019-review-1-triage.md`（修正後の振る舞い）。

## 1. 実行方法

```sh
pnpm test:integration          # = pnpm --filter integration-tests test（先に pnpm --filter api build を実行）
INTEGRATION_DEBUG=1 pnpm test:integration   # 4xx/5xx の API 応答と API の console.error を表示
```

`pnpm -r test` にも含まれる。Stryker は対象外。

## 2. 構成

| ファイル | 内容 |
| --- | --- |
| `test/api-flow.test.ts` | apps/api の実ハンドラ（`index.ts` / `chat-review.ts` / `recording.ts` / `cognito.ts`）を Lambda 関数URL イベント（ペイロード 2.0）で in-process 実行する通しシナリオ（17件） |
| `test/web-contract.test.ts` | apps/web の API 呼び出し関数 → fetch アダプタ → API ハンドラ。応答の shared スキーマ検証と `x-amz-content-sha256` の一致（4件） |
| `test/infra-api.test.ts` | infra の `buildApp` をテスト内の `App` で synth し、API のビルド出力・env スキーマ・CloudFront・Chat・EventBridge・Cognito・Stream・IAM と突き合わせる（22件） |
| `test/support/fake-dynamodb.ts` | 単一テーブルのインメモリ DynamoDB |
| `test/support/fake-aws.ts` | Cognito / IVS Real-Time / IVS Chat / S3 / SSM のフェイクと aws-sdk-client-mock の配線 |
| `test/support/lambda.ts` | 関数URL イベントの生成と JSON 呼び出しヘルパー |
| `test/support/fake-clock.ts` | `Date` だけを偽装（API は `Date.now` をハンドラ生成時に捕捉するので、ハンドラより先に import する） |
| `test/stubs/amazon-ivs-web-broadcast.ts` | ブラウザ専用 WebRTC SDK のスタブ（読み込み時に `window` を参照するため。HTTP 契約の対象外） |

### フェイクの忠実度（テストが「通ってしまう」のを防ぐ工夫）

- **認証**: Cognito アクセストークンを RS256 で実際に署名し、API の `aws-jwt-verify` で本物の検証（署名・iss・client_id・token_use・exp）を通す。差し替えは JWKS の HTTPS 取得だけ。クレームは実物と同じで `email`・`identities` を含まず、グループ未所属なら `cognito:groups` 自体が無い。
  - 例: `accessToken(user, { clientId: 'other-client' })` → `401 UNAUTHORIZED`、グループ無し → `401 TOKEN_REFRESH_REQUIRED`。
- **DynamoDB**: 条件付き書き込みは `ConditionalCheckFailedException`。式は静的に検証し、未使用・未定義の `#name` / `:value` や予約語（`status`, `order`, `ttl` など）の直書きは `ValidationException`。Scan / Query は 10 件ごとにページングし、フィルタはページ取得後に適用。`ReturnValues`、`BatchGet` / `BatchWrite` / `TransactWrite`、GSI（スパース・強い整合性読み込み不可）に対応。
  - 例: `SET status = :s` → ValidationException（`#status` が必要）。
- **S3 presigned POST**: `createPresignedPost` の本物の出力を使い、ポリシー（bucket・key・`Content-Type`・`content-length-range`・期限）を満たさないアップロードは拒否。
  - 例: 50MB+1 バイトの本文 → 400、`image/png` → 403。
- **署名付き Cookie**: SSM の秘密鍵（テストで生成）で署名を検証し、ポリシーの Resource と Cookie Path を確認。
- **Web アダプタ**: 変更系リクエストで `x-amz-content-sha256` が本文の SHA-256 と違えば OAC と同じく 403。

## 3. 検証しているシナリオ

| 区分 | 主な検証 |
| --- | --- |
| ユーザー・送信枠 | 招待（部分成功）→ ログイン記録 → ロール変更（旧トークン失効）→ camera 6台成功・7台目 409 `DEVICE_LIMIT` → 他人の端末は解放 403・延長 404 → 稼働中の同名 409 `DEVICE_NAME_IN_USE` → 解放後に再取得 → ハートビートしない枠は45秒で失効し、IVS から切断して再利用。Okta 初回サインイン、switcher は枠なし、IVS 失敗時の枠ロールバック |
| スライド | upload-url → presigned POST → complete（`%PDF-` 以外・サイズ不一致は 400）→ 表示順 → 並べ替え → 改名 → 削除（S3 も削除）→ 存在しない ID は 404 → `/files/slides/*` の Cookie |
| 配信・アーカイブ | start（二重開始 409）→ 視聴者55人の stats（ページング・PUBLISH は除外）→ stop → recording イベント（Session Start は無視、重複は冪等）→ 非公開登録（retainUntil +365日）→ 非公開の Cookie は拒否 → 公開 → 視聴者の一覧 → アーカイブ毎 Cookie → 削除（prefix 全削除）。合成の自動終了後の stop と Session End による ended |
| コメント | NG ワード（表示名・本文）、3秒連投、200文字超・空白のみ、表示名の詐称を審査で上書き、停止ユーザー（切断・審査拒否・送信権限なし）、直近100件（新しい順・削除除外）、CSV（BOM・削除済み含む・数式インジェクション対策） |
| 認可・入力 | camera/audio/presenter/viewer で管理 API 24本がすべて 403 かつ副作用なし、用途別トークンのロール、自分自身の降格・無効化・削除の拒否、401/403 の6パターン、400 の15パターン |
| Web 契約 | 管理者・送信者・視聴者が使う呼び出し（`fetchMe`, `inviteUsers`, `uploadSlide`, `startBroadcast`, `fetchViewerToken` など）が shared スキーマを通る。全リクエストに `X-Auth-Token`、変更系 20 件超で SHA-256 一致。エラーは `ApiError(status, code)` で届く |
| Infra 契約 | `apps/api/scripts/build.mjs` の全出力がそれぞれ1つの Lambda にデプロイされる（アセットの `index.mjs` をビルド出力と内容比較）、`handler` export・nodejs22.x・arm64、環境変数がハンドラ別 env スキーマを満たし余分なキーが無い、`/api/*` が AllViewerExceptHostHeader + CachingDisabled + OAC(lambda, always) で `x-forwarded-host` を Host で上書きしつつ `X-Auth-Token`・`x-amz-content-sha256` を残す、Chat Room の審査は chat-review（DENY フォールバック）、EventBridge は recording、Cognito トリガーは cognito-trigger、Stream は archive-expiry、GSI 定義の一致、各ハンドラが実際に呼ぶ SDK コマンドを実行ロールが許可 |

IAM の検証では、ハンドラのソースを esbuild（apps/api と同じもの）で SDK を external にしてバンドルし、ツリーシェイク後に残る `new XxxCommand(` を IAM アクションにする（例: `HeadObjectCommand` → `s3:GetObject`、`createPresignedPost` → `s3:PutObject`）。import だけで判断すると `KEYS` しか使わないハンドラにも database.ts の全コマンドが数えられて誤検知になるため。

## 4. 不整合の一覧

### 修正した不整合（この作業で修正）

| ID | 内容 | 修正したパッケージ / ファイル |
| --- | --- | --- |
| INT-00 | apps/api の build は `dist/{api,chat-review,recording,cognito-trigger}/index.mjs` を出力するが、infra の `HANDLER_DIRS` は `{index,chat-review,recording,cognito}` を参照していた。デプロイすると api と cognito が「apps/api is not built」スタブになる | infra: `infra/src/app-config.ts`（`api: 'api'`, `cognito: 'cognito-trigger'`）、`infra/test/app-config.test.ts`、`infra/test/stacks.test.ts`（フィクスチャのディレクトリ名）、`docs/20261019-infra.md`（dist 列） |

apps/api・apps/web のプロダクションコードは coordinator の指示（Review-1 修正と並行のため触らない）に従い変更していない。

### 検出して引き渡した不整合

| ID | 内容 | 引き渡し先 | 状態（HEAD `b206caf` 時点） |
| --- | --- | --- | --- |
| INT-01 | `getSignedCookies` を `url` + `dateLessThan` だけで呼んでいたため既定ポリシー（`CloudFront-Expires`）になり、Resource のワイルドカード `/files/*` が効かない（既定ポリシーの Cookie は1オブジェクト専用）→ 全ファイルが 403 | Fix-API（coordinator 経由） | 修正済み（`641e3ce`）。カスタムポリシーの Cookie であること・Resource・Path・署名を結合テストで検証し通過 |
| INT-02 | Fix-API の作業途中の版が GSI1（`GSI1PK`/`GSI1SK`）で Query していたが、infra のテーブルに GSI が無かった | Fix-Infra（coordinator 経由） | 解消。コミット版（`641e3ce`）の API は GSI を使わない設計に変更された。今後どちらかが変わったら `TABLE_INDEXES` と infra の不一致としてテストが失敗する |

### Review-1 の指摘を結合テストで確認したもの

R1-01（/me の email）、R1-02（switcher 枠なし）、R1-03（自動終了後の stop / Session End）、R1-04（表示名の上書き）、R1-06（/api/status と IAM）、R1-07（失効端末の切断）、R1-08（Cookie 分割）、R1-09（ロール変更でトークン失効）、R1-11（招待の部分成功）、R1-14（404）、R1-15（CSV の列）、R1-16（空白コメント）、R1-18（同名端末）、R1-19（自分自身の操作）、R1-20（Okta 初回ログイン記録）、R1-21（recording の IAM）、R1-22（retainUntil・archive-expiry の配線）。いずれも HEAD で通過。

## 5. 環境メモ（サンドボックス）

- サンドボックスから pnpm のグローバルストア（`~/Library/pnpm/store/v11`）に書けないため、`pnpm install --lockfile-only --offline` でロックファイルの importer だけを追加し、`tests/integration/node_modules` には pnpm と同じ配置（`node_modules/.pnpm/...` へのシンボリックリンク）を手で作った。新しいパッケージは無く、既存と同じバージョンだけを使う（AWS SDK は API と同一インスタンスでないと aws-sdk-client-mock が効かないため完全一致で固定）。通常の環境で `pnpm install` を実行すれば同じ内容が作り直される。
- esbuild はこのパッケージの依存にせず、`createRequire(apps/api/package.json)` で apps/api と同じものを読む（依存を足すと pnpm の実行前チェックがサンドボックス内で install を試みて全スクリプトが失敗するため。結果としてビルドと同じ esbuild を使う利点もある）。
