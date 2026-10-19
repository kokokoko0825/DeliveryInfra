# Review-1 トリアージ（coordinator 判定）

判定: 25件すべて妥当（コードと AWS ドキュメントで裏付けあり）。全件修正する。

| ID | 判定 | 修正方針 | 担当 |
| --- | --- | --- | --- |
| R1-01 | 妥当 | email / loginMethod は AdminGetUser（または cognito トリガーで保存した PROFILE）から取得 | Fix-API |
| R1-02 | 妥当 | switcher は端末枠を使わない（STAGE_LIMITS から削除済み）。Web は1回の応答の3トークンを使い、再接続時のみ取り直す | Fix-API / Fix-Web |
| R1-03 | 妥当 | stop で ResourceNotFound を許容し ended へ。recording で Session End/Failure 受信時に一致する配信を ended + broadcast-ended | Fix-API |
| R1-04 | 妥当 | 審査 Lambda はクライアント属性を破棄し PROFILE の表示名で上書き。Web は sender.attributes / 審査済み属性のみ使用 | Fix-API / Fix-Web |
| R1-05 | 妥当 | /files/slides/* は frame-ancestors 'self' / X-Frame-Options SAMEORIGIN | Fix-Infra |
| R1-06 | 妥当 | ivs:ListStageSessions 等、/api/status に必要な権限を付与し、例外の握りつぶしをやめる | Fix-Infra / Fix-API |
| R1-07 | 妥当 | 失効した端末の participantId を DisconnectParticipant してから枠を再利用 | Fix-API |
| R1-08 | 妥当 | Cookie をパス別に分割（スライド / アーカイブ毎）。plan 5章を更新済み | Fix-API / Fix-Web |
| R1-09 | 妥当 | ロール変更・無効化時に GlobalSignOut + ユーザー毎の tokenValidAfter を保存し、iat が古いトークンを 401 TOKEN_REFRESH_REQUIRED | Fix-API |
| R1-10 | 妥当 | Scan をやめ、PK 単位の Query になるキー設計に変更（GSI 追加も可） | Fix-API / Fix-Infra |
| R1-11 | 妥当 | 一括招待は部分成功を返す（invited / failed[{email,reason}]） | Fix-API（shared 追加） |
| R1-12 | 妥当 | auth テストを実際のアクセストークンのクレームに | Fix-API |
| R1-13 | 妥当 | レート制限を /api/* に限定し上限を引き上げ（NAT 配下数百人を想定） | Fix-Infra |
| R1-14 | 妥当 | ConditionalCheckFailed → 404/409 | Fix-API |
| R1-15 | 妥当 | CSV にメッセージID・削除フラグ、先頭 \t \r も無害化 | Fix-API |
| R1-16 | 妥当 | CommentSchema に trim・制御文字禁止（shared 修正済み） | 済 |
| R1-17 | 妥当 | 再接続時は releaseDevice 完了後に再取得 | Fix-Web |
| R1-18 | 妥当 | 稼働中の同名端末は 409 DEVICE_NAME_IN_USE | Fix-API |
| R1-19 | 妥当 | 自分自身の無効化・削除・降格をサーバーで拒否 | Fix-API |
| R1-20 | 妥当 | PostConfirmation 外部プロバイダでも LOGIN を記録 | Fix-API |
| R1-21 | 妥当 | recording に ivs:GetComposition | Fix-Infra |
| R1-22 | 妥当 | 録画バケットのライフサイクル削除をやめ、Archive.retainUntil（初期 +365日、admin が延長）→ DynamoDB TTL → Stream → 録画削除 | Fix-API / Fix-Infra / Fix-Web |
| R1-23 | 妥当 | Verifier をモジュールスコープで生成 | Fix-API |
| R1-24 | 妥当 | ListUsersInGroup（5グループ）＋ BatchGet で N+1 解消 | Fix-API |
| R1-25 | 妥当 | 未使用コード削除 | 各担当 |
