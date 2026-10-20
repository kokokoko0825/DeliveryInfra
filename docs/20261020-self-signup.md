# ユーザー自己登録

## 変更内容

- Cognito User Pool の自己登録を有効化。
- `/signup` にメールアドレスとパスワードの登録画面を追加。確認コードをメールで送り、確認完了後にログイン画面へ戻す。
- 登録直後の権限はサーバー側の Cognito PostConfirmation トリガーで `viewer` に固定。ユーザー入力からロールを選べない。
- ログイン画面にユーザー登録へのリンクを追加。

## 意図と選択理由

ユーザー自身で登録できるようにしつつ、メール確認前のアカウント利用を防ぐ。権限昇格を防ぐため、新規登録者には最小権限の `viewer` をサーバー側で付与する。既存の招待アカウントは従来どおり管理者設定のロールを使う。

## 確認

- `pnpm --filter web typecheck`
- `pnpm --filter api typecheck`
- `pnpm --filter infra typecheck`
- `git diff --check`

## 運用

2026-10-20 に stg (`https://d9fhvrzkwxgi4.cloudfront.net`) へデプロイ済み。ユーザーは `/signup` で登録し、メールの確認コードを入力してからログインする。CloudFormation は `UPDATE_COMPLETE`、Cognito は自己登録有効 (`AllowAdminCreateUserOnly=false`) を確認した。CloudFront から配信された JS に登録 UI の文言も含まれることを確認した。
