# API・DynamoDB設計

作成日: 2026-10-19

## DynamoDB 単一テーブル

オンデマンド課金の単一テーブルを使用し、キーは `PK` / `SK` (String)、TTL 属性は `ttl` (Unix秒) とする。GSI は使わない。プロフィール、ユーザー一覧、NGワード、コメント、端末一覧は Scan で取得する。

| データ | PK | SK | 主な属性 |
| --- | --- | --- | --- |
| プロフィール | `USER#<sub>` | `PROFILE` | `displayName`, `commentSuspended`, `updatedAt` |
| 最終ログイン | `USER#<sub>` | `LOGIN` | `lastLoginAt`, `loginMethod` |
| 配信 | `BROADCAST` | `CURRENT` | `id`, `title`, `status`, `startedAt`, `endedAt`, `compositionArn`, `recordingPrefix` |
| Composition対応 | `COMPOSITION#<arn>` | `META` | `broadcastId`, `title`, `startedAt`, `recordingPrefix` |
| 送信端末枠 | `DEVICE#<purpose>#<slot>` | `LEASE` | `deviceId`, `userId`, `purpose`, `deviceName`, `ttl` |
| スライド | `SLIDE#<id>` | `ITEM` | `title`, `fileName`, `key`, `size`, `order`, `published` |
| NGワード | `NGWORD#<id>` | `ITEM` | `word`, `createdAt` |
| コメント | `COMMENT#<messageId>` | `ITEM` | `userId`, `displayName`, `comment`, `sentAt`, `deleted`, `ttl` (1年) |
| 連投制限 | `USER#<sub>` | `CHAT_RATE` | `lastSentAt`, `ttl` (短期) |
| アーカイブ | `ARCHIVE#<id>` | `ITEM` | `broadcastId`, `title`, `s3Prefix`, `s3Path`, `durationSeconds`, `published` |

端末枠は種類ごとの固定スロットを条件付き `PutItem` で取得する。条件は `attribute_not_exists(PK) OR ttl < 現在時刻`。同じ枠を同時取得できないため上限を超えない。期限は45秒で、送信中は別処理で15秒間隔に更新する想定。

IVS Composition の `recordingPrefix` は `StartComposition` 応答から保存し、EventBridge の終了イベント時にアーカイブ行へそのまま記録する。HLS は `RECORDING_BUCKET` 内の `<recordingPrefix>/media/hls/multivariant.m3u8` にあり、視聴パスは `/files/archives/<recordingPrefix>/media/hls/multivariant.m3u8`。アーカイブ削除時に対象 prefix を削除する。スライドはコンテンツバケットの `slides/<id>.pdf` に保存し、配信パスは `/files/slides/<id>.pdf`。

## Lambda 環境変数

秘密鍵そのものは環境変数に置かず、CloudFront 秘密鍵を SSM SecureString から読み込んで55分キャッシュする。`AWS_REGION` は Lambda ランタイムが設定する。必須値は各関数のスキーマで検証する。

| 関数 | 環境変数 |
| --- | --- |
| `api` | `NODE_ENV`, `USER_POOL_ID`, `USER_POOL_CLIENT_ID`, `TABLE_NAME`, `STAGE_PRODUCTION_ARN`, `STAGE_SLIDE_ARN`, `STAGE_BROADCAST_ARN`, `CHAT_ROOM_ARN`, `CONTENT_BUCKET`, `RECORDING_BUCKET`, `RECORDING_STORAGE_CONFIGURATION_ARN`, `ENCODER_CONFIGURATION_ARN`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY_PARAMETER`, `CLOUDFRONT_KEY_GROUP_ID` |
| `chat-review` | `NODE_ENV`, `TABLE_NAME` |
| `recording` | `NODE_ENV`, `TABLE_NAME`, `RECORDING_BUCKET`, `CHAT_ROOM_ARN`, `STAGE_BROADCAST_ARN` |
| `cognito-trigger` | `NODE_ENV`, `TABLE_NAME` |

API の署名Cookie発行は CloudFront Function が設定する `x-forwarded-host` を使う。値は `^[a-z0-9]+\.cloudfront\.net$` のみ許可し、違反は構造化ログを記録して内部エラーとして拒否する。CloudFront署名Resourceは `https://<host>/files/*`。

## Lambda 関数・認証

`pnpm --filter api build` は Node.js 22 / ESM で `dist/api/index.mjs`, `dist/chat-review/index.mjs`, `dist/recording/index.mjs`, `dist/cognito-trigger/index.mjs` を生成する。各ファイルは `handler` をexportする。

API Function URL は CloudFront OAC 経由で呼び、`X-Auth-Token` を Cognito access token として検証する。Cognito groupが有効なロール1つなら許可し、未所属なら `401 TOKEN_REFRESH_REQUIRED`、複数または不正なロールなら `403 INVALID_ROLE`。入力と成功レスポンスを `packages/shared` のZodスキーマで検証し、管理操作は構造化監査ログを出力する。APIエラー形式は `{ "error": { "code": string, "message": string } }`。

Cognitoトリガーは `PostConfirmation_ConfirmSignUp` で外部IdPユーザーに `viewer` を付与し、`PostAuthentication_Authentication` で最終ログイン時刻を記録する。同一Lambda内で `triggerSource` を分岐する。

## AWS API仕様確認

- IVS Real-Time の `CreateParticipantToken` は短いdurationと必要なcapabilityを指定する。`ListParticipants` は `stageArn` と `sessionId` を使い、現在の配信セッションの視聴者数を数える。
- IVS `StartComposition` のS3 destinationに StorageConfiguration ARN、EncoderConfiguration ARN、HLS `targetSegmentDurationSeconds: 10` を渡す。終了イベントは `IVS Composition State Change / Session End`。GetCompositionのS3 `recordingPrefix` に沿ってHLSプレイリストを参照する。
- S3 presigned POST は `content-length-range` と `Content-Type` を固定する。完了APIは `HeadObject` と `GetObject Range: bytes=0-4` でサイズと `%PDF-` を検査する。
- IVS Chat message review Lambda は `Content`, `ReviewResult`, `Attributes` を返す。拒否理由は `Attributes.Reason` に入れる。
- 外部IdPの初回ユーザー作成で `PostConfirmation_ConfirmSignUp` が実行されるため、ここでviewerグループを割り当てる。以降のログインは `PostAuthentication_Authentication` で最終ログインを記録する。

## Mutation test result (2026-10-19)

`pnpm --filter api mutation` was run with the configured break threshold of 80. It failed at **17.61%** (206 killed, 289 survived, 675 not covered, 446 errors among 1,616 mutants). The largest gap is route coverage: current `router.test.ts` focuses on authentication, role rejection, display-name/PDF boundaries, and device limits; other endpoint branches are not exercised by the suite and therefore generate many no-coverage mutants. Surviving mutants also include user-visible error-message string substitutions, which the current tests assert by error code rather than exact Japanese wording, and token response mutations not asserted by current tests. The API behavior is implemented, but mutation acceptance remains incomplete and needs expanded endpoint tests plus assertions for the surviving behavior.
