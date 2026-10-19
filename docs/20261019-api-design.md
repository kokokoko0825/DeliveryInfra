# API・DynamoDB設計

作成日: 2026-10-19

## DynamoDB 単一テーブル

オンデマンド課金の単一テーブルを使用し、キーは `PK` / `SK` (String)、TTL 属性は `ttl` (Unix秒) とする。**GSI は使わない**。一覧はすべて固定 PK の `Query` で読み、`Scan` は使わない（Review-1 R1-10）。

| データ | PK | SK | 主な属性 |
| --- | --- | --- | --- |
| プロフィール | `USER#<sub>` | `PROFILE` | `displayName`, `commentSuspended`, `updatedAt` |
| 最終ログイン | `USER#<sub>` | `LOGIN` | `lastLoginAt`, `loginMethod` |
| トークン失効 | `USER#<sub>` | `AUTH` | `tokenValidAfter`（Unix秒。`iat <= tokenValidAfter` の access token は 401 `TOKEN_REFRESH_REQUIRED`） |
| 連投制限 | `USER#<sub>` | `CHAT_RATE` | `lastSentAt`, `ttl` (短期) |
| 配信 | `BROADCAST` | `CURRENT` | `id`, `title`, `status`, `startedAt`, `endedAt`, `compositionArn`, `outputPrefix` |
| Composition対応 | `COMPOSITION#<arn>` | `META` | `broadcastId`, `title`, `startedAt`, `outputPrefix` |
| 送信端末枠 | `DEVICE` | `<purpose>#<slot>` | `deviceId`, `userId`, `purpose`, `deviceName`, `participantId`, `stageArn`, `ttl` |
| スライド | `SLIDE` | `<id>` | `title`, `fileName`, `key`, `size`, `order`, `published` |
| NGワード | `NGWORD` | `<word>` | `word`, `createdAt` |
| コメント本体 | `COMMENT` | `<sentAt>#<messageId>` | `messageId`, `userId`, `displayName`, `comment`, `sentAt`, `deleted`, `ttl` (1年) |
| コメント参照 | `COMMENT#<messageId>` | `REF` | `commentSk`, `ttl` (1年) |
| アーカイブ | `ARCHIVE` | `<id>` | `broadcastId`, `title`, `recordingPrefix`, `durationSeconds`, `published`, `createdAt`, `retainUntil`, `ttl` |

アクセスパターン（例）:

- NG ワード: `Query PK=NGWORD`（審査 Lambda は `ConsistentRead`）。
- 端末一覧: `Query PK=DEVICE`。用途ごとの空き確認は `Query PK=DEVICE AND begins_with(SK, "camera#")`。
- 端末のハートビート/解放: `deviceId` は `<purpose>.<slot>.<uuid>`（例 `camera.3.0b6c…`）。`GetItem PK=DEVICE, SK=camera#3` で引き、`deviceId` 一致を条件に更新/削除する。
- 直近コメント: `Query PK=COMMENT ScanIndexForward=false Limit=100 Filter deleted<>true`（100件に達するまでページング）。CSV は同じ PK を昇順に全件。
- コメント削除: `GetItem COMMENT#<messageId>/REF` で `commentSk` を得て、本体 `COMMENT/<commentSk>` に `deleted=true`。審査 Lambda は本体と参照行を `TransactWriteItems` で同時に書く。
- ユーザー一覧: `ListUsers` + `ListUsersInGroup`×5（ロール）+ `BatchGetItem`（PROFILE/LOGIN、100キーずつ、UnprocessedKeys は再試行）。

`recordingPrefix` 属性は**アーカイブ行だけ**が持つ（Infra の Stream フィルタ条件）。配信・Composition 行では同じ値を `outputPrefix` として持つ。

端末枠は種類ごとの固定スロットを条件付き `PutItem`（`ReturnValues: ALL_OLD`）で取得する。条件は `attribute_not_exists(PK) OR ttl <= 現在時刻`。同じ枠を同時取得できないため上限を超えない。期限は45秒で、送信中は15秒間隔のハートビートで延長する。失効した枠を再利用するときは、旧枠の `participantId` を `DisconnectParticipant` で切断してから使う（R1-07。`ResourceNotFoundException` は切断済みとして扱い、それ以外の失敗は取得を取り消す）。camera/mic で稼働中の同名端末があれば、他人なら 409 `DEVICE_NAME_IN_USE`、本人なら再接続としてその枠を置き換える（R1-18）。switcher は枠を使わない（R1-02）。

IVS Composition の録画先 prefix は `StartComposition` 応答から `outputPrefix` として保存し、EventBridge の `Session End` / `Session Failure` でアーカイブ行の `recordingPrefix` に記録する。HLS は `RECORDING_BUCKET` 内の `<recordingPrefix>/media/hls/multivariant.m3u8` にあり、視聴パスは `/files/archives/<recordingPrefix>/media/hls/multivariant.m3u8`。同じイベントで `BROADCAST/CURRENT` の `compositionArn` が一致し `live` なら `ended` にして `broadcast-ended` を送る（R1-03）。スライドはコンテンツバケットの `slides/<id>.pdf` に保存し、配信パスは `/files/slides/<id>.pdf`。

### アーカイブの保存期限（R1-22）

- 作成時に `retainUntil = 作成時刻 + 365日`、`ttl = retainUntil の Unix秒`。`PATCH /api/archives/{id}` の `retainUntil`（現在より後のみ）で両方を更新する。
- 期限到来後〜TTL 削除までの間も、一覧・Cookie 発行では `retainUntil <= 現在` を除外する。
- DynamoDB TTL で行が消えると Stream の REMOVE を `archive-expiry` 関数が受け、`recordingPrefix/` 配下を全削除する（冪等。API の DELETE と重なっても問題ない）。失敗時は `batchItemFailures[{itemIdentifier: SequenceNumber}]` を返して再試行させる。

Infra 配線（Fix-Infra と合意済み）:

| 項目 | 値 |
| --- | --- |
| 関数 | `dist/archive-expiry/index.mjs`（`handler`）。env は `NODE_ENV`, `RECORDING_BUCKET` |
| テーブル | Stream 有効（`OLD_IMAGE` 以上） |
| イベントソース | DynamoDB Stream、`ReportBatchItemFailures` 有効、フィルタ: `eventName=REMOVE` かつ `userIdentity.principalId=dynamodb.amazonaws.com`（TTL 削除）かつ `dynamodb.OldImage.recordingPrefix.S` が存在 |
| IAM | 録画バケットに `s3:ListBucket`（バケット）と `s3:DeleteObject`（オブジェクト） |

API 側で新たに必要な権限: `api` に `ivs:DisconnectParticipant`・`ivs:ListStageSessions`（ステージ）、`cognito-idp:AdminGetUser`・`ListUsersInGroup`、`dynamodb:BatchGetItem`/`Query`（`grantReadWriteData` に含まれる）。`recording` に `ivs:GetComposition` と `dynamodb:UpdateItem`。`chat-review` の `TransactWriteItems` は各 `PutItem` 権限で評価される。

## Lambda 環境変数

秘密鍵そのものは環境変数に置かず、CloudFront 秘密鍵を SSM SecureString から読み込んで55分キャッシュする。`AWS_REGION` は Lambda ランタイムが設定する。必須値は各関数のスキーマで検証する。

| 関数 | 環境変数 |
| --- | --- |
| `api` | `NODE_ENV`, `USER_POOL_ID`, `USER_POOL_CLIENT_ID`, `TABLE_NAME`, `STAGE_PRODUCTION_ARN`, `STAGE_SLIDE_ARN`, `STAGE_BROADCAST_ARN`, `CHAT_ROOM_ARN`, `CONTENT_BUCKET`, `RECORDING_BUCKET`, `RECORDING_STORAGE_CONFIGURATION_ARN`, `ENCODER_CONFIGURATION_ARN`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY_PARAMETER`（`CLOUDFRONT_KEY_GROUP_ID` は未使用のため削除、R1-25） |
| `chat-review` | `NODE_ENV`, `TABLE_NAME` |
| `recording` | `NODE_ENV`, `TABLE_NAME`, `RECORDING_BUCKET`, `CHAT_ROOM_ARN`, `STAGE_BROADCAST_ARN` |
| `cognito-trigger` | `NODE_ENV`, `TABLE_NAME` |
| `archive-expiry` | `NODE_ENV`, `RECORDING_BUCKET` |

API の署名Cookie発行は CloudFront Function が設定する `x-forwarded-host` を使う。値は `^[a-z0-9]+\.cloudfront\.net$` のみ許可し、違反は構造化ログを記録して内部エラーとして拒否する。Cookie は**カスタムポリシー**（`Resource` ワイルドカード + `DateLessThan`、有効1時間）で署名し、`CloudFront-Policy` / `CloudFront-Signature` / `CloudFront-Key-Pair-Id` を `Path=<範囲>; Max-Age=3600; Secure; HttpOnly; SameSite=Strict` で返す（canned policy はワイルドカード不可のため使わない。INT-01）。

| API | Resource | Cookie Path | 発行条件 |
| --- | --- | --- | --- |
| `POST /api/files/cookies` | `https://<host>/files/slides/*` | `/files/slides/` | ログイン済み |
| `POST /api/archives/{id}/cookies` | `https://<host>/files/archives/<recordingPrefix>/*` | `/files/archives/<recordingPrefix>/` | 公開中、または admin。非公開・期限切れ・存在しない場合は 404（R1-08） |

## Lambda 関数・認証

`pnpm --filter api build` は Node.js 22 / ESM で `dist/api/index.mjs`, `dist/chat-review/index.mjs`, `dist/recording/index.mjs`, `dist/cognito-trigger/index.mjs`, `dist/archive-expiry/index.mjs` を生成する。各ファイルは `handler` をexportする。

API Function URL は CloudFront OAC 経由で呼び、`X-Auth-Token` を Cognito access token として検証する（Verifier はモジュールで1つを使い回す、R1-23）。access token には `email`・`identities` が無いため、`GET /api/me` は `AdminGetUser`（token の `username`）で email とログイン方式を取得する（R1-01）。ロール変更・無効化・削除では `AdminUserGlobalSignOut`（削除時を除く）と `USER#<sub>/AUTH.tokenValidAfter` の保存を行い、それ以前に発行された access token を拒否する（R1-09）。自分自身のロール変更・無効化・削除は 400 `CANNOT_MODIFY_SELF`（R1-19）。Cognito groupが有効なロール1つなら許可し、未所属なら `401 TOKEN_REFRESH_REQUIRED`、複数または不正なロールなら `403 INVALID_ROLE`。入力と成功レスポンスを `packages/shared` のZodスキーマで検証し、管理操作は構造化監査ログを出力する。APIエラー形式は `{ "error": { "code": string, "message": string } }`。

Cognitoトリガーは `PostConfirmation_ConfirmSignUp` で外部IdPユーザーに `viewer` を付与して最終ログイン時刻も記録し（初回ログインは PostAuthentication が走らないため、R1-20）、`PostAuthentication_Authentication` で最終ログイン時刻を記録する。同一Lambda内で `triggerSource` を分岐する。

## AWS API仕様確認

- IVS Real-Time の `CreateParticipantToken` は短いdurationと必要なcapabilityを指定する。`ListParticipants` は `stageArn` と `sessionId` を使い、現在の配信セッションの視聴者数を数える。
- IVS `StartComposition` のS3 destinationに StorageConfiguration ARN、EncoderConfiguration ARN、HLS `targetSegmentDurationSeconds: 10` を渡す。終了イベントは `IVS Composition State Change / Session End`。GetCompositionのS3 `recordingPrefix` に沿ってHLSプレイリストを参照する。
- S3 presigned POST は `content-length-range` と `Content-Type` を固定する。完了APIは `HeadObject` と `GetObject Range: bytes=0-4` でサイズと `%PDF-` を検査する。
- IVS Chat message review Lambda は `Content`, `ReviewResult`, `Attributes` を返す。拒否理由は `Attributes.Reason` に入れる。許可時はクライアント指定の属性を捨て、`Attributes.displayName` を保存済みの表示名で上書きする（R1-04）。
- `StopComposition` は Composition が自動停止・削除済みだと `ResourceNotFoundException` を返す。この場合は停止済みとして `ended` に進める（R1-03）。
- `DisconnectParticipant` は `stageArn` と `participantId`（`CreateParticipantToken` 応答）で切断する。
- DynamoDB Streams の TTL 削除レコードは `userIdentity.type=Service`, `principalId=dynamodb.amazonaws.com`。Lambda の部分失敗応答の `itemIdentifier` は `SequenceNumber`。
- CloudFront 署名付き Cookie でワイルドカード Resource を使うにはカスタムポリシーが必要。
- 外部IdPの初回ユーザー作成で `PostConfirmation_ConfirmSignUp` が実行されるため、ここでviewerグループを割り当てる。以降のログインは `PostAuthentication_Authentication` で最終ログインを記録する。

## Mutation test result (2026-10-19)

`pnpm --filter api mutation` was run with the configured break threshold of 80. It failed at **17.61%** (206 killed, 289 survived, 675 not covered, 446 errors among 1,616 mutants). The largest gap is route coverage: current `router.test.ts` focuses on authentication, role rejection, display-name/PDF boundaries, and device limits; other endpoint branches are not exercised by the suite and therefore generate many no-coverage mutants. Surviving mutants also include user-visible error-message string substitutions, which the current tests assert by error code rather than exact Japanese wording, and token response mutations not asserted by current tests. The API behavior is implemented, but mutation acceptance remains incomplete and needs expanded endpoint tests plus assertions for the surviving behavior.
