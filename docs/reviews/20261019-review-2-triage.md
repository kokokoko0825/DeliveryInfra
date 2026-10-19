# Review-2 トリアージ（coordinator 判定）

判定: 5件すべて妥当。Review-1 の25件と INT-01 は修正済みと確認された。

| ID | 判定 | 修正方針 |
| --- | --- | --- |
| R2-01 | 妥当 | DisconnectParticipant 失敗時は旧枠レコードを条件付きで復元（新規取得を上書きしない条件付き）し、新枠を取り消す |
| R2-02 | 妥当 | グループ付与失敗時は作成ユーザーを AdminDeleteUser で補償。補償も失敗したら reason=CREATED_WITHOUT_ROLE を返し監査ログ |
| R2-03 | 妥当 | ended 済みでも broadcast-ended を再送する冪等処理（stop・recording とも）。クライアントは重複イベントを許容 |
| R2-04 | 妥当 | 一覧の role を nullable にし、不正/複数ロールは null（画面に「ロール要修復」表示とロール変更導線） |
| R2-05 | 妥当 | Slider ルートに 44px の操作領域 |

INT-02（GSI 未定義）は修正前コードに基づく誤検知の可能性が高く、結合テスト再実行で確認する。
