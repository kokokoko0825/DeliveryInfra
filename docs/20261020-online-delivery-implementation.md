# オンライン配信 実装まとめ（2026-10-20）

仕様書 `docs/spec/requirements.md`（4.8 会場スピーカーを除く）を `plan/20261019-online-delivery.md` に従って実装した。
ブランチ: `feat/online-delivery`

## 構成

| パッケージ | 中身 |
| --- | --- |
| `packages/shared` | zod による API 契約・ロール権限表・NG ワード判定・定数 |
| `apps/api` | Lambda 5本: `api`（関数URL・全エンドポイント）、`chat-review`（IVS Chat 審査）、`recording`（Composition イベント→アーカイブ登録）、`cognito-trigger`（Okta 初回 viewer 付与・最終ログイン）、`archive-expiry`（保存期限切れ録画の削除） |
| `apps/web` | Vite + React + shadcn/ui + lucide-react。全 14 画面（S-04 を除く 13 画面）とスイッチャー合成エンジン |
| `infra` | CDK 3 スタック: `edge-waf`（us-east-1 WAF 4 ルール）、`main`（東京: Cognito / DynamoDB / S3 / IVS ステージ3 / Chat / Lambda / CloudFront / CloudTrail）、`pricing-plan`（CloudFront 無料プラン） |
| `tests/integration` | API 通しフロー・Web↔API 契約・Infra↔API 整合の結合テスト |

## 動作の例

- 配信開始: 管理者が A-01 で「配信開始」→ 確認ダイアログ → `POST /api/broadcast/start` → StartComposition（720p30 / 2.5Mbps / HLS 10 秒）→ Chat イベント `broadcast-started` → 視聴者の U-01 が待機画面から番組映像に切り替わる。
- カメラ7台目: `POST /api/tokens/stage {purpose:"camera"}` は DynamoDB の条件付き書き込みで枠を確保するため、6 台が稼働中なら 409 `DEVICE_LIMIT` となり、S-01 に「上限に達しています」と表示される。
- アーカイブ: 録画完了で非公開登録（保存期限 +365 日）→ 管理者が公開 → 視聴者は `POST /api/archives/{id}/cookies` でそのアーカイブ専用の署名付き Cookie を受け取って再生する（ダウンロード不可）。

## 決定事項（仕様書の未決事項・矛盾点）

- アーカイブは管理者が確認してから公開する。Okta ユーザーは全員 viewer で入り、ロールは管理者が変更する（ユーザー回答）。
- TLS: CloudFront の既定ドメインでは TLS1.2 を強制できないため、既定ドメインのままとした（ユーザー回答）。独自ドメインを導入するときに TLSv1.2_2021 を設定する。
- その他の設計判断は `plan/20261019-online-delivery.md` 3 章と `docs/reviews/*-triage.md` に記録した。

## 品質確認

- レビューは 6 回行った。指摘数は Review-1 が 25 件、Review-2 が 5 件、Review-3 が 14 件、Review-4 が 7 件、Review-5 が 4 件、Review-6 が 0 件。全件の妥当性を判定し、すべて修正した（`docs/reviews/`）。
- テスト: shared 33 / api 187 / web 439 / infra 130 / integration 43 件。全件成功。
- ミューテーションスコア（Stryker、break 80）: api 80.14% / shared 99.26% / infra 88.36% / web core 93.04% / web media 93.84%。詳細は `docs/20261019-mutation.md`。

## 実機での確認が必要な項目

- 仕様書 8.2 の PoC（遅延 1 秒未満、11 送信の安定性、スイッチャーの処理落ち、Safari のカメラ送信、Okta 連携）
- Cognito の WriteAttributes を空にしたとき、`update-user-attributes` が拒否されること
- IVS が書き換える S3 バケットポリシーと、テンプレートの差分
- IVS Chat の 406 errorMessage の形式と、Safari の MediaError コード
