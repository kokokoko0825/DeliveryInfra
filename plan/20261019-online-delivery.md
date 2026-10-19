# 限定公開ライブ配信基盤 — オンライン参加者向け配信 実装プラン

仕様書: `docs/spec/requirements.md`（原本: https://claude.ai/artifact/HWPHLGydcaXsmK2eEgE2jV 、rev77 を 2026-10-19 に取得）

## 1. 意図（なぜ必要か）

招待者だけが遅延1秒未満で視聴できる配信基盤を、サーバーレス・固定費ほぼ0円で構築する。
本プランはそのうち「オンライン参加者向けの配信」部分すべてを対象にする。

## 2. スコープ

### 対象
- 4.1 認証 / 4.2 表示名 / 4.3 配信視聴 / 4.4 コメント / 4.5 スライド
- 4.6 カメラ送信 / 4.7 マイク送信（IVS 送信のみ）/ 4.9 スライド画面共有
- 4.10 スイッチング / 4.11 録画・アーカイブ / 4.12 ユーザー管理 / 4.13 運用・デプロイ
- 5章 非機能要件、6章 構成、7章 データ項目
- 画面: C-01, C-02, C-03, U-01, U-02, U-04, S-01, S-02, S-03, A-01, A-02, A-04, A-05

### 対象外（ユーザー指示）
- 4.8 会場スピーカーモード（F-VEN-01〜12）と S-04 画面
- S-02 の「会場スピーカーへの同時送信」、A-01 の「会場に流すマイクの選択・会場スピーカー音量操作」
- 会場拡声用 SDP 交換 API

## 3. 決定事項

| 項目 | 決定 | 根拠 |
| --- | --- | --- |
| アーカイブ公開 | 録画完了時は非公開で登録、管理者が公開操作 | 8.3 未決 → ユーザー回答 |
| Okta ロール | 初回ログインで viewer 自動付与、管理者が変更。Okta グループ連携なし | 8.3 未決 → ユーザー回答 / 2章 |
| デプロイ | 検証環境(stg)へデプロイまで行う | ユーザー回答 |
| フロント | Vite + React + TypeScript + Tailwind + shadcn/ui + Lucide | ユーザー回答 |
| 構成 | pnpm monorepo: `packages/shared` / `apps/api` / `apps/web` / `infra` | KISS。型とバリデーションを shared に一本化(DRY) |
| テスト | Vitest、Testing Library、aws-sdk-client-mock、CDK assertions、StrykerJS(ミューテーション) | 依頼要件 |
| コメント履歴 | 審査 Lambda が許可したメッセージを DynamoDB に保存し、直近100件(F-CMT-06)・削除フラグ・CSV(F-CMT-07)に使う。S3 へは IVS Chat のログ機能でも保存 | IVS Chat に履歴取得 API がないため。DynamoDB は6章の構成内 |
| 送信端末の枠管理 | DynamoDB に端末レコード(条件付き書き込みで枠確保、15秒ハートビート、45秒で失効、TTL) | 7章「送信端末」/ F-CAM-06, F-MIC-05 |
| API 認証ヘッダー | `X-Auth-Token: <Cognito アクセストークン>` | OAC が `Authorization` を SigV4 署名に使うため |
| POST/PUT/PATCH/DELETE | クライアントが `x-amz-content-sha256` に本文の SHA-256(hex) を付与 | Lambda 関数URL + OAC の要件(8.2) |

## 4. アーキテクチャ

```
Browser(SPA) ─HTTPS─ CloudFront(+WAF) ─┬─ /            → S3 web bucket (OAC)
                                      ├─ /api/*       → Lambda 関数URL (OAC, AWS_IAM)
                                      └─ /files/*     → S3 content bucket (OAC + 署名付きCookie / trusted key group)
Cognito User Pool (groups: admin/camera/audio/presenter/viewer, Okta IdP 任意, SES)
IVS Real-Time: stage production / slide / broadcast（常設）, composite recording → S3 (HLS 10s)
IVS Chat: room（常設, 審査 Lambda, ログ → S3）
EventBridge: IVS Composition State Change → recording Lambda → archive 登録(非公開)
DynamoDB: 単一テーブル（オンデマンド, PITR不要, TTL）
SSM Parameter Store: CloudFront 署名用秘密鍵(SecureString)
CloudTrail: 証跡1本 → S3（1年）
```

content bucket のキー: `slides/<slideId>.pdf`, `archives/<archiveId>/...(HLS)`, `chat-logs/...`, `comment-exports/...`

## 5. API 契約（`/api/*`、JSON、エラーは `{ "error": { "code": string, "message": string } }`）

全エンドポイントでログイン必須。サーバー側でロール検証(5.3)。管理者操作は監査ログ(構造化 JSON, `audit: true`)を出す。

| メソッド パス | ロール | 説明 |
| --- | --- | --- |
| GET /api/me | 全員 | `{userId,email,role,loginMethod,displayName|null,commentSuspended}` |
| PUT /api/me/display-name | 全員 | `{displayName}` 1〜20文字、NGワード不可 |
| GET /api/broadcast | 全員 | 現在の配信 `{id,title,status:'idle'|'live'|'ended',startedAt,endedAt}` または idle |
| POST /api/broadcast/start | admin | `{title}`(1〜100) 配信レコード作成 → StartComposition → Chat イベント `broadcast-started` |
| POST /api/broadcast/stop | admin | StopComposition → 状態 ended → Chat イベント `broadcast-ended` |
| GET /api/broadcast/stats | admin | `{viewerCount}`（配信用ステージの CONNECTED subscriber 数） |
| GET /api/status | admin | ステージ3つ・Chat ルームの存在/状態(F-OPS-02) |
| POST /api/tokens/stage | 用途別 | `{purpose, deviceName?}` → `{tokens:[{stage,token,participantId,capabilities,expiresAt}], deviceId?}` |
| POST /api/devices/{deviceId}/heartbeat | 送信者 | 枠の延長 |
| DELETE /api/devices/{deviceId} | 送信者/admin | 枠の解放 |
| GET /api/devices | admin | 配信中の送信端末一覧 |
| POST /api/tokens/chat | 全員 | IVS Chat トークン。停止中ユーザーは SEND_MESSAGE なし。admin は DELETE_MESSAGE/DISCONNECT_USER |
| GET /api/comments/recent | 全員 | 直近100件（削除済み除外） |
| DELETE /api/comments/{messageId} | admin | DeleteMessage + 削除フラグ |
| PUT /api/users/{userId}/comment-suspension | admin | `{suspended:boolean}` 停止時は DisconnectUser |
| GET /api/comments/export | admin | CSV(text/csv, UTF-8 BOM) |
| GET /api/ng-words / POST /api/ng-words / DELETE /api/ng-words/{word} | admin | NGワード編集 |
| GET /api/slides | 全員 | 表示順で一覧 |
| POST /api/slides/upload-url | admin | `{title,fileName,size,contentType}` .pdf/application/pdf/≤50MB → presigned POST |
| POST /api/slides/{id}/complete | admin | S3 HEAD + 先頭 `%PDF-` 検証 → 公開。Chat イベント `slides-updated` |
| PATCH /api/slides/{id} | admin | `{title}` |
| PUT /api/slides/order | admin | `{ids:string[]}` |
| DELETE /api/slides/{id} | admin | S3 削除 + Chat イベント `slides-updated` |
| GET /api/archives | 全員 | viewer 等は公開のみ、admin は全件 |
| PATCH /api/archives/{id} | admin | `{title?,published?,retainUntil?}`（保存期限延長、5.5。期限到来で DynamoDB TTL→Stream→録画削除） |
| DELETE /api/archives/{id} | admin | S3 プレフィックス削除 |
| POST /api/files/cookies | 全員 | スライド用 署名付きCookie（Resource `/files/slides/*`、Cookie Path `/files/slides/`、有効1時間） |
| POST /api/archives/{id}/cookies | 全員 | 当該アーカイブ用 署名付きCookie（Resource `/files/archives/<prefix>/*`、Path 同じ）。非公開は admin のみ（Review-1 R1-08） |
| GET /api/users | admin | `{userId,email,loginMethod,role,enabled,lastLoginAt}` |
| POST /api/users/invite | admin | `{emails:string[](1〜100), role}` AdminCreateUser(仮パスワードメール) |
| PUT /api/users/{userId}/role | admin | `{role}` |
| POST /api/users/{userId}/disable / enable | admin | 無効化時 AdminUserGlobalSignOut |
| DELETE /api/users/{userId} | admin | |

### ステージトークンの用途 (`purpose`)

| purpose | ロール | 付与 | 上限 |
| --- | --- | --- | --- |
| viewer | 全員 | broadcast: SUBSCRIBE | — |
| camera | camera, admin | production: PUBLISH（attributes `{kind:'camera',deviceName}`） | 6 |
| mic | audio, admin | production: PUBLISH（`{kind:'mic',deviceName}`） | 5 |
| slide | presenter, admin | slide: PUBLISH（`{kind:'slide',deviceName:'SLIDE'}`） | 1 |
| switcher | admin | production+slide: SUBSCRIBE, broadcast: PUBLISH | 枠管理なし（Review-1 R1-02） |

`deviceName` は `^(CAM|MIC)[1-9]$` 形式を推奨入力（1〜16文字、英数字と -）。トークン有効期限は短く（参加用 10 分程度、再接続時は再発行）。
上限超過は 409 `{code:'DEVICE_LIMIT'}`。

### Chat
- ルーム1つ常設。メッセージ属性 `{displayName}`。審査 Lambda: 本文1〜200文字、NGワード、送信者の3秒連投制限、停止フラグ → DENY。許可時に DynamoDB へ保存。
- カスタムイベント: `broadcast-started`, `broadcast-ended`, `slides-updated`, `archives-updated`。

## 6. フロント

- ルーティング: `/login`, `/password`, `/display-name`, `/watch`(U-01), `/slides`(U-02), `/archives`, `/archives/:id`(U-04), `/send/camera`(S-01), `/send/mic`(S-02), `/send/slide`(S-03), `/admin/switcher`(A-01), `/admin/slides`(A-02), `/admin/comments`(A-04), `/admin/users`(A-05)
- 管理者画面はユーザー画面と同じレイアウト + 管理メニュー(3章)
- shadcn/ui のコンポーネントを組み合わせて構成。アイコンは lucide-react のみ
- Apple HIG: 明確な階層、44pt 以上のタップ領域、システムフォント、余白、控えめなモーション、ダークモード対応、`prefers-reduced-motion` 尊重
- 色 70:25:5: 70% = 背景(neutral), 25% = 面・テキスト・境界(neutral の濃淡), 5% = アクセント1色(主要アクションと LIVE 表示)。破壊的操作の赤は shadcn `destructive` のみ。CSS 変数でのみ指定し、任意の色クラス直書き禁止
- 日本語のみ。コメント・表示名は React の通常描画でエスケープ(`dangerouslySetInnerHTML` 禁止)

## 7. 作業分割（Orca Orchestrator）

| Wave | Task | Agent | 所有範囲 |
| --- | --- | --- | --- |
| 0 | 土台: monorepo, shared(型・zod・ロール・定数), web 骨組み(shadcn, ルーター, 全画面プレースホルダー, デザイントークン), Stryker/Vitest 設定 | codex | ルート設定, packages/shared, apps/web 骨組み |
| 1 | API(Lambda 全関数) | codex | apps/api |
| 1 | インフラ(CDK) | codex | infra |
| 1 | Web: 共通/認証/視聴者/管理(A-02,04,05) | claude | apps/web(features/sender, features/switcher 以外) |
| 1 | Web: 送信(S-01..03) + スイッチング(A-01) | claude | apps/web/src/features/{sender,switcher}, apps/web/src/lib/ivs |
| 2 | 結合テスト(API ルーター通し、Web↔API 契約、CDK↔API 環境変数) | codex | tests/integration |
| 3+ | レビュー → 妥当性判断 → 修正 → 再レビュー（指摘ゼロまで）| codex/claude 交差 | — |
| 最後 | stg デプロイ | coordinator | — |

選択理由: 契約(本書5章)と型(shared)を先に固定し、ディレクトリ単位で所有を分けることで並列編集の衝突を避ける。レビューは実装と別エージェントに担当させ、見落としの偏りを減らす。

## 8. 受け入れ基準
- `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` が通る
- 各パッケージで Stryker を実行し、バリデーション・認可・枠管理・合成ロジックなど中核モジュールのミューテーションスコア 80% 以上。生き残った変異体は理由を記録
- バリデーションテスト: shared の全 zod スキーマ、API の境界値(0/1/20/21文字、50MB±1、拡張子・MIME 不一致、不正ロール)
- `pnpm --filter infra cdk synth` が成功
- 秘密情報はハードコードしない(`.env` / SSM)
