# main push による AWS デプロイ

## 動作

`main` ブランチへの push で GitHub Actions が起動し、API とWebをビルドした後、CDKの全スタックを stg 環境へデプロイします。PRや他ブランチのpushではデプロイしません。実行が重なった場合は順番に処理します。

## AWS 認証

長期アクセスキーは使わず、GitHub Actions OIDCを使います。AWS IAM ロール `DeliveryInfraGitHubActionsDeployRole` の信頼先は `kokokoko0825/DeliveryInfra` の `main` ブランチだけです。ロール自身に許可する操作は、同じAWSアカウントのCDK bootstrap用ロールを引き受ける操作に限定しています。

CDK bootstrap の CloudFormation 実行ロールは既存設定で `AdministratorAccess` を持つため、mainへpushできるユーザーはAWSインフラ変更をデプロイできます。GitHubリポジトリの書き込み権限を絞り、mainへの変更をレビューしてから反映してください。

## 対象

- `.github/workflows/deploy-stg.yml`
- `pnpm-workspace.yaml`（pnpm 11でesbuildのインストールスクリプトを許可）
- AWS IAM OIDC provider: `token.actions.githubusercontent.com`
- AWS IAM role: `DeliveryInfraGitHubActionsDeployRole`

## 検証

初回実行では旧pnpm設定形式のためインストール時に停止しました。pnpm 11の `allowBuilds` 形式へ更新し、`pnpm install --frozen-lockfile` が成功することを確認しました。更新後のmain pushでworkflowのデプロイ完了を確認します。
