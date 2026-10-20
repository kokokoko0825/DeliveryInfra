# Venue speaker signaling 回帰テスト

## 変更

- `apps/api/src/router.test.ts` に venue signaling の role 拒否、PUT 以外の method 拒否、offer/answer と SDP の検証、90 秒 TTL、期限切れ signal、反対側 signal の取得、削除 ownership を追加。
- `apps/web/src/features/venue/venueAudio.test.ts` に AudioWorklet が same-origin の外部 URL から読み込まれ `blob:` / `data:` URL を使わないこと、mic と speaker の WebRTC 接続・失敗状態を追加。
- `infra/test/edge.test.ts` で CSP の `script-src` に `blob:` と `data:` が含まれないことを明示。
- CSP による起動失敗を直すため、AudioWorklet を `blob:` URL から同一オリジンの静的ファイルに切り替えた。既存の `script-src` 設定は維持。
- `.github/workflows/deploy-stg.yml` に PoC の web/API 回帰テストと infra テストを加え、いずれかが失敗したら stg deploy を止める。

## テスト結果

| コマンド | 結果 |
| --- | --- |
| `pnpm --filter api exec vitest run src/router.test.ts` | PASS、146 tests |
| `pnpm --filter web exec vitest run src/features/venue/venueAudio.test.ts` | PASS、3 tests |
| `pnpm --filter infra exec vitest run test/edge.test.ts` | PASS、21 tests |
| `pnpm --filter infra test` | PASS、136 tests |
| `pnpm --filter web lint && pnpm --filter web typecheck && pnpm --filter web build` | PASS。worklet は独立した `venue-pcm.worklet-<hash>.js` として出力 |
| `pnpm --filter api typecheck && pnpm --filter api build` | PASS |
| `pnpm --filter web test` | 443件中440件 PASS。既存 CameraSendPage の3件が失敗し、PoC の venueAudio.test.ts は PASS |

## Stryker / mutation checks

| コマンド | 結果 |
| --- | --- |
| `pnpm --filter api exec stryker run --mutate src/router.ts --ignoreStatic` | 1,790 mutants: killed 1,051、survived 260、timeout 7、no coverage 16、errors 456。Mutation score 79.31%、break threshold 80% 未満のため exit 1。レポート: `apps/api/reports/mutation/mutation.json` |
| `pnpm --filter web exec stryker run stryker.venue.tmp.json` | venueAudio.ts 199 mutants: killed 38、survived 52、timeout 4、no coverage 103、errors 0。テンポラリ設定 `vitest.dir=src/features/venue` で追加した3 testsだけを実行。 |
| `pnpm --filter infra exec stryker run stryker.config.json --mutate src/edge.ts` | 111 mutants: killed 82、survived 8、timeout 11、no coverage 0、errors 10。Mutation score 92.08%、exit 0。 |

API の Stryker 実行では router.ts 全体を対象にしたため、全体スコアは break threshold 80% を下回った。JSON report を確認し、venue signal ルート内の取得先、consistent read、TTL 応答、削除対象なし、offer/answer エラー内容に対応するテストを追加した。追加後の API テストは PASS。さらに音声ロールの認可条件を一時的に常に許可する変異を入れたところ、権限拒否の3ケースが失敗し、元の条件に戻した。追加 assertion 後に API 全体の Stryker は再実行していない。

web の Stryker は既存の `stryker.core.config.json` だと関連テストの dry run で既存 `CameraSendPage` テストが失敗した。venueAudio 専用の一時設定で3件の対象テストに絞って実行し、テスト本体は PASS。survivors 52 件と no-coverage 103 件には venue 音声の未テスト分岐も含む。

AudioWorklet の URL を `?raw` に変える一時変異を入れると、外部 same-origin URL を要求するテストが失敗することも確認し、元の `?url&no-inline` に戻した。Vite production build では `venue-pcm.worklet-<hash>.js` が独立ファイルとして出力された。

## 環境

リポジトリと親階層に `CLAUDE.md` は見つからなかった。
